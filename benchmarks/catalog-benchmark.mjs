import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';

import { AppStore } from '../server/store.mjs';

const SERIES_COUNT = 50_000;
const PAGE_SIZE = 80;
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-benchmark-'));
const dataDir = path.join(tempRoot, 'data');
const config = {
  dataDir,
  databaseFile: path.join(dataDir, 'app.sqlite'),
  resourceProfile: { databaseQueueLimit: 64 },
  defaultSettings: {
    libraryRoot: path.join(tempRoot, 'library'),
    scanIntervalMinutes: 0,
    folderPattern: { enabled: false, separator: '-', titleSegmentIndex: 0, stripTokens: [] },
    naming: { defaultVolumeName: 'Default Volume', directImageChapterTemplate: '{count}P' },
    categoryFolders: [],
  },
};

const store = new AppStore(config);
await store.init();
const db = store.getDatabase();
const insertSeries = db.prepare(`
  INSERT INTO series (
    id, position, source_key, source_path, source_folder_name, title, author,
    dir_mtime, scan_fingerprint, updated_at, metadata_json, tags_json,
    cover_source_path, cover_file_name, volume_count, chapter_count, page_count, total_bytes
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '[]', NULL, NULL, 0, 1, 20, 1000)
`);
const insertFts = db.prepare('INSERT INTO series_fts (series_id, title, author, description, tags) VALUES (?, ?, ?, ?, ?)');
const insertCategory = db.prepare('INSERT INTO series_categories (series_id, kind, value, position) VALUES (?, ?, ?, ?)');

db.exec('BEGIN IMMEDIATE');
try {
  db.prepare(`
    INSERT INTO library_state (
      id, last_scan_at, scan_root, series_count, volume_count, chapter_count,
      page_count, total_bytes, categories_json, scan_meta_json
    ) VALUES (1, ?, ?, ?, 0, ?, ?, ?, '["Featured"]', NULL)
  `).run('2026-08-09T00:00:00.000Z', config.defaultSettings.libraryRoot, SERIES_COUNT, SERIES_COUNT, SERIES_COUNT * 20, SERIES_COUNT * 1000);

  for (let index = 0; index < SERIES_COUNT; index += 1) {
    const id = `series-${index.toString().padStart(5, '0')}`;
    const title = `Title ${index.toString().padStart(5, '0')}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
    insertSeries.run(id, index, id, `/library/${id}`, id, title, 'Author', updatedAt, `fp-${index}`, updatedAt);
    insertFts.run(id, title, 'Author', index % 11 === 0 ? 'needle' : '', index % 7 === 0 ? 'tagged' : '');
    if (index % 10 === 0) insertCategory.run(id, 'folder', 'Featured', 0);
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

function plan(sql, ...parameters) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters).map((row) => row.detail).join('\n');
}

assert.match(plan('SELECT id FROM series ORDER BY title COLLATE NOCASE, id LIMIT 80'), /series_title_idx/);
assert.match(plan('SELECT id FROM series ORDER BY updated_at DESC, id LIMIT 80'), /series_updated_at_idx/);
assert.match(plan('SELECT series_id FROM series_categories WHERE value = ? COLLATE NOCASE', 'Featured'), /series_categories_value_idx/);
assert.match(plan('SELECT series_id FROM series_fts WHERE series_fts MATCH ?', 'needle'), /VIRTUAL TABLE INDEX/);

const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
const durations = [];
const queries = [
  {},
  { sort: 'updatedAt', order: 'desc' },
  { search: 'needle' },
  { category: 'Featured' },
];
for (let iteration = 0; iteration < 24; iteration += 1) {
  const startedAt = performance.now();
  const result = await store.querySeriesPageAsync(queries[iteration % queries.length], {
    page: (iteration % 5) + 1,
    pageSize: PAGE_SIZE,
  });
  durations.push(performance.now() - startedAt);
  assert.ok(result.items.length <= PAGE_SIZE);
}
await new Promise((resolve) => setTimeout(resolve, 25));
lag.disable();

durations.sort((left, right) => left - right);
const p95Ms = durations[Math.ceil(durations.length * 0.95) - 1];
const eventLoopP99Ms = lag.percentile(99) / 1e6;
assert.ok(p95Ms <= 200, `list p95 ${p95Ms.toFixed(2)}ms exceeds 200ms`);
assert.ok(eventLoopP99Ms <= 50, `event-loop p99 ${eventLoopP99Ms.toFixed(2)}ms exceeds 50ms`);

console.log(JSON.stringify({ series: SERIES_COUNT, pageSize: PAGE_SIZE, p95Ms, eventLoopP99Ms }));
await store.close();
await fs.rm(tempRoot, { recursive: true, force: true });
