import test from 'node:test';
import assert from 'node:assert/strict';

import { ScanCoordinator } from '../server/scan-coordinator.mjs';

function emptyLibrary(label) {
  return {
    lastScanAt: label,
    stats: { seriesCount: 0, volumeCount: 0, chapterCount: 0, pageCount: 0, totalBytes: 0, categories: [] },
    series: [],
    issues: [],
  };
}

test('ScanCoordinator queues one trailing scan when changes arrive during a running scan', async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const calls = [];
  const scanner = async (_settings, _overrides, options) => {
    calls.push([...(options.dirtyPaths ?? [])]);
    if (calls.length === 1) await firstGate;
    return emptyLibrary(`scan-${calls.length}`);
  };
  const replaced = [];
  const store = {
    getSettings: () => ({ scanIntervalMinutes: 0 }),
    getOverrides: () => ({ seriesCategories: {} }),
    getLibrary: () => emptyLibrary('previous'),
    async replaceLibrary(library) {
      replaced.push(library.lastScanAt);
    },
  };
  const coordinator = new ScanCoordinator(store, { resourceProfile: { scanBroadcastIntervalMs: 250 } }, { scanner });

  const running = coordinator.run('startup', { dirtyPaths: ['a'] });
  await Promise.resolve();
  const sameTask = coordinator.run('fs-watch', { dirtyPaths: ['b', 'c'] });
  releaseFirst();
  await Promise.all([running, sameTask]);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['a']);
  assert.deepEqual(new Set(calls[1]), new Set(['b', 'c']));
  assert.deepEqual(replaced, ['scan-1', 'scan-2']);
});
