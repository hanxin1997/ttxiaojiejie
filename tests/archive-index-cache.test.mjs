import assert from 'node:assert/strict';
import test from 'node:test';

import { ArchiveIndexCache } from '../server/archive-index-cache.mjs';

test('archive indexes share concurrent builds and retain a bounded LRU without handles', async () => {
  const cache = new ArchiveIndexCache({ maxBytes: 20, maxArchives: 2 });
  let calls = 0;
  const load = async () => ({ retainedBytes: 10, value: ++calls });
  const [first, same] = await Promise.all([cache.get('a', load), cache.get('a', load)]);
  assert.equal(first, same);
  assert.equal(calls, 1);
  await cache.get('b', load);
  await cache.get('a', load);
  await cache.get('c', load);
  assert.equal(cache.getStats().count, 2);
  assert.equal(cache.getStats().totalSize, 20);
  await cache.get('a', load);
  assert.equal(calls, 3);
  await cache.get('b', load);
  assert.equal(calls, 4);
  assert.equal(cache.getStats().handles, 0);
  await cache.close();
  assert.equal(cache.getStats().totalSize, 0);
});

test('archive index queue is bounded, retries failures and rejects queued work on close', async () => {
  const cache = new ArchiveIndexCache({ maxConcurrent: 1, maxQueue: 1 });
  let release;
  const first = cache.get('a', () => new Promise((resolve) => { release = resolve; }));
  const second = cache.get('b', async () => ({ retainedBytes: 1 }));
  await assert.rejects(cache.get('c', async () => ({})), { code: 'ARCHIVE_BUSY' });
  release({ retainedBytes: 1 });
  await Promise.all([first, second]);
  await assert.rejects(cache.get('failed', async () => { throw new Error('bad ZIP'); }), /bad ZIP/);
  assert.equal((await cache.get('failed', async () => ({ retainedBytes: 1, retried: true }))).retried, true);

  const active = cache.get('active', (signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('closed')), { once: true });
  }));
  const queued = cache.get('queued', async () => ({ retainedBytes: 1 }));
  const settled = Promise.allSettled([active, queued]);
  await Promise.resolve();
  await cache.close();
  assert.deepEqual((await settled).map((item) => item.status), ['rejected', 'rejected']);
  assert.equal(cache.getStats().active, 0);
  assert.equal(cache.getStats().queued, 0);
});

test('one cancelled index reader leaves shared work available to other readers', async () => {
  const cache = new ArchiveIndexCache();
  const controller = new AbortController();
  let release;
  const load = () => new Promise((resolve) => { release = resolve; });
  const cancelled = cache.get('a', load, controller.signal);
  const kept = cache.get('a', load);
  const rejection = assert.rejects(cancelled, { code: 'ARCHIVE_ABORTED' });
  controller.abort();
  await rejection;
  release({ retainedBytes: 1, ready: true });
  assert.equal((await kept).ready, true);
  assert.equal(cache.getStats().builds, 1);
  cache.clear();
  assert.equal(cache.getStats().count, 0);
});

test('closing immediately cancels scheduled index work before its loader starts', async () => {
  const cache = new ArchiveIndexCache();
  let called = false;
  const job = cache.get('a', () => { called = true; return new Promise(() => {}); });
  const rejected = assert.rejects(job, { code: 'ARCHIVE_ABORTED' });
  await cache.close();
  await rejected;
  assert.equal(called, false);
  await assert.rejects(cache.get('later', async () => ({})), { code: 'ARCHIVE_CLOSED' });
});

test('clearing during an index build does not repopulate the cleared generation', async () => {
  const cache = new ArchiveIndexCache();
  let release;
  const building = cache.get('a', () => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  cache.clear();
  release({ retainedBytes: 2 });
  await building;
  assert.equal(cache.getStats().count, 0);
  assert.equal(cache.getStats().active, 0);
});
