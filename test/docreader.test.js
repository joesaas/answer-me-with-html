import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Readable, Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadToDocReader, docReaderUploadEnabled, normalizeCategory, findUploadCli } from '../src/docreader.js';
import { main } from '../src/cli.js';

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'am-docreader-')); });
after(() => rmSync(dir, { recursive: true, force: true }));

// A stub DocReader server: records the last request, replies like the real AI API.
function stubServer(reply) {
  const seen = {};
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.method = req.method;
      seen.url = req.url;
      seen.headers = req.headers;
      seen.body = body;
      const { status, json } = reply;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

test('docreader: enable switches — config default on, --no-upload / env / config off win, --upload forces', () => {
  assert.equal(docReaderUploadEnabled({}, {}, {}), true);
  assert.equal(docReaderUploadEnabled({}, {}, { docreader_upload: false }), false);
  assert.equal(docReaderUploadEnabled({ upload: true }, {}, { docreader_upload: false }), true);
  assert.equal(docReaderUploadEnabled({ 'no-upload': true }, {}, {}), false);
  assert.equal(docReaderUploadEnabled({ upload: true, 'no-upload': true }, {}, {}), false);
  assert.equal(docReaderUploadEnabled({}, { AM_DOCREADER_UPLOAD: '0' }, {}), false);
  assert.equal(docReaderUploadEnabled({}, { AM_DOCREADER_UPLOAD: '1' }, { docreader_upload: false }), true);
});

test('docreader: category falls back to other for unknown names', () => {
  assert.equal(normalizeCategory('agent'), 'agent');
  assert.equal(normalizeCategory('nonsense'), 'other');
  assert.equal(normalizeCategory(undefined), 'other');
});

test('docreader: no key and no CLI is a skip, not an error', async () => {
  const r = await uploadToDocReader(
    { html: '<p>x</p>', file: join(dir, 'x.html'), title: 'T', category: 'other' },
    { HOME: dir },
  );
  assert.match(r.skipped, /DOC_READER_API_KEY/);
  assert.equal(findUploadCli({ HOME: dir }), null);
});

test('docreader: API key path posts the AI API shape and returns the read URL', async () => {
  const { server, seen, base } = await stubServer({ status: 201, json: { status: 'created', doc: { id: 'abc123', title: 'T', category: 'agent' } } });
  try {
    const r = await uploadToDocReader(
      { html: '<p>hi</p>', file: join(dir, 'x.html'), title: 'T', category: 'agent', externalId: 'my-id' },
      { DOC_READER_BASE: base, DOC_READER_API_KEY: 'test-key', HOME: dir },
    );
    assert.equal(r.status, 'created');
    assert.equal(r.via, 'api');
    assert.equal(r.url, `${base}/#/doc/abc123`);
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/api/ai/docs');
    assert.equal(seen.headers['x-api-key'], 'test-key');
    assert.match(seen.headers['user-agent'], /Mozilla\/5\.0/);
    assert.deepEqual(JSON.parse(seen.body), { title: 'T', html: '<p>hi</p>', category: 'agent', externalId: 'my-id' });
  } finally {
    server.close();
  }
});

test('docreader: an HTTP error from the server throws with the status', async () => {
  const { server, base } = await stubServer({ status: 401, json: { error: 'invalid api key' } });
  try {
    await assert.rejects(
      uploadToDocReader(
        { html: '<p>hi</p>', file: join(dir, 'x.html'), title: 'T', category: 'other' },
        { DOC_READER_BASE: base, DOC_READER_API_KEY: 'bad', HOME: dir },
      ),
      /HTTP 401/,
    );
  } finally {
    server.close();
  }
});

function sink() {
  let text = '';
  const stream = new Writable({ write(chunk, _enc, cb) { text += chunk; cb(); } });
  return { stream, get text() { return text; } };
}

test('docreader: am render uploads by default and prints the DocReader line', async () => {
  const { server, base } = await stubServer({ status: 201, json: { status: 'created', doc: { id: 'zz9', title: 'T', category: 'agent' } } });
  try {
    const out = sink();
    const err = sink();
    const code = await main(['render', '-'], {
      stdout: out.stream, stderr: err.stream, stdin: Readable.from(['---\ntitle: T\ncategory: agent\n---\n## A\n正文。\n']),
      env: { AM_NO_OPEN: '1', AM_HOME: dir, HOME: dir, DOC_READER_BASE: base, DOC_READER_API_KEY: 'k' },
      cwd: dir,
    });
    assert.equal(code, 0, err.text);
    assert.match(out.text, /DocReader: created → .*#\/doc\/zz9/);
  } finally {
    server.close();
  }
});

test('docreader: am render --no-upload stays local', async () => {
  const out = sink();
  const err = sink();
  const code = await main(['render', '-', '--no-upload'], {
    stdout: out.stream, stderr: err.stream, stdin: Readable.from(['---\ntitle: T2\n---\n## A\n正文。\n']),
    // No DOC_READER_BASE: if the flag were ignored and no credential existed, a
    // "not uploaded" skip line would appear — its absence proves the flag worked.
    env: { AM_NO_OPEN: '1', AM_HOME: dir, HOME: dir },
    cwd: dir,
  });
  assert.equal(code, 0, err.text);
  assert.doesNotMatch(out.text, /DocReader:/);
});
