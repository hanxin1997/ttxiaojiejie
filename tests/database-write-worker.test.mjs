import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { initializeStoreSchema } from '../server/store-schema.mjs';
import { DatabaseWriteWorker } from '../server/database-write-worker.mjs';

async function setup(t, options) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-write-worker-'));
  const file = path.join(dir, 'catalog.sqlite');
  const db = new DatabaseSync(file);
  initializeStoreSchema(db);
  const worker = new DatabaseWriteWorker(file, options);
  t.after(async () => { await worker.close(); db.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { db, worker };
}

function library(pageCount = 1200) {
  return {
    lastScanAt: '2026-11-05T00:00:00Z', scanRoot: '/library',
    stats: { seriesCount: 1, volumeCount: 1, chapterCount: 1, pageCount, totalBytes: pageCount, categories: [] },
    issues: [], scanMeta: null,
    series: [{ id: 's', sourceKey: 's', sourcePath: '/library/s', title: 'Title',
      categories: { auto: [], folder: [] }, counts: { volumes: 1, chapters: 1, pages: pageCount },
      volumes: [{ id: 'v', title: 'Volume', sourcePath: '/library/s', synthetic: false,
        chapters: [{ id: 'c', title: 'Chapter', sourceKey: 's/c', sourcePath: '/library/s/c', pageCount,
          pages: Array.from({ length: pageCount }, (_, index) => ({ index: index + 1, sourcePath: `/library/s/c/${index}.jpg`, sizeBytes: 1 })) }] }] }],
  };
}

test('writer bounds page batches, acknowledges serially and exposes only committed revisions', async (t) => {
  const { db, worker } = await setup(t, { batchRows: 25, batchBytes: 8192 });
  await worker.start();
  const observedCounts = new Set();
  const observedRevisions = new Set();
  let turns = 0;
  const sample = setInterval(() => {
    turns += 1;
    observedCounts.add(db.prepare('SELECT count(*) AS n FROM pages').get().n);
    observedRevisions.add(db.prepare("SELECT value FROM app_meta WHERE key='revision'").get().value);
  }, 1);
  try {
    const result = await worker.replaceLibrary(library());
    assert.equal(result.pages, 1200);
    assert.equal(result.revision, 1);
  } finally { clearInterval(sample); }
  assert.ok(turns > 0, 'HTTP/event-loop tasks must make progress while SQLite writes');
  assert.ok([...observedCounts].every((count) => count === 0 || count === 1200));
  assert.ok([...observedRevisions].every((revision) => revision === '0' || revision === '1'));
  const metrics = worker.getMetrics();
  assert.ok(metrics.batches > 1);
  assert.ok(metrics.peakBatchRows <= 25);
  assert.ok(metrics.peakBatchBytes <= 8192);
  assert.equal(metrics.pending, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM pages').get().n, 1200);
});

test('worker serialization failure rolls back and the next catalog write succeeds', async (t) => {
  const { db, worker } = await setup(t, { batchRows: 1 });
  await worker.replaceLibrary(library(2));
  const invalid = library(3);
  invalid.series[0].volumes[0].chapters[0].pages[2].sizeBytes = 1n;
  await assert.rejects(worker.replaceLibrary(invalid), /BigInt/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM pages').get().n, 2);
  assert.equal(db.prepare("SELECT value FROM app_meta WHERE key='revision'").get().value, '1');
  await worker.replaceLibrary(library(4));
  assert.equal(db.prepare('SELECT count(*) AS n FROM pages').get().n, 4);
  assert.equal(worker.getMetrics().failed, 1);
});

test('chapter reuse refuses unknown sources and preserves the previously committed catalog', async (t) => {
  const { db, worker } = await setup(t);
  await worker.replaceLibrary(library(2));
  const invalid = library(2);
  const chapter = invalid.series[0].volumes[0].chapters[0];
  chapter._reused = true;
  chapter.pages = [];
  chapter.sourceKey = 'other-source';
  await assert.rejects(worker.replaceLibrary(invalid), /Cannot reuse/);
  assert.equal(db.prepare('SELECT source_key FROM chapters').get().source_key, 's/c');
  assert.equal(db.prepare('SELECT count(*) AS n FROM pages').get().n, 2);
});
