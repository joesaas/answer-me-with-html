import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  uploadToDocReader, docReaderUploadEnabled, normalizeCategory,
  findDocReaderAdapter, runDocReaderAdapter,
} from '../src/docreader.js';
import { main } from '../src/cli.js';

// A local stub of the DocReader AI API. Records the last request; the key it
// accepts is configurable so env-key and adapter-key paths are both exercised.
let server, base, lastReq;
const ACCEPTED = new Set(['test-key', 'adapter-key']);

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      lastReq = { url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') };
      if (!ACCEPTED.has(req.headers['x-api-key'])) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'created', doc: { id: 'abc123-456' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function writeAdapter(dir, name, source) {
  const path = join(dir, name);
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

// An adapter that checks the protocol stdin (base + host must be present) and
// answers with the adapter key. Exits 3 if the core's stdin contract breaks.
const GOOD_ADAPTER = `#!/usr/bin/env node
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const ctx = JSON.parse(raw);
  if (!ctx.base || !ctx.host) process.exit(3);
  process.stdout.write(JSON.stringify({ headers: { 'X-API-Key': 'adapter-key' } }));
});
`;

test('the switch resolves flags first, then the env var, then the config value', () => {
  assert.equal(docReaderUploadEnabled({}, {}, { docreader_upload: true }), true);
  assert.equal(docReaderUploadEnabled({}, {}, { docreader_upload: false }), false);
  assert.equal(docReaderUploadEnabled({}, {}, {}), true); // default on
  assert.equal(docReaderUploadEnabled({ 'no-upload': true }, {}, { docreader_upload: true }), false);
  assert.equal(docReaderUploadEnabled({ upload: true }, {}, { docreader_upload: false }), true);
  assert.equal(docReaderUploadEnabled({}, { AM_DOCREADER_UPLOAD: '0' }, { docreader_upload: true }), false);
  assert.equal(docReaderUploadEnabled({}, { AM_DOCREADER_UPLOAD: 'yes' }, { docreader_upload: false }), true);
});

test('unknown categories fall back to other, the eight known ones pass through', () => {
  assert.equal(normalizeCategory('agent'), 'agent');
  assert.equal(normalizeCategory('nonsense'), 'other');
  assert.equal(normalizeCategory(undefined), 'other');
});

test('with an env key the page POSTs to /api/ai/docs with that key', async () => {
  const r = await uploadToDocReader(
    { html: '<p>hi</p>', title: 'T', category: 'agent', externalId: 'ext-1' },
    { DOC_READER_BASE: base, DOC_READER_API_KEY: 'test-key', HOME: '/nonexistent' },
  );
  assert.equal(r.status, 'created');
  assert.equal(r.id, 'abc123-456');
  assert.equal(r.url, `${base}/#/doc/abc123-456`);
  assert.equal(r.via, 'env');
  assert.equal(lastReq.url, '/api/ai/docs');
  assert.equal(lastReq.headers['x-api-key'], 'test-key');
  assert.match(lastReq.headers['user-agent'], /Mozilla/); // Cloudflare rejects script UAs
  assert.deepEqual(lastReq.body, { title: 'T', html: '<p>hi</p>', category: 'agent', externalId: 'ext-1' });
});

test('with no key and no adapter anywhere the upload is a skip, not an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'am-'));
  try {
    const r = await uploadToDocReader(
      { html: '<p>x</p>', title: 'T', category: 'other' },
      { DOC_READER_BASE: base, HOME: dir, AM_HOME: dir },
    );
    assert.match(r.skipped, /no DOC_READER_API_KEY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adapter discovery: the env var wins, then $AM_HOME/adapters/docreader', () => {
    const dir = mkdtempSync(join(tmpdir(), 'am-'));
    try {
      assert.equal(findDocReaderAdapter({ AM_DOCREADER_ADAPTER: '/x/y', AM_HOME: dir }), '/x/y');
      assert.equal(findDocReaderAdapter({ AM_HOME: dir, HOME: dir }), null);
      mkdirSync(join(dir, 'adapters'), { recursive: true });
      writeAdapter(dir, 'adapters/docreader', GOOD_ADAPTER);
      assert.equal(findDocReaderAdapter({ AM_HOME: dir, HOME: dir }), join(dir, 'adapters', 'docreader'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an adapter supplies the auth headers and the core performs the upload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'am-'));
    try {
      const adapter = writeAdapter(dir, 'adapter.mjs', GOOD_ADAPTER);
      const r = await uploadToDocReader(
        { html: '<p>via adapter</p>', title: 'A', category: 'other' },
        { DOC_READER_BASE: base, HOME: dir, AM_HOME: dir, AM_DOCREADER_ADAPTER: adapter },
      );
      assert.equal(r.status, 'created');
      assert.equal(r.via, 'adapter');
      assert.equal(lastReq.headers['x-api-key'], 'adapter-key');
      assert.equal(lastReq.body.html, '<p>via adapter</p>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an adapter may answer skip, and a broken adapter fails loudly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'am-'));
    try {
      const skipper = writeAdapter(dir, 'skip.mjs', '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ skip: "not in this runtime" }));\n');
      const r = await uploadToDocReader(
        { html: '<p>x</p>', title: 'T', category: 'other' },
        { DOC_READER_BASE: base, AM_DOCREADER_ADAPTER: skipper },
      );
      assert.equal(r.skipped, 'not in this runtime');

      const broken = writeAdapter(dir, 'broken.mjs', '#!/usr/bin/env node\nprocess.stderr.write("boom");\nprocess.exit(1);\n');
      await assert.rejects(
        uploadToDocReader({ html: '<p>x</p>', title: 'T', category: 'other' }, { DOC_READER_BASE: base, AM_DOCREADER_ADAPTER: broken }),
        /adapter .* failed: boom/,
      );

      const silent = writeAdapter(dir, 'silent.mjs', '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ headers: {} }));\n');
      assert.throws(() => runDocReaderAdapter(silent, {}, base), /no usable header/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

// --- CLI level: render performs the upload with both credential sources -----

function capture() {
  let buf = '';
  const stream = new Writable({ write(chunk, _enc, cb) { buf += chunk; cb(); } });
  return { stream, text: () => buf };
}
const draft = (extra = '') => `${extra}# 标题\n\n正文一段。\n`;

async function renderWith(env, extra = '') {
  const out = capture();
  const err = capture();
  const args = ['render', '-'];
  const rc = await main(args, {
    stdin: Readable.from([draft(extra)]),
    stdout: out.stream, stderr: err.stream,
    env: { ...env },
  });
  return { rc, out: out.text(), err: err.text() };
}

test('render uploads with the env key by default and prints the reading URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'am-'));
  try {
    const r = await renderWith({
      HOME: dir, AM_HOME: dir, DOC_READER_BASE: base, DOC_READER_API_KEY: 'test-key',
    }, '---\ncategory: defi\nexternal_id: page-1\n---\n');
    assert.equal(r.rc, 0);
    assert.match(r.out, /DocReader: created → /);
    assert.equal(lastReq.body.category, 'defi');
    assert.equal(lastReq.body.externalId, 'page-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('render uploads through a discovered adapter when there is no env key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'am-'));
  try {
    mkdirSync(join(dir, 'adapters'), { recursive: true });
    writeAdapter(dir, 'adapters/docreader', GOOD_ADAPTER);
    const r = await renderWith({ HOME: dir, AM_HOME: dir, DOC_READER_BASE: base });
    assert.equal(r.rc, 0);
    assert.match(r.out, /DocReader: created → /);
    assert.equal(lastReq.headers['x-api-key'], 'adapter-key');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--no-upload skips the upload, and an upload failure never fails the render', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'am-'));
  try {
    const off = await renderWith({ HOME: dir, AM_HOME: dir, DOC_READER_BASE: base, DOC_READER_API_KEY: 'test-key' });
    // (control: default run does upload)
    assert.match(off.out, /DocReader: created/);
    const out = capture(); const err = capture();
    const rc = await main(['render', '-', '--no-upload'], {
      stdin: Readable.from([draft()]), stdout: out.stream, stderr: err.stream,
      env: { HOME: dir, AM_HOME: dir, DOC_READER_BASE: base, DOC_READER_API_KEY: 'test-key' },
    });
    assert.equal(rc, 0);
    assert.doesNotMatch(out.text(), /DocReader:/);

    const bad = await renderWith({ HOME: dir, AM_HOME: dir, DOC_READER_BASE: base, DOC_READER_API_KEY: 'wrong-key' });
    assert.equal(bad.rc, 0); // the page rendered; only the upload failed
    assert.match(bad.err, /✗ DocReader upload failed \(the page itself is fine\): HTTP 401/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
