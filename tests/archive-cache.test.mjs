import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32 } from 'node:zlib';

import { ArchiveCache } from '../server/archive-cache.mjs';
import { ArchiveError, readArchiveIdentity } from '../server/archive.mjs';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-archive-cache-'));
  const cache = new ArchiveCache(path.join(root, 'cache'), { extractPage: writePage, ...options });
  t.after(async () => {
    await cache.close({ force: true });
    await fs.rm(root, { recursive: true, force: true });
  });
  await cache.init();
  return { root, cache };
}

// These tests deliberately inject extraction rather than pretending to parse ZIP.
// Real source-file stat identities still exercise invalidation and cache lifecycle.
async function sourceAt(root, index, size = 4) {
  const sourcePath = path.join(root, `source-${index}.cbz`);
  await fs.writeFile(sourcePath, `archive-fixture-${index}`);
  const content = Buffer.alloc(size, 0x78);
  return {
    sourcePath,
    archiveEntry: {
      version: 1, index: 0, name: `${index}.jpg`, crc32: crc32(content),
      compressedSize: size, uncompressedSize: size, compressionMethod: 0,
      archiveIdentity: await readArchiveIdentity(sourcePath),
    },
  };
}

async function writePage(_sourcePath, entry, targetPath) {
  await fs.writeFile(targetPath, Buffer.alloc(entry.uncompressedSize, 0x78));
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await delay(5);
  }
  assert.fail('timed out waiting for archive cache state');
}

async function abortableGate(gate, signal) {
  if (signal.aborted) throw new ArchiveError('ARCHIVE_ABORTED', 'Cancelled', 503);
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(new ArchiveError('ARCHIVE_ABORTED', 'Cancelled', 503));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([gate, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

test('archive cache merges concurrent requests and preserves cached file timestamps', { timeout: 5000 }, async (t) => {
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  let calls = 0;
  const { root, cache } = await fixture(t, { extractPage: async (sourcePath, entry, target, { signal }) => {
    calls += 1;
    started.resolve();
    await abortableGate(gate.promise, signal);
    await writePage(sourcePath, entry, target);
  } });
  const source = await sourceAt(root, 1);
  const pending = Promise.all(Array.from({ length: 8 }, () => cache.acquire(source)));
  await started.promise;
  gate.resolve();
  const leases = await pending;
  assert.equal(calls, 1);
  assert.equal(new Set(leases.map((lease) => lease.sourcePath)).size, 1);
  const before = await fs.stat(leases[0].sourcePath);
  await Promise.all(leases.map((lease) => lease.release()));
  const cached = await cache.acquire(source);
  const after = await fs.stat(cached.sourcePath);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ctimeMs, before.ctimeMs);
  assert.equal(calls, 1);
  await cached.release();
  await cached.release();
  assert.equal((await cache.getStats()).pinned, 0);
});

test('archive cache cleans failed temporary extraction and allows retry', { timeout: 5000 }, async (t) => {
  let calls = 0;
  const { root, cache } = await fixture(t, { extractPage: async (sourcePath, entry, target) => {
    calls += 1;
    await fs.writeFile(target, 'partial');
    if (calls === 1) throw new Error('injected extraction failure');
    await writePage(sourcePath, entry, target);
  } });
  const source = await sourceAt(root, 1);
  await assert.rejects(cache.acquire(source), /injected extraction failure/);
  assert.deepEqual(await fs.readdir(cache.cacheDir), []);
  const lease = await cache.acquire(source);
  assert.equal(calls, 2);
  assert.equal(await fs.readFile(lease.sourcePath, 'utf8'), 'xxxx');
  await lease.release();
});

test('archive cache bounds concurrent extraction and its waiting queue', { timeout: 5000 }, async (t) => {
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  let active = 0;
  let maximum = 0;
  const { root, cache } = await fixture(t, { concurrency: 1, maxQueue: 1,
    extractPage: async (sourcePath, entry, target, { signal }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      started.resolve();
      try {
        await abortableGate(gate.promise, signal);
        await writePage(sourcePath, entry, target);
      } finally { active -= 1; }
    },
  });
  const sources = await Promise.all([1, 2, 3].map((index) => sourceAt(root, index)));
  const first = cache.acquire(sources[0]);
  await started.promise;
  const second = cache.acquire(sources[1]);
  await waitUntil(async () => (await cache.getStats()).queued === 1);
  await assert.rejects(cache.acquire(sources[2]), { code: 'ARCHIVE_BUSY' });
  gate.resolve();
  const leases = await Promise.all([first, second]);
  assert.equal(maximum, 1);
  await Promise.all(leases.map((lease) => lease.release()));
});

test('archive cache protects leased pages under capacity pressure and evicts after release', { timeout: 5000 }, async (t) => {
  const { root, cache } = await fixture(t, { maxBytes: 4 });
  const firstSource = await sourceAt(root, 1);
  const secondSource = await sourceAt(root, 2);
  const first = await cache.acquire(firstSource);
  await assert.rejects(cache.acquire(secondSource), { code: 'ARCHIVE_BUSY' });
  assert.equal(await fs.readFile(first.sourcePath, 'utf8'), 'xxxx');
  await first.release();
  const second = await cache.acquire(secondSource);
  await assert.rejects(fs.stat(first.sourcePath), { code: 'ENOENT' });
  assert.equal((await cache.getStats()).totalSize, 4);
  await second.release();
});

test('archive cache rebuilds an externally deleted page with a one-page disk budget', { timeout: 5000 }, async (t) => {
  let calls = 0;
  const { root, cache } = await fixture(t, { maxBytes: 4, extractPage: async (...args) => {
    calls += 1;
    await writePage(...args);
  } });
  const source = await sourceAt(root, 1);
  const first = await cache.acquire(source);
  await first.release();
  await fs.unlink(first.sourcePath);
  const rebuilt = await cache.acquire(source);
  assert.equal(rebuilt.sourcePath, first.sourcePath);
  assert.equal(await fs.readFile(rebuilt.sourcePath, 'utf8'), 'xxxx');
  assert.equal(calls, 2);
  assert.equal((await cache.getStats()).totalSize, 4);
  await rebuilt.release();
});

test('archive cache applies idle TTL without removing a currently leased page', { timeout: 5000 }, async (t) => {
  const { root, cache } = await fixture(t, { ttlMs: 1000 });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const source = await sourceAt(root, 1);
  const lease = await cache.acquire(source);
  now += 1001;
  await cache.pruneCache();
  assert.equal((await cache.getStats()).count, 1);
  await lease.release();
  now += 1001;
  await cache.pruneCache();
  assert.equal((await cache.getStats()).count, 0);
  await assert.rejects(fs.stat(lease.sourcePath), { code: 'ENOENT' });
});

test('archive cache rejects stale source identities and accepts a refreshed descriptor', { timeout: 5000 }, async (t) => {
  let calls = 0;
  const { root, cache } = await fixture(t, { extractPage: async (...args) => {
    calls += 1;
    await writePage(...args);
  } });
  const source = await sourceAt(root, 1);
  const first = await cache.acquire(source);
  await first.release();
  await fs.writeFile(source.sourcePath, 'replacement archive with a different byte length');
  await assert.rejects(cache.acquire(source), { code: 'ARCHIVE_STALE' });
  source.archiveEntry.archiveIdentity = await readArchiveIdentity(source.sourcePath);
  const refreshed = await cache.acquire(source);
  assert.notEqual(refreshed.sourcePath, first.sourcePath);
  assert.equal(calls, 2);
  await refreshed.release();
});

test('archive cache rechecks source identity after a cache-hit lookup', { timeout: 5000 }, async (t) => {
  const { root, cache } = await fixture(t);
  const source = await sourceAt(root, 1);
  const first = await cache.acquire(source);
  await first.release();
  const originalStat = fs.stat.bind(fs);
  let replaced = false;
  t.mock.method(fs, 'stat', async (filePath, ...args) => {
    const stats = await originalStat(filePath, ...args);
    if (!replaced && filePath === first.sourcePath) {
      replaced = true;
      await fs.writeFile(source.sourcePath, 'replaced during cache lookup with a different length');
    }
    return stats;
  });
  let unexpectedLease;
  try {
    await assert.rejects(async () => { unexpectedLease = await cache.acquire(source); }, { code: 'ARCHIVE_STALE' });
  } finally {
    await unexpectedLease?.release();
  }
  assert.equal(replaced, true);
  assert.equal((await cache.getStats()).pinned, 0);
});

test('archive cache does not publish extraction when its source changes during the job', { timeout: 5000 }, async (t) => {
  const { root, cache } = await fixture(t, { extractPage: async (sourcePath, entry, target) => {
    await writePage(sourcePath, entry, target);
    await fs.writeFile(sourcePath, 'archive changed while an extraction was active');
  } });
  const source = await sourceAt(root, 1);
  await assert.rejects(cache.acquire(source), { code: 'ARCHIVE_STALE' });
  assert.deepEqual(await fs.readdir(cache.cacheDir), []);
  assert.equal((await cache.getStats()).reservedBytes, 0);
});

test('archive cache rejects pages over configured expansion or disk limits before extraction', { timeout: 5000 }, async (t) => {
  let calls = 0;
  const { root, cache } = await fixture(t, { maxPageBytes: 3, extractPage: async () => { calls += 1; } });
  const source = await sourceAt(root, 1);
  await assert.rejects(cache.acquire(source), { code: 'ARCHIVE_LIMIT' });
  assert.equal(calls, 0);
  const smallDisk = new ArchiveCache(path.join(root, 'small-disk'), { maxBytes: 3, extractPage: writePage });
  t.after(() => smallDisk.close({ force: true }));
  await assert.rejects(smallDisk.acquire(source), { code: 'ARCHIVE_LIMIT' });
});

test('archive cache force-close upgrades a graceful close and cancels active and queued work', { timeout: 5000 }, async (t) => {
  const started = Promise.withResolvers();
  const never = Promise.withResolvers();
  const { root, cache } = await fixture(t, { concurrency: 1, extractPage: async (_source, _entry, target, { signal }) => {
    await fs.writeFile(target, 'partial');
    started.resolve();
    await abortableGate(never.promise, signal);
  } });
  const firstSource = await sourceAt(root, 1);
  const secondSource = await sourceAt(root, 2);
  const first = cache.acquire(firstSource).then((lease) => ({ lease }), (error) => ({ error }));
  await started.promise;
  const second = cache.acquire(secondSource).then((lease) => ({ lease }), (error) => ({ error }));
  await waitUntil(async () => (await cache.getStats()).queued === 1);
  let finished = false;
  const graceful = cache.close().then(() => { finished = true; });
  assert.equal((await second).error.code, 'ARCHIVE_CLOSED');
  assert.equal(finished, false);
  await cache.close({ force: true });
  await graceful;
  assert.equal((await first).error.code, 'ARCHIVE_ABORTED');
  assert.deepEqual(await fs.readdir(cache.cacheDir), []);
  assert.equal((await cache.getStats()).active, 0);
  await assert.rejects(cache.acquire(firstSource), { code: 'ARCHIVE_CLOSED' });
});
