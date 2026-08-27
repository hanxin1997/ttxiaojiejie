import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { MetadataJobCoordinator } from '../server/metadata-job-coordinator.mjs';
import { AppStore } from '../server/store.mjs';

function config(root) {
  return {
    dataDir: path.join(root, 'data'),
    databaseFile: path.join(root, 'data', 'app.sqlite'),
    defaultSettings: {
      libraryRoot: path.join(root, 'library'),
      scanIntervalMinutes: 0,
      scanMode: 'flat',
      folderPattern: { enabled: false, separator: '-', authorSegmentIndex: null, titleSegmentIndex: 0, categorySegmentIndex: null, stripTokens: [] },
      naming: { defaultVolumeName: 'Default Volume', directImageChapterTemplate: '{count}P' },
      categoryFolders: [],
    },
    resourceProfile: { metadataConcurrency: 1 },
    metadataScraper: { provider: 'anilist', endpoint: 'https://example.invalid', itemTimeoutMs: 1000 },
  };
}

function libraryWithSeries(count = 2) {
  const series = Array.from({ length: count }, (_, index) => ({
    id: `series-${index + 1}`,
    sourceKey: `series/${index + 1}`,
    sourcePath: `/library/${index + 1}`,
    sourceFolderName: String(index + 1),
    title: `Series ${index + 1}`,
    author: null,
    updatedAt: '2026-08-09T00:00:00.000Z',
    categories: { auto: [], folder: [], manual: [], effective: [] },
    counts: { volumes: 0, chapters: 0, pages: 0 },
    totalBytes: 0,
    volumes: [],
  }));
  return {
    lastScanAt: '2026-08-09T00:00:00.000Z',
    scanRoot: '/library',
    stats: { seriesCount: count, volumeCount: 0, chapterCount: 0, pageCount: 0, totalBytes: 0, categories: [] },
    issues: [],
    series,
  };
}

async function createStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-metadata-job-'));
  const runtimeConfig = config(root);
  const store = new AppStore(runtimeConfig);
  await store.init();
  await store.replaceLibrary(libraryWithSeries());
  return { store, runtimeConfig };
}

test('metadata job creation returns before scraping and persists paged results', async () => {
  const { store, runtimeConfig } = await createStore();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const coordinator = new MetadataJobCoordinator(store, runtimeConfig, {
    async scrape(series) {
      await gate;
      return { title: `Fetched ${series.title}`, author: null, description: '', tags: ['remote'] };
    },
  });

  const created = await coordinator.createJob({ provider: 'anilist', apply: true, overwrite: false });
  assert.ok(created.jobId);
  assert.ok(['queued', 'running'].includes(store.getMetadataJob(created.jobId).status));

  release();
  await coordinator.waitForIdle();
  const result = store.getMetadataJob(created.jobId, { page: 1, pageSize: 1 });
  assert.equal(result.status, 'completed');
  assert.equal(result.items.length, 1);
  assert.equal(result.totalPages, 2);
  assert.equal(result.successCount, 2);
  assert.equal(store.getMetadata('series/1').title, 'Fetched Series 1');
  assert.deepEqual(store.getTags('series/1'), ['remote']);
});

test('metadata job cancellation prevents remaining items from starting', async () => {
  const { store, runtimeConfig } = await createStore();
  let release;
  let calls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const coordinator = new MetadataJobCoordinator(store, runtimeConfig, {
    async scrape() {
      calls += 1;
      await gate;
      return { title: 'Fetched', tags: [] };
    },
  });

  const created = await coordinator.createJob({ provider: 'anilist', apply: false });
  while (calls === 0) await Promise.resolve();
  const cancelled = await coordinator.cancelJob(created.jobId);
  assert.equal(cancelled, true);
  release();
  await coordinator.waitForIdle();

  assert.equal(store.getMetadataJob(created.jobId).status, 'cancelled');
  assert.equal(calls, 1);
});

test('unknown metadata providers are rejected instead of falling back to AniList', async () => {
  const { store, runtimeConfig } = await createStore();
  const coordinator = new MetadataJobCoordinator(store, runtimeConfig);
  await assert.rejects(
    coordinator.createJob({ provider: 'not-registered' }),
    /unknown metadata provider/i,
  );
});

test('metadata jobs enforce a total deadline and stop starting new provider calls', async () => {
  const { store, runtimeConfig } = await createStore();
  runtimeConfig.metadataScraper.jobDeadlineMs = 20;
  let calls = 0;
  const coordinator = new MetadataJobCoordinator(store, runtimeConfig, {
    scrape(_series, { signal }) {
      calls += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });

  const created = await coordinator.createJob({ provider: 'anilist', apply: false });
  await coordinator.waitForIdle();

  assert.equal(store.getMetadataJob(created.jobId).status, 'cancelled');
  assert.equal(calls, 1);
});
