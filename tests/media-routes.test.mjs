import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, deflateSync } from 'node:zlib';

import { ArchiveError, readArchiveIdentity } from '../server/archive.mjs';
import { ArchiveCache } from '../server/archive-cache.mjs';
import { createApp } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';
import { scanLibrary } from '../server/scanner.mjs';
import { AppStore } from '../server/store.mjs';
import { ThumbnailService } from '../server/thumbnail.mjs';
import { writeCbz } from './helpers/cbz-fixtures.mjs';

function createCatalog(source) {
  return {
    lastScanAt: new Date().toISOString(), scanRoot: '/library',
    stats: { seriesCount: 1, volumeCount: 0, chapterCount: 1, pageCount: 1, totalBytes: 10, categories: [] },
    series: [{
      id: 'comic', title: 'Comic', sourceKey: 'author/comic', sourcePath: '/library/author/comic',
      sourceFolderName: 'comic', categories: { auto: [], folder: [], manual: [], effective: [] },
      counts: { volumes: 0, chapters: 1, pages: 1 }, totalBytes: 10,
      cover: { ...source, fileName: '1.jpg' },
      volumes: [{
        id: 'volume', title: 'Default', sourcePath: '/library/author/comic', synthetic: true,
        chapters: [{
          id: 'chapter', title: 'Comic', sourceKey: 'author/comic/Comic.cbz',
          sourcePath: source.sourcePath, pageCount: 1, totalBytes: 10,
          pages: [{ ...source, index: 1, sizeBytes: 10, mtimeMs: 1 }],
        }],
      }],
    }],
  };
}

async function createFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-http-cbz-'));
  const config = loadConfig();
  config.dataDir = path.join(root, 'data');
  config.databaseFile = path.join(config.dataDir, 'app.sqlite');
  config.publicDir = path.join(root, 'public');
  config.defaultSettings.libraryRoot = path.join(root, 'library');
  config.rateLimit.maxRequests = 0;
  const store = new AppStore(config);
  await store.init();
  const imagePath = path.join(root, '1.jpg');
  await fs.writeFile(imagePath, '0123456789');
  const ctx = {
    config, store, archiveCache: options.archiveCache ?? null,
    thumbnailService: options.thumbnailService ?? null,
    scanCoordinator: { getStatus: () => ({}), getProgress: () => null, run: async () => {} },
    notifyLibraryChanged() {},
  };
  const server = http.createServer(createApp(ctx));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await ctx.archiveCache?.close?.({ force: true });
    await ctx.thumbnailService?.pruneCache?.();
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { root, config, store, ctx, imagePath, url: `http://127.0.0.1:${server.address().port}` };
}

async function requireDependency(t, name) {
  try {
    return await import(name);
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes(`'${name}'`)) throw error;
    if (process.env.REQUIRE_ARCHIVE_DEPS === '1') throw error;
    t.skip(`${name} is not installed locally; real dependency integration runs in CI`);
    return null;
  }
}

async function waitForReleased(predicate) {
  // 客户端收到最后一个字节时，服务端 pipeline 的 finally 可能尚未执行。
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await delay(5);
  assert.ok(predicate(), 'media leases must be released after the response completes');
}

// 小型有效 PNG，用于真实 Sharp 解码；不依赖图片生成工具或外部 fixture 下载。
function png(red, green, blue) {
  function chunk(type, bytes) {
    const label = Buffer.from(type);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([label, bytes])));
    return Buffer.concat([header, label, bytes, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.from([0, red, green, blue, red, green, blue]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat([row, row]))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('media routes resolve archived sources for covers, pages and variants and release leases', async (t) => {
  let acquired = 0;
  let released = 0;
  let expectedImagePath;
  const variants = [];
  const thumbnailService = {
    async getVariant(sourcePath, variant) {
      assert.equal(sourcePath, expectedImagePath);
      assert.ok(acquired > released);
      variants.push(variant);
      return expectedImagePath;
    },
  };
  const fixture = await createFixture(t, { thumbnailService });
  const { ctx, store, imagePath, url } = fixture;
  expectedImagePath = imagePath;
  ctx.archiveCache = {
    async acquire(source) {
      assert.equal(source.archiveEntry.name, '1.jpg');
      acquired += 1;
      return { sourcePath: imagePath, release: async () => { released += 1; } };
    },
  };
  const source = { sourcePath: '/library/Comic.cbz', archiveEntry: { name: '1.jpg' } };
  await store.replaceLibrary(createCatalog(source));
  const detail = await (await fetch(`${url}/api/series/comic`)).json();
  assert.equal(detail.volumes[0].chapters[0].pageCount, 1);
  const pages = await (await fetch(`${url}/api/chapters/chapter/pages`)).json();
  assert.deepEqual(pages, { chapterId: 'chapter', pageCount: 1, urlTemplate: '/media/chapter/chapter/{pageIndex}' });
  for (const route of ['/media/cover/comic', '/media/chapter/chapter/1']) {
    const response = await fetch(`${url}${route}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.equal(await response.text(), '0123456789');
  }
  assert.equal(acquired, 2);
  await waitForReleased(() => acquired === released);
  assert.equal(released, 2);
  const custom = await fetch(`${url}/api/series/comic/cover`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chapterId: 'chapter', pageIndex: 1 }),
  });
  assert.equal(custom.status, 200);
  assert.equal((await custom.json()).coverUrl, '/media/chapter/chapter/1');
  const supportedVariants = ['cover', 'reader-balanced', 'reader-lite', 'reader-mono', 'reader-balanced-mono', 'reader-lite-mono'];
  for (const variant of supportedVariants) {
    const response = await fetch(`${url}/media/chapter/chapter/1?variant=${variant}`);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  assert.deepEqual(variants, supportedVariants);
  assert.equal(acquired, 8);
  await waitForReleased(() => acquired === released);
  assert.equal(released, 8);
});

test('archive media reuses HTTP HEAD, Range and ETag semantics and rejects invalid page indexes', async (t) => {
  const fixture = await createFixture(t);
  const { store, ctx, url, imagePath } = fixture;
  let leases = 0;
  ctx.archiveCache = {
    async acquire() {
      leases += 1;
      return { sourcePath: imagePath, release: async () => { leases -= 1; } };
    },
  };
  await store.replaceLibrary(createCatalog({ sourcePath: '/library/Comic.cbz', archiveEntry: { name: '1.jpg' } }));
  const pageUrl = `${url}/media/chapter/chapter/1`;
  const original = await fetch(pageUrl);
  const etag = original.headers.get('etag');
  assert.equal(await original.text(), '0123456789');
  const head = await fetch(pageUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
  const partial = await fetch(pageUrl, { headers: { range: 'bytes=2-5' } });
  assert.equal(partial.status, 206);
  assert.equal(await partial.text(), '2345');
  const unchanged = await fetch(pageUrl, { headers: { 'if-none-match': etag } });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.get('etag'), etag);
  for (const index of ['0', '-1', '1junk', '1.5', '2']) {
    assert.equal((await fetch(`${url}/media/chapter/chapter/${index}`)).status, 404);
  }
  assert.equal((await fetch(`${pageUrl}?variant=unknown`)).status, 400);
  await waitForReleased(() => leases === 0);
});

test('archive errors are uncached and a missing descriptor never serves the whole CBZ', async (t) => {
  const { store, ctx, url, imagePath } = await createFixture(t);
  const archivePath = imagePath.replace(/\.jpg$/, '.cbz');
  await fs.copyFile(imagePath, archivePath);
  await store.replaceLibrary(createCatalog({ sourcePath: archivePath }));
  const stale = await fetch(`${url}/media/chapter/chapter/1`);
  assert.equal(stale.status, 409);
  assert.equal(stale.headers.get('cache-control'), 'no-store');
  assert.match(await stale.text(), /重新扫描/);
  ctx.archiveCache = { async acquire() { throw new ArchiveError('ARCHIVE_INVALID', 'Corrupt CBZ', 422); } };
  await store.replaceLibrary(createCatalog({ sourcePath: archivePath, archiveEntry: { name: '1.jpg' } }));
  const invalid = await fetch(`${url}/media/cover/comic`);
  assert.equal(invalid.status, 422);
  assert.equal(await invalid.text(), 'Corrupt CBZ');
});

test('ordinary image sources keep serving without an archive service', async (t) => {
  const { store, url, imagePath } = await createFixture(t);
  await store.replaceLibrary(createCatalog({ sourcePath: imagePath }));
  const response = await fetch(`${url}/media/chapter/chapter/1`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '0123456789');
});

test('HTTP serves a cached e-ink variant after raw page eviction and invalidates replaced archives', async (t) => {
  const { root, ctx, store, imagePath } = await createFixture(t);
  const archivePath = path.join(root, 'comic.cbz');
  await fs.writeFile(archivePath, 'archive identity fixture');
  const source = { sourcePath: archivePath, archiveEntry: {
    version: 1, index: 0, name: '1.jpg', crc32: 1, compressedSize: 10,
    uncompressedSize: 10, compressionMethod: 0, archiveIdentity: await readArchiveIdentity(archivePath),
  } };
  let extractions = 0;
  ctx.archiveCache = { acquire: async () => {
    extractions++;
    return { sourcePath: imagePath, release: async () => {} };
  } };
  const thumbnails = new ThumbnailService(path.join(root, 'thumbs'));
  let encodings = 0;
  thumbnails.sharpModule = () => ({
    metadata: async () => ({ pages: 1 }),
    rotate() { return this; }, resize() { return this; }, webp() { return this; },
    gamma() { return this; }, greyscale() { return this; }, toColourspace() { return this; },
    async toFile(target) { encodings++; await fs.writeFile(target, 'cached-mono-image'); },
  });
  ctx.thumbnailService = thumbnails;
  // createApp 捕获 thumbnailService，因此此验证使用同一上下文重新注册媒体路由。
  const server = http.createServer(createApp(ctx));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await thumbnails.close();
  });
  const mediaUrl = `http://127.0.0.1:${server.address().port}/media/chapter/chapter/1?variant=reader-lite-mono`;
  await store.replaceLibrary(createCatalog(source));
  assert.equal(await (await fetch(mediaUrl)).text(), 'cached-mono-image');
  await fs.unlink(imagePath);
  const repeated = await fetch(mediaUrl);
  assert.equal(repeated.status, 200);
  assert.equal(await repeated.text(), 'cached-mono-image');
  assert.equal(extractions, 1);
  assert.equal(encodings, 1);
  await fs.writeFile(archivePath, 'archive replaced with a longer different source');
  assert.equal((await fetch(mediaUrl)).status, 409);
});

test('real CBZ scans through SQLite into HTTP pages and an embedded cover', async (t) => {
  if (!await requireDependency(t, 'yauzl')) return;
  const { root, config, ctx, store, url } = await createFixture(t);
  const archivePath = path.join(config.defaultSettings.libraryRoot, '作者', '漫画', '漫画.cbz');
  const first = png(255, 0, 0);
  const second = png(0, 0, 255);
  await writeCbz(archivePath, [{ name: '2.png', content: second }, { name: '1.png', content: first }]);
  const library = await scanLibrary(store.getSettings(), store.getOverrides());
  assert.equal(library.stats.pageCount, 2);
  assert.deepEqual(library.issues, []);
  await store.replaceLibrary(library);
  ctx.archiveCache = new ArchiveCache(path.join(root, 'archive-cache'), { maxBytes: 1024 * 1024 });
  await ctx.archiveCache.init();
  const series = library.series[0];
  const chapter = series.volumes[0].chapters[0];
  for (const [route, expected] of [
    [`/media/cover/${series.id}`, first],
    [`/media/chapter/${chapter.id}/1`, first],
    [`/media/chapter/${chapter.id}/2`, second],
  ]) {
    const response = await fetch(`${url}${route}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
  const pageUrl = `${url}/media/chapter/${chapter.id}/1`;
  const firstResponse = await fetch(pageUrl);
  await firstResponse.arrayBuffer();
  const unchanged = await fetch(pageUrl, { headers: { 'if-none-match': firstResponse.headers.get('etag') } });
  assert.equal(unchanged.status, 304);
});

test('real CBZ pages support Sharp cover, scaled and grayscale variants with stable caches', async (t) => {
  if (!await requireDependency(t, 'yauzl')) return;
  const sharpModule = await requireDependency(t, 'sharp');
  if (!sharpModule) return;
  const sharp = sharpModule.default;
  let service;
  const proxy = {
    getVariant: (...args) => service.getVariant(...args),
    pruneCache: () => service.pruneCache(),
  };
  const { root, config, ctx, store, url } = await createFixture(t, { thumbnailService: proxy });
  service = new ThumbnailService(path.join(root, 'thumbs'));
  await service.init();
  ctx.archiveCache = new ArchiveCache(path.join(root, 'archive-cache'));
  await ctx.archiveCache.init();
  await writeCbz(path.join(config.defaultSettings.libraryRoot, 'Comic', 'Comic.cbz'), [
    { name: '1.png', content: png(255, 80, 0) },
  ]);
  const library = await scanLibrary(store.getSettings(), store.getOverrides());
  await store.replaceLibrary(library);
  const chapter = library.series[0].volumes[0].chapters[0];
  for (const variant of ['cover', 'reader-balanced', 'reader-lite', 'reader-mono', 'reader-balanced-mono', 'reader-lite-mono']) {
    const address = `${url}/media/chapter/${chapter.id}/1?variant=${variant}`;
    const response = await fetch(address);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    const bytes = Buffer.from(await response.arrayBuffer());
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, 'webp');
    assert.ok(metadata.width > 0 && metadata.height > 0);
    if (variant.includes('mono')) {
      const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      for (let offset = 0; info.channels >= 3 && offset < data.length; offset += info.channels) {
        assert.ok(Math.abs(data[offset] - data[offset + 1]) <= 2);
        assert.ok(Math.abs(data[offset] - data[offset + 2]) <= 2);
      }
    }
    const cached = await fetch(address, { headers: { 'if-none-match': response.headers.get('etag') } });
    assert.equal(cached.status, 304);
  }
});
