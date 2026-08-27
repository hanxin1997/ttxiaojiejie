import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

import { getCacheControl, serveFile } from '../server/middleware.mjs';

class MemoryResponse extends Writable {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = {};
    this.chunks = [];
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    return this;
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  get body() {
    return Buffer.concat(this.chunks);
  }
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-media-'));
  const filePath = path.join(root, 'page.jpg');
  await fs.writeFile(filePath, Buffer.from('0123456789', 'utf8'));
  return filePath;
}

function request(method = 'GET', headers = {}) {
  return { method, headers };
}

test('Vite hashed assets are immutable while entry files are not cached', () => {
  assert.equal(
    getCacheControl('/public/assets/index-CwNq8RzK.js', 'application/javascript; charset=utf-8'),
    'public, max-age=31536000, immutable',
  );
  assert.equal(
    getCacheControl('/public/index.html', 'text/html; charset=utf-8'),
    'no-store',
  );
});

test('serveFile supports byte ranges and validators', async () => {
  const filePath = await createFixture();
  const response = new MemoryResponse();

  await serveFile(response, filePath, request('GET', { range: 'bytes=2-5' }));

  assert.equal(response.statusCode, 206);
  assert.equal(response.headers['accept-ranges'], 'bytes');
  assert.equal(response.headers['content-range'], 'bytes 2-5/10');
  assert.equal(response.headers['content-length'], 4);
  assert.equal(response.body.toString('utf8'), '2345');
  assert.ok(response.headers.etag);
  assert.ok(response.headers['last-modified']);
});

test('serveFile returns 304 for a matching ETag', async () => {
  const filePath = await createFixture();
  const first = new MemoryResponse();
  await serveFile(first, filePath, request());

  const response = new MemoryResponse();
  await serveFile(response, filePath, request('GET', { 'if-none-match': first.headers.etag }));

  assert.equal(response.statusCode, 304);
  assert.equal(response.body.length, 0);
});

test('serveFile implements HEAD without streaming the body', async () => {
  const filePath = await createFixture();
  const response = new MemoryResponse();

  await serveFile(response, filePath, request('HEAD'));

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-length'], 10);
  assert.equal(response.body.length, 0);
});

test('serveFile rejects unsatisfiable ranges', async () => {
  const filePath = await createFixture();
  const response = new MemoryResponse();

  await serveFile(response, filePath, request('GET', { range: 'bytes=99-120' }));

  assert.equal(response.statusCode, 416);
  assert.equal(response.headers['content-range'], 'bytes */10');
  assert.equal(response.body.length, 0);
});
