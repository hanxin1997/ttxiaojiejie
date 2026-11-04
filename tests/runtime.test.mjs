import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { RuntimeMetrics } from '../server/runtime-metrics.mjs';
import { shutdownRuntime } from '../server/shutdown.mjs';

test('runtime metrics expose event-loop, database, scan, websocket, metadata, and separate cache queues', async (t) => {
  const metrics = new RuntimeMetrics({ resolution: 10 });
  t.after(() => metrics.close());
  const snapshot = await metrics.snapshot({
    store: { getDatabaseWorkerMetrics: () => ({ pending: 2, limit: 32 }) },
    scanCoordinator: { getStatus: () => ({ running: true }), getProgress: () => ({ completed: 3 }) },
    liveUpdates: { getClientCount: () => 4 },
    metadataJobs: { getMetrics: () => ({ active: 1, queued: 5 }) },
    thumbnailService: { getStats: async () => ({ active: 1, queued: 6 }) },
    archiveCache: { getStats: () => ({ active: 2, queued: 7, maxPageBytes: 64 * 1024 * 1024 }) },
  });

  assert.equal(snapshot.database.pending, 2);
  assert.equal(snapshot.scan.status.running, true);
  assert.equal(snapshot.websocket.clients, 4);
  assert.equal(snapshot.metadata.queued, 5);
  assert.equal(snapshot.imageCache.queued, 6);
  assert.equal(snapshot.archiveCache.queued, 7);
  assert.equal(snapshot.archiveCache.active, 2);
  assert.equal(typeof snapshot.process.rssBytes, 'number');
});

test('runtime metrics remain available when archive cache statistics fail or the cache is absent', async (t) => {
  const metrics = new RuntimeMetrics();
  t.after(() => metrics.close());
  const ctx = {
    store: {},
    scanCoordinator: { getStatus: () => ({}), getProgress: () => null },
    thumbnailService: { getStats: async () => ({ queued: 0 }) },
  };
  assert.deepEqual((await metrics.snapshot(ctx)).archiveCache, { available: false });

  for (const getStats of [
    () => { throw new Error('cache disk unavailable'); },
    async () => { throw new Error('cache disk unavailable'); },
  ]) {
    const snapshot = await metrics.snapshot({ ...ctx, archiveCache: { getStats } });
    assert.deepEqual(snapshot.archiveCache, { error: 'cache disk unavailable' });
    assert.equal(snapshot.imageCache.queued, 0);
    assert.equal(typeof snapshot.process.rssBytes, 'number');
  }
});

test('graceful shutdown stops ingress and background producers before closing the store', async () => {
  const calls = [];
  const server = {
    close(callback) { calls.push('server'); callback(); },
    closeIdleConnections() { calls.push('idle'); },
  };
  const ctx = {
    watcher: { stop() { calls.push('watcher'); } },
    scanCoordinator: { async destroy() { calls.push('scanner'); } },
    metadataJobs: { async destroy() { calls.push('metadata'); } },
    liveUpdates: { destroy() { calls.push('websocket'); } },
    archiveCache: { async close() { calls.push('archive'); } },
    runtimeMetrics: { close() { calls.push('metrics'); } },
    store: { async close() { calls.push('store'); } },
  };

  assert.deepEqual(await shutdownRuntime(server, ctx, { timeoutMs: 1000 }), { graceful: true });
  assert.equal(calls[0], 'watcher');
  assert.equal(calls.at(-1), 'store');
  assert.ok(calls.indexOf('server') < calls.indexOf('store'));
  assert.ok(calls.indexOf('archive') > calls.indexOf('scanner'));
  assert.ok(calls.indexOf('archive') < calls.indexOf('store'));
});

test('shutdown drains HTTP and background work before closing the archive cache and store', async (t) => {
  const calls = [];
  const scan = Promise.withResolvers();
  const archive = Promise.withResolvers();
  let finishHttp;
  t.after(() => { finishHttp?.(); scan.resolve(); archive.resolve(); });
  const shutdown = shutdownRuntime({ close(callback) { finishHttp = callback; } }, {
    scanCoordinator: { destroy: () => scan.promise },
    archiveCache: { close() { calls.push('archive'); return archive.promise; } },
    store: { async close() { calls.push('store'); } },
  }, { timeoutMs: 1000 });

  await nextTurn();
  assert.deepEqual(calls, []);
  finishHttp();
  await nextTurn();
  assert.deepEqual(calls, [], 'background work must finish even after HTTP drains');
  scan.resolve();
  await nextTurn();
  assert.deepEqual(calls, ['archive'], 'the store stays available while archive cleanup is active');
  archive.resolve();
  assert.deepEqual(await shutdown, { graceful: true });
  assert.deepEqual(calls, ['archive', 'store']);
});

test('shutdown deadline aborts archive work even if HTTP and a producer have not drained', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const scan = Promise.withResolvers();
  const archive = Promise.withResolvers();
  let finishHttp;
  t.after(() => { finishHttp?.(); scan.resolve(); archive.resolve(); });
  const shutdown = shutdownRuntime({
    close(callback) { finishHttp = callback; },
    closeAllConnections() { calls.push('connections-aborted'); },
  }, {
    scanCoordinator: { destroy: () => scan.promise },
    archiveCache: {
      close(options) { calls.push(options?.force ? 'archive-aborted' : 'archive-drained'); return archive.promise; },
    },
    store: { async close() { calls.push('store'); } },
  }, { timeoutMs: 1000 });

  t.mock.timers.tick(1000);
  assert.deepEqual(await shutdown, { graceful: false });
  assert.deepEqual(calls, ['connections-aborted', 'archive-aborted', 'store']);

  // 超时后迟到的 HTTP/扫描完成回调不能再次发起温和关闭，也不能重开缓存。
  finishHttp();
  scan.resolve();
  archive.resolve();
  await nextTurn();
  assert.deepEqual(calls, ['connections-aborted', 'archive-aborted', 'store']);
});

test('shutdown deadline upgrades a pending archive close to forced cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const archive = Promise.withResolvers();
  t.after(() => archive.resolve());
  const calls = [];
  const shutdown = shutdownRuntime({ close(callback) { callback(); } }, {
    archiveCache: {
      close(options) {
        calls.push(options?.force ? 'force' : 'graceful');
        return archive.promise;
      },
    },
    store: { async close() { calls.push('store'); } },
  }, { timeoutMs: 1000 });

  await nextTurn();
  assert.deepEqual(calls, ['graceful']);
  t.mock.timers.tick(1000);
  assert.deepEqual(await shutdown, { graceful: false });
  assert.deepEqual(calls, ['graceful', 'force', 'store']);
});

test('shutdown still closes metrics and the store when archive cleanup fails', async () => {
  const calls = [];
  await assert.rejects(shutdownRuntime({ close(callback) { callback(); } }, {
    archiveCache: { async close() { throw new Error('archive cleanup failed'); } },
    runtimeMetrics: { close() { calls.push('metrics'); } },
    store: { async close() { calls.push('store'); } },
  }, { timeoutMs: 1000 }), /archive cleanup failed/);
  assert.deepEqual(calls, ['metrics', 'store']);
});

test('shutdown deadline also cancels shared index builders and closes the image queue', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const shutdown = shutdownRuntime({ close() {} }, {
    archiveCache: { close() { calls.push('raw'); } },
    archiveIndexCache: { close() { calls.push('index'); } },
    thumbnailService: { close() { calls.push('images'); } },
    store: { async close() { calls.push('store'); } },
  }, { timeoutMs: 1000 });
  t.mock.timers.tick(1000);
  assert.deepEqual(await shutdown, { graceful: false });
  assert.ok(calls.includes('index'), 'shared index jobs survive reader cancellation unless explicitly closed');
  assert.ok(calls.includes('images'));
});
