import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import { AppStore } from '../server/store.mjs';
import { createApp } from '../server/app.mjs';

const seriesCount = Math.max(1, Number(process.env.TPAP_WRITE_SERIES) || 2000);
const pagesPerChapter = Math.max(1, Number(process.env.TPAP_WRITE_PAGES) || 50);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-write-benchmark-'));
const store = new AppStore({
  dataDir: root, databaseFile: path.join(root, 'app.sqlite'),
  defaultSettings: { libraryRoot: '/library', scanIntervalMinutes: 0,
    folderPattern: { enabled: false }, naming: { defaultVolumeName: 'Volume', directImageChapterTemplate: '{count}P' }, categoryFolders: [] },
});
const server = http.createServer(createApp({ store,
  config: { publicDir: root, rateLimit: { maxRequests: 0 } },
  scanCoordinator: { getStatus: () => ({}), getProgress: () => null },
}));
const library = {
  lastScanAt: new Date().toISOString(), scanRoot: '/library', issues: [],
  stats: { seriesCount, volumeCount: seriesCount, chapterCount: seriesCount,
    pageCount: seriesCount * pagesPerChapter, totalBytes: seriesCount * pagesPerChapter, categories: [] },
  series: Array.from({ length: seriesCount }, (_, index) => ({
    id: `s${index}`, sourceKey: `s${index}`, sourcePath: `/library/s${index}`, title: `Title ${index}`,
    categories: { auto: [], folder: [] }, counts: { volumes: 1, chapters: 1, pages: pagesPerChapter },
    volumes: [{ id: `v${index}`, title: 'Volume', sourcePath: `/library/s${index}`, synthetic: false,
      chapters: [{ id: `c${index}`, title: 'Chapter', sourceKey: `s${index}/c`, sourcePath: `/library/s${index}/c`,
        pageCount: pagesPerChapter, pages: Array.from({ length: pagesPerChapter }, (_, page) => ({
          index: page + 1, sourcePath: `/library/s${index}/c/${page}.jpg`, sizeBytes: 1,
        })) }] }],
  })),
};

try {
  await store.init();
  await store.checkReady();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const healthUrl = `http://127.0.0.1:${server.address().port}/api/health/live`;
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  let active = true;
  const readMs = [];
  const healthMs = [];
  const checkingHealth = (async () => {
    while (active) {
      const start = performance.now();
      const response = await fetch(healthUrl);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
      healthMs.push(performance.now() - start);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  const reading = (async () => {
    while (active) {
      const start = performance.now();
      await store.querySeriesPageAsync({}, { page: 1, pageSize: 30 });
      readMs.push(performance.now() - start);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
  const firstStart = performance.now();
  await store.replaceLibrary(library);
  const initialMs = performance.now() - firstStart;
  const initialFts = store.getDatabaseWriteWorkerMetrics().lastWrite.ftsUpdated;
  const reused = store.getLibraryRef();
  const next = { ...reused, series: reused.series.map((series) => ({ ...series, _reused: true })) };
  const reusedStart = performance.now();
  await store.replaceLibrary(next);
  const reusedMs = performance.now() - reusedStart;
  active = false;
  await reading;
  await checkingHealth;
  lag.disable();
  const metrics = store.getDatabaseWriteWorkerMetrics();
  assert.equal(initialFts, seriesCount);
  assert.equal(metrics.lastWrite.ftsUpdated, 0, 'unchanged scans must not rewrite FTS documents');
  assert.equal(metrics.lastWrite.pages, 0, 'reused scans must retain existing page rows');
  assert.equal((await store.queryChapterPagesAsync('c0')).pageCount, pagesPerChapter);
  assert.ok(metrics.peakBatchRows <= metrics.batchRows);
  readMs.sort((a, b) => a - b);
  healthMs.sort((a, b) => a - b);
  const healthP95Ms = healthMs[Math.ceil(healthMs.length * .95) - 1];
  assert.ok(healthMs.length > 2, 'HTTP remains responsive throughout the catalog transaction');
  assert.ok(healthP95Ms < 250, `health p95 ${healthP95Ms}ms exceeds 250ms`);
  assert.ok(lag.percentile(99) / 1e6 < 100, 'catalog writes must not create sustained event-loop blocking');
  console.log(JSON.stringify({ seriesCount, pageCount: seriesCount * pagesPerChapter, initialMs, reusedMs,
    concurrentReadP95Ms: readMs[Math.ceil(readMs.length * 0.95) - 1],
    eventLoopP99Ms: lag.percentile(99) / 1e6, eventLoopMaxMs: lag.max / 1e6, reads: readMs.length,
    healthP95Ms, healthRequests: healthMs.length,
    peakBatchRows: metrics.peakBatchRows, peakBatchBytes: metrics.peakBatchBytes, unchangedFtsWrites: metrics.lastWrite.ftsUpdated }));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await store.close();
  await fs.rm(root, { recursive: true, force: true });
}
