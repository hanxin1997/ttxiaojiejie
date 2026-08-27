import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { LibraryWatcher } from '../server/watcher.mjs';

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for watcher state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('watcher limit keeps the root watcher and starts a periodic degraded scan', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-watcher-limit-'));
  await fs.mkdir(path.join(tempRoot, 'series-a', 'chapter-a'), { recursive: true });
  let fallbackScans = 0;
  const watcher = new LibraryWatcher({
    libraryRoot: tempRoot,
    maxWatchers: 1,
    degradedScanIntervalMs: 20,
    onChange(dirtyPaths) {
      assert.deepEqual(dirtyPaths, [path.resolve(tempRoot)]);
      fallbackScans += 1;
    },
  });

  try {
    watcher.start();
    await waitFor(() => watcher.getStatus().degraded);
    await waitFor(() => fallbackScans > 0);

    const status = watcher.getStatus();
    assert.equal(status.watchedPaths, 1);
    assert.equal(status.degraded, true);
  } finally {
    watcher.stop();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
