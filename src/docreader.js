// DocReader auto-upload — a feature of this fork (joesaas/answer-me-with-html).
//
// After `am render` writes a page, the page is uploaded to the user's DocReader
// server (Agent 101) through the AI API that joesaas/doc-reader exposes
// (POST /api/ai/docs — see that repo's docs/AI_API.md). It is the same call the
// doc-reader-upload skill's upload_doc.py makes.
//
// Credentials, in order:
//   1. DOC_READER_API_KEY env — sent as the X-API-Key header directly.
//   2. The doc-reader-upload CLI, which does its own credential handling (in
//      Muse it attaches the custom.agent101 connector surrogate; the real key
//      never appears here). Found via DOC_READER_UPLOAD_CLI, or at
//      $HOME/workspace/skills/doc-reader-upload/bin/upload_doc.py.
// With neither, the upload is skipped and the render still succeeds.
//
// Switches: `am config set docreader_upload off`, AM_DOCREADER_UPLOAD=0, or
// --no-upload for one run; --upload forces one run even when the config is off.
// Target: DOC_READER_BASE (default https://agent101.uk). Category: --category,
// the draft's `category:` frontmatter, DOC_READER_CATEGORY, else "other".
// A stable external id (frontmatter `external_id:` or --external-id) makes a
// re-render replace the same document instead of creating a new one.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const DOCREADER_CATEGORIES = Object.freeze([
  'agent', 'defi', 'blockchain', 'protocol', 'security', 'network', 'engineering', 'other',
]);

// Cloudflare in front of the DocReader server 403s non-browser user agents
// (verified 2026-10-10: python-urllib's default UA was rejected), so send a browser UA.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export const docReaderBase = (env) => String(env.DOC_READER_BASE || 'https://agent101.uk').replace(/\/+$/, '');

export const normalizeCategory = (value) => (DOCREADER_CATEGORIES.includes(value) ? value : 'other');

export function docReaderUploadEnabled(opts, env, configValues) {
  if (opts['no-upload']) return false;
  if (opts.upload) return true;
  const raw = env.AM_DOCREADER_UPLOAD;
  if (raw !== undefined && raw !== '') return !['0', 'off', 'false', 'no'].includes(String(raw).trim().toLowerCase());
  return configValues?.docreader_upload !== false;
}

// The doc-reader-upload CLI next to the user's other skills. Only env.HOME is
// consulted (never the real process home), so an injected test env stays inert.
export function findUploadCli(env) {
  const candidates = [env.DOC_READER_UPLOAD_CLI];
  if (env.HOME) candidates.push(join(env.HOME, 'workspace', 'skills', 'doc-reader-upload', 'bin', 'upload_doc.py'));
  return candidates.filter(Boolean).find((p) => existsSync(p)) ?? null;
}

// Uploads one rendered page. Returns { status, id, url, via } on success,
// { skipped: reason } when no credential path is configured, and throws on a
// real failure (the caller reports it and keeps the render result).
export async function uploadToDocReader({ html, file, title, category, externalId }, env, fetchImpl = fetch) {
  const base = docReaderBase(env);
  const key = env.DOC_READER_API_KEY;
  if (key) {
    const payload = { title, html, category };
    if (externalId) payload.externalId = externalId;
    let res;
    try {
      res = await fetchImpl(`${base}/api/ai/docs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA, 'X-API-Key': key },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new Error(`cannot reach ${base}: ${e.message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`unexpected reply from ${base}: ${text.slice(0, 200)}`);
    }
    const id = body?.doc?.id;
    if (!id) throw new Error(`the reply from ${base} carries no doc id`);
    return { status: body.status ?? 'created', id, url: `${base}/#/doc/${id}`, via: 'api' };
  }
  const cli = findUploadCli(env);
  if (cli) {
    const args = [cli, '--title', title, '--category', category, '--html-file', file, '--yes'];
    if (externalId) args.push('--external-id', externalId);
    const run = spawnSync('python3', args, { encoding: 'utf8', timeout: 60_000, env });
    if (run.error) throw new Error(`cannot run the doc-reader-upload CLI: ${run.error.message}`);
    if (run.status !== 0) throw new Error(`doc-reader-upload CLI failed: ${(run.stderr || run.stdout || '').trim().slice(-300)}`);
    let parsed = null;
    try {
      parsed = JSON.parse(String(run.stdout).match(/\{[\s\S]*\}/)?.[0] ?? '');
    } catch {
      parsed = null;
    }
    if (!parsed?.id) throw new Error('the doc-reader-upload CLI finished without a doc id');
    return { status: parsed.status ?? 'created', id: parsed.id, url: parsed.read ?? `${base}/#/doc/${parsed.id}`, via: 'cli' };
  }
  return { skipped: 'no DOC_READER_API_KEY in the environment and no doc-reader-upload CLI found' };
}
