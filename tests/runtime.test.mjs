import test from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeMetrics } from '../server/runtime-metrics.mjs';
import { shutdownRuntime } from '../server/shutdown.mjs';

test('runtime metrics expose event-loop, database, scan, websocket, metadata, and cache queues', async () => {
  const metrics = new RuntimeMetrics({ resolution: 10 });
  const snapshot = await metrics.snapshot({
    store: { getDatabaseWorkerMetrics: () => ({ pending: 2, limit: 32 }) },
    scanCoordinator: { getStatus: () => ({ running: true }), getProgress: () => ({ completed: 3 }) },
    liveUpdates: { getClientCount: () => 4 },
    metadataJobs: { getMetrics: () => ({ active: 1, queued: 5 }) },
    thumbnailService: { getStats: async () => ({ active: 1, queued: 6 }) },
  });

  assert.equal(snapshot.database.pending, 2);
  assert.equal(snapshot.scan.status.running, true);
  assert.equal(snapshot.websocket.clients, 4);
  assert.equal(snapshot.metadata.queued, 5);
  assert.equal(snapshot.imageCache.queued, 6);
  assert.equal(typeof snapshot.process.rssBytes, 'number');
  metrics.close();
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
    runtimeMetrics: { close() { calls.push('metrics'); } },
    store: { async close() { calls.push('store'); } },
  };

  await shutdownRuntime(server, ctx, { timeoutMs: 1000 });
  assert.equal(calls[0], 'watcher');
  assert.equal(calls.at(-1), 'store');
  assert.ok(calls.indexOf('server') < calls.indexOf('store'));
});
