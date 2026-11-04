import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  createVariantCacheKey,
  createIdentityVariantKey,
  getImageVariantSpec,
  isCacheEntryExpired,
  ThumbnailService,
} from '../server/thumbnail.mjs';

test('a saturated image queue can retry the same image after capacity recovers', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-thumbnail-queue-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sources = ['a', 'b', 'c'].map((name) => path.join(root, `${name}.png`));
  await Promise.all(sources.map((source) => fs.writeFile(source, 'source')));
  const service = new ThumbnailService(path.join(root, 'thumbs'), { concurrency: 1, maxQueue: 1 });
  await service.init();
  let unblock;
  let notifyStarted;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  service.sharpModule = (source) => ({
    async metadata() {
      if (source === sources[0]) { notifyStarted(); await blocked; }
      return { pages: 1 };
    },
    rotate() { return this; }, resize() { return this; }, webp() { return this; },
    async toFile(target) { await fs.writeFile(target, 'encoded'); },
  });
  const first = service.getVariant(sources[0]);
  await started;
  const second = service.getVariant(sources[1]);
  // 等到第二张实际入队，第三张才是确定性的容量拒绝。
  while (service.waitingQueue.length === 0) await delay(1);
  assert.equal(await service.getVariant(sources[2]), null);
  unblock();
  await Promise.all([first, second]);
  const retried = await service.getVariant(sources[2]);
  assert.equal(typeof retried, 'string', 'a rejected task must not poison the deduplication cache');
  assert.equal(service.pendingJobs.size, 0);
  if (service.prunePromise) await service.prunePromise;
});

test('thumbnail cache hits preserve the file identity used for HTTP validators', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-thumbnail-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'page.png');
  await fs.writeFile(source, 'source');
  const service = new ThumbnailService(path.join(root, 'thumbs'));
  await service.init();
  // 缓存命中不应解码图片，本例无需安装 Sharp 也能复现元数据被修改的问题。
  service.sharpModule = () => { throw new Error('cache hit must not regenerate image'); };
  const key = createVariantCacheKey(source, await fs.stat(source), 'cover');
  const cached = path.join(service.cacheDir, key);
  await fs.writeFile(cached, 'webp');
  const before = await fs.stat(cached);
  await delay(20);
  assert.equal(await service.getVariant(source, 'cover'), cached);
  await delay(20);
  const after = await fs.stat(cached);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ctimeMs, before.ctimeMs);
});

test('image variants are fixed and preserve reader aspect ratio', () => {
  assert.deepEqual(getImageVariantSpec('cover'), {
    name: 'cover',
    width: 300,
    height: 450,
    fit: 'cover',
    quality: 80,
  });
  assert.deepEqual(getImageVariantSpec('reader-lite'), {
    name: 'reader-lite',
    width: 1280,
    height: null,
    fit: 'inside',
    quality: 70,
  });
  assert.equal(getImageVariantSpec('900x1200'), null);
});

test('cache key changes when the source file identity changes', () => {
  const first = createVariantCacheKey('/library/a.jpg', { size: 10, mtimeMs: 100, ctimeMs: 90 }, 'cover');
  const second = createVariantCacheKey('/library/a.jpg', { size: 11, mtimeMs: 101, ctimeMs: 90 }, 'cover');

  assert.notEqual(first, second);
  assert.match(first, /^[a-f0-9]{64}_cover\.webp$/);
});

test('cache TTL expires idle entries without expiring recently accessed entries', () => {
  const now = Date.parse('2026-08-10T12:00:00.000Z');
  const ttlMs = 60_000;

  assert.equal(isCacheEntryExpired({ mtimeMs: now - ttlMs - 1 }, now, ttlMs), true);
  assert.equal(isCacheEntryExpired({ mtimeMs: now - ttlMs }, now, ttlMs), false);
  assert.equal(isCacheEntryExpired({ mtimeMs: now - 1000 }, now, ttlMs), false);
});

test('archive variants retain their identity after the extracted original is evicted', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-variant-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = new ThumbnailService(path.join(root, 'thumbs'));
  await service.init();
  const source = path.join(root, 'page.jpg');
  await fs.writeFile(source, 'source');
  let encoded = 0;
  service.sharpModule = () => ({
    metadata: async () => ({ pages: 1 }),
    rotate() { return this; }, resize() { return this; }, webp() { return this; },
    gamma() { return this; }, greyscale() { return this; }, toColourspace() { return this; },
    async toFile(target) { encoded++; await fs.writeFile(target, 'webp'); },
  });
  const identity = 'archive:stable-file-and-entry';
  const first = await service.acquireVariant(source, 'reader-lite-mono', { cacheIdentity: identity });
  assert.ok(first);
  await first.release();
  await fs.unlink(source);
  const cached = await service.acquireCachedVariant(identity, 'reader-lite-mono');
  assert.equal(cached.sourcePath, first.sourcePath);
  assert.equal(encoded, 1);
  assert.equal(await service.acquireCachedVariant('archive:replaced-file', 'reader-lite-mono'), null);
  await cached.release();
});

test('cache statistics and normal leases do not rescan the thumbnail directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-variant-stats-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = new ThumbnailService(root);
  const identity = 'stable';
  const key = createIdentityVariantKey(identity, 'cover');
  await fs.writeFile(path.join(root, key), 'webp');
  await service.init();
  const originalReaddir = fs.readdir.bind(fs);
  let reads = 0;
  t.mock.method(fs, 'readdir', (...args) => { reads++; return originalReaddir(...args); });
  for (let i = 0; i < 10; i++) {
    const lease = await service.acquireCachedVariant(identity, 'cover');
    assert.ok(lease);
    await lease.release();
    assert.equal((await service.getStats()).totalSize, 4);
  }
  assert.equal(reads, 0);
  const lease = await service.acquireCachedVariant(identity, 'cover');
  service.maxBytes = 1;
  await service.pruneCache();
  assert.equal(await fs.readFile(lease.sourcePath, 'utf8'), 'webp', 'in-flight sends retain their lease');
  await lease.release();
  assert.equal((await service.getStats()).count, 0);
});

test('expired variant removal cannot hand a concurrent reader a disappearing lease', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-variant-expiry-'));
  const service = new ThumbnailService(root, { ttlMs: 1 });
  await service.init();
  const identity = 'expired-source';
  const key = createIdentityVariantKey(identity, 'cover');
  const target = path.join(root, key);
  await fs.writeFile(target, 'old');
  service.accessTimes.set(key, Date.now() - 100);
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const unlink = fs.unlink.bind(fs);
  t.mock.method(fs, 'unlink', async (file) => {
    if (file === target) { started.resolve(); await gate.promise; }
    return unlink(file);
  });
  t.after(async () => { gate.resolve(); await fs.rm(root, { recursive: true, force: true }); });
  const first = service.acquireCachedVariant(identity, 'cover');
  await started.promise;
  let settled = false;
  const second = service.acquireCachedVariant(identity, 'cover').then((lease) => { settled = true; return lease; });
  await delay(10);
  try { assert.equal(settled, false, 'a reader must wait for an already-started unlink'); }
  finally { gate.resolve(); }
  assert.equal(await first, null);
  assert.equal(await second, null);
});
