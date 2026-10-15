// DocReader auto-upload — a feature of this fork (joesaas/answer-me-with-html).
//
// After `am render` writes a page, the page is uploaded to the user's DocReader
// server (Agent 101) through the AI API that joesaas/doc-reader exposes
// (POST /api/ai/docs — see that repo's docs/AI_API.md).
//
// The core stays runtime-agnostic: it knows the DocReader API, but it does NOT
// know where credentials live. Credentials come from a pluggable adapter, so the
// same skill works in Muse, Gemini, Grok Bot, or any other agent container:
//
//   1. Built-in env adapter: DOC_READER_API_KEY is sent as the X-API-Key header.
//   2. External adapter: an executable that prints the auth headers as JSON.
//      Found via AM_DOCREADER_ADAPTER, or at $AM_HOME/adapters/docreader.
//      Protocol (see skills/answer-me-with-html/adapters/README.md):
//        stdin:  {"base": "https://agent101.uk", "host": "agent101.uk"}
//        stdout: {"headers": {"X-API-Key": "..."}}  — or {"skip": "reason"}
//      An adapter for Muse ships in adapters/muse.py (it returns the
//      custom.agent101 connector surrogate; Sentinel swaps in the real key).
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

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export const docReaderBase = (env) => String(env.DOC_READER_BASE || 'https://agent101.uk').replace(/\/+$/, '');

export const normalizeCategory = (value) => (DOCREADER_CATEGORIES.includes(value) ? value : 'other');

export function docReaderUploadEnabled(opts, env, configValues) {
  if (opts['no-upload']) return false;
  if (opts.upload) return true;
  const raw = env.AM_DOCREADER_UPLOAD;
  if (raw !== undefined && raw !== '') return !['0', 'off', 'false', 'no'].includes(String(raw).trim().toLowerCase());
  return configValues?.docreader_upload !== false;
}

// The data directory, resolved from the injected env only (AM_HOME, else
// $HOME/.answer-me-with-html), so a synthetic test env stays inert.
export function docReaderHome(env) {
  if (env.AM_HOME) return env.AM_HOME;
  return env.HOME ? join(env.HOME, '.answer-me-with-html') : null;
}

// The external credential adapter: AM_DOCREADER_ADAPTER wins; otherwise the
// conventional $AM_HOME/adapters/docreader when that file exists.
export function findDocReaderAdapter(env) {
  if (env.AM_DOCREADER_ADAPTER) return env.AM_DOCREADER_ADAPTER;
  const home = docReaderHome(env);
  if (!home) return null;
  const candidate = join(home, 'adapters', 'docreader');
  return existsSync(candidate) ? candidate : null;
}

// Runs the adapter and returns { headers } or { skip }. Throws on a broken
// adapter (non-zero exit, bad JSON, no usable header) so the failure is
// reported instead of silently sending an unauthenticated request.
export function runDocReaderAdapter(adapter, env, base) {
  const host = new URL(base).hostname;
  const run = spawnSync(adapter, [], {
    input: JSON.stringify({ base, host }),
    encoding: 'utf8',
    timeout: 15_000,
    env,
  });
  if (run.error) throw new Error(`cannot run the DocReader adapter ${adapter}: ${run.error.message}`);
  if (run.status !== 0) {
    throw new Error(`DocReader adapter ${adapter} failed: ${(run.stderr || '').trim().slice(-300) || `exit ${run.status}`}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(String(run.stdout).trim());
  } catch {
    throw new Error(`DocReader adapter ${adapter} did not print a JSON object`);
  }
  if (parsed?.skip) return { skip: String(parsed.skip) };
  const headers = parsed?.headers;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error(`DocReader adapter ${adapter} printed no "headers" object`);
  }
  const entries = Object.entries(headers).filter(([k, v]) => HEADER_NAME.test(k) && typeof v === 'string' && v !== '');
  if (!entries.length) throw new Error(`DocReader adapter ${adapter} returned no usable header`);
  return { headers: Object.fromEntries(entries) };
}

// Where the auth headers come from: the env key, an external adapter, or
// nothing ({ skip }) when this environment provides no credential at all.
export function resolveDocReaderAuth(env, base) {
  const key = env.DOC_READER_API_KEY;
  if (key) return { headers: { 'X-API-Key': key }, via: 'env' };
  const adapter = findDocReaderAdapter(env);
  if (adapter) {
    const r = runDocReaderAdapter(adapter, env, base);
    if (r.skip) return { skip: r.skip };
    return { headers: r.headers, via: 'adapter' };
  }
  return { skip: 'no DOC_READER_API_KEY in the environment and no DocReader adapter found (AM_DOCREADER_ADAPTER or $AM_HOME/adapters/docreader)' };
}

// Uploads one rendered page. Returns { status, id, url, via } on success,
// { skipped: reason } when no credential is configured, and throws on a real
// failure (the caller reports it and keeps the render result).
export async function uploadToDocReader({ html, title, category, externalId }, env, fetchImpl = fetch) {
  const base = docReaderBase(env);
  const auth = resolveDocReaderAuth(env, base);
  if (auth.skip) return { skipped: auth.skip };
  const payload = { title, html, category };
  if (externalId) payload.externalId = externalId;
  let res;
  try {
    res = await fetchImpl(`${base}/api/ai/docs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA, ...auth.headers },
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
  return { status: body.status ?? 'created', id, url: `${base}/#/doc/${id}`, via: auth.via };
}
