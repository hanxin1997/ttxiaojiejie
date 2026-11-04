import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { listArchivePages, getArchiveIndexStats } from '../server/archive.mjs';
import { ArchiveCache, createArchiveCacheKey } from '../server/archive-cache.mjs';
import { ThumbnailService } from '../server/thumbnail.mjs';
import { writeCbz } from '../tests/helpers/cbz-fixtures.mjs';

// 此基准需要真实库；CI 已安装依赖并强制执行，本地缺库时明确报告未验证。
let sharp;
try {
  await import('yauzl');
  sharp = (await import('sharp')).default;
} catch (error) {
  if (process.env.REQUIRE_ARCHIVE_DEPS === '1') throw error;
  console.log(JSON.stringify({ skipped: true, reason: 'yauzl/sharp unavailable; no media performance measured' }));
  process.exit(0);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-media-benchmark-'));
const raw = new ArchiveCache(path.join(root, 'raw'), { concurrency: 1, maxBytes: 8 * 1024 * 1024 });
const variants = new ThumbnailService(path.join(root, 'variants'), { concurrency: 1 });
try {
  const content = await sharp({ create: { width: 1600, height: 2400, channels: 3,
    background: { r: 96, g: 128, b: 160 } } }).png().toBuffer();
  const archivePath = path.join(root, 'reader.cbz');
  const pageCount = 256;
  await writeCbz(archivePath, Array.from({ length: pageCount }, (_, index) => ({ name: `${index + 1}.png`, content })));
  const indexStarted = performance.now();
  const pages = await listArchivePages(archivePath);
  const indexMs = performance.now() - indexStarted;
  const before = getArchiveIndexStats().builds;
  const coldTimes = [];
  for (const page of pages) {
    const started = performance.now();
    const lease = await raw.acquire(page);
    await lease.release();
    coldTimes.push(performance.now() - started);
  }
  assert.equal(getArchiveIndexStats().builds, before, 'sequential page extraction reuses the central directory');
  const page = pages[0];
  const lease = await raw.acquire(page);
  const cacheIdentity = `archive:${createArchiveCacheKey(page)}`;
  const variantStarted = performance.now();
  const mono = await variants.acquireVariant(lease.sourcePath, 'reader-lite-mono', { cacheIdentity });
  assert.ok(mono);
  const variantMs = performance.now() - variantStarted;
  const output = await sharp(mono.sourcePath).metadata();
  assert.equal(output.width, 1280);
  await mono.release();
  await lease.release();
  await fs.unlink(lease.sourcePath);
  const warmStarted = performance.now();
  const warm = await variants.acquireCachedVariant(cacheIdentity, 'reader-lite-mono');
  assert.ok(warm, 'e-ink variant remains usable after raw page eviction');
  const warmMs = performance.now() - warmStarted;
  await warm.release();
  coldTimes.sort((a, b) => a - b);
  console.log(JSON.stringify({ pageCount, indexMs, coldPageP95Ms: coldTimes[Math.ceil(pageCount * .95) - 1],
    variantMs, cachedVariantMs: warmMs, index: getArchiveIndexStats(), variants: await variants.getStats() }));
} finally {
  await variants.close();
  await raw.close({ force: true });
  await fs.rm(root, { recursive: true, force: true });
}
