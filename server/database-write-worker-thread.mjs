import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

import { createFtsWriter } from './store-fts.mjs';

const db = new DatabaseSync(workerData.databaseFile);
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
db.exec(`
  CREATE TEMP TABLE next_series_ids(id TEXT PRIMARY KEY) WITHOUT ROWID;
  CREATE TEMP TABLE next_volume_ids(id TEXT PRIMARY KEY) WITHOUT ROWID;
  CREATE TEMP TABLE next_chapter_ids(id TEXT PRIMARY KEY) WITHOUT ROWID;
`);
const fts = createFtsWriter(db);
let active = false;
let counters = {};

const statements = {
  markSeries: db.prepare('INSERT INTO next_series_ids VALUES (?)'),
  markVolume: db.prepare('INSERT INTO next_volume_ids VALUES (?)'),
  markChapter: db.prepare('INSERT INTO next_chapter_ids VALUES (?)'),
};

function prepareCatalogStatements() {
  // Prepared once per connection; these operations run entirely off the HTTP thread.
  return {
    series: db.prepare(`INSERT INTO series (
      id, position, source_key, source_path, source_folder_name, title, author, dir_mtime,
      scan_fingerprint, updated_at, metadata_json, tags_json, cover_source_path, cover_file_name,
      cover_archive_entry_json, volume_count, chapter_count, page_count, total_bytes
    ) VALUES (${Array(19).fill('?').join(',')}) ON CONFLICT(id) DO UPDATE SET
      position=excluded.position, source_key=excluded.source_key, source_path=excluded.source_path,
      source_folder_name=excluded.source_folder_name, title=excluded.title, author=excluded.author,
      dir_mtime=excluded.dir_mtime, scan_fingerprint=excluded.scan_fingerprint, updated_at=excluded.updated_at,
      metadata_json=excluded.metadata_json, tags_json=excluded.tags_json,
      cover_source_path=excluded.cover_source_path, cover_file_name=excluded.cover_file_name,
      cover_archive_entry_json=excluded.cover_archive_entry_json, volume_count=excluded.volume_count,
      chapter_count=excluded.chapter_count, page_count=excluded.page_count, total_bytes=excluded.total_bytes`),
    existingSeries: db.prepare('SELECT id FROM series WHERE id=? AND source_key=?'),
    conflictingSeries: db.prepare('DELETE FROM series WHERE source_key=? AND id<>?'),
    clearCategories: db.prepare('DELETE FROM series_categories WHERE series_id=?'),
    category: db.prepare('INSERT INTO series_categories (series_id,kind,value,position) VALUES (?,?,?,?)'),
    metadata: db.prepare('SELECT title,author,description FROM series_metadata WHERE source_key=?'),
    tags: db.prepare('SELECT value FROM series_tags WHERE source_key=? ORDER BY value COLLATE NOCASE'),
    retainVolumes: db.prepare('INSERT INTO next_volume_ids SELECT id FROM volumes WHERE series_id=?'),
    retainChapters: db.prepare('INSERT INTO next_chapter_ids SELECT id FROM chapters WHERE series_id=?'),
    moveVolumes: db.prepare('UPDATE volumes SET position=-position-1 WHERE series_id=?'),
    moveChapters: db.prepare('UPDATE chapters SET position=-position-1 WHERE series_id=?'),
    volume: db.prepare(`INSERT INTO volumes(id,series_id,position,title,source_path,synthetic) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET series_id=excluded.series_id,position=excluded.position,
      title=excluded.title,source_path=excluded.source_path,synthetic=excluded.synthetic`),
    existingChapter: db.prepare('SELECT series_id,source_key,source_path,page_count,scan_fingerprint FROM chapters WHERE id=?'),
    chapter: db.prepare(`INSERT INTO chapters(id,series_id,volume_id,position,title,source_key,source_path,
      volume_title,page_count,total_bytes,archive_source_json,scan_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET series_id=excluded.series_id,volume_id=excluded.volume_id,
      position=excluded.position,title=excluded.title,source_key=excluded.source_key,
      source_path=excluded.source_path,volume_title=excluded.volume_title,page_count=excluded.page_count,
      total_bytes=excluded.total_bytes,archive_source_json=excluded.archive_source_json,
      scan_fingerprint=excluded.scan_fingerprint`),
    clearPages: db.prepare('DELETE FROM pages WHERE chapter_id=?'),
    page: db.prepare('INSERT INTO pages(chapter_id,position,source_path,size_bytes,mtime_ms,archive_entry_json) VALUES(?,?,?,?,?,?)'),
    issue: db.prepare('INSERT INTO scan_issues(position,message) VALUES(?,?)'),
  };
}

const catalog = prepareCatalogStatements();

function begin(payload) {
  if (active) throw new Error('A catalog transaction is already active');
  db.exec('BEGIN IMMEDIATE');
  active = true;
  counters = { series: 0, pages: 0, reusedChapters: 0, ftsUpdated: 0 };
  db.exec('DELETE FROM next_series_ids; DELETE FROM next_volume_ids; DELETE FROM next_chapter_ids; DELETE FROM scan_issues; DELETE FROM library_state;');
  const { stats } = payload;
  db.prepare(`INSERT INTO library_state(id,last_scan_at,scan_root,series_count,volume_count,
    chapter_count,page_count,total_bytes,categories_json,scan_meta_json) VALUES(1,?,?,?,?,?,?,?,?,?)`).run(
    payload.lastScanAt, payload.scanRoot, stats.seriesCount, stats.volumeCount, stats.chapterCount,
    stats.pageCount, stats.totalBytes, JSON.stringify(stats.categories),
    payload.scanMeta ? JSON.stringify(payload.scanMeta) : null,
  );
}

function writeRecords(records) {
  if (!active) throw new Error('No catalog transaction is active');
  for (const record of records) {
    const { type, value: item } = record;
    if (type === 'series') {
      const existed = catalog.existingSeries.get(item.id, item.sourceKey);
      if (item._reused && !existed) throw new Error(`Cannot reuse missing series ${item.id}`);
      catalog.conflictingSeries.run(item.sourceKey, item.id);
      statements.markSeries.run(item.id);
      catalog.series.run(item.id, record.position, item.sourceKey, item.sourcePath,
        item.sourceFolderName ?? '', item.title, item.author ?? null, item.dirMtime ?? null,
        item.scanFingerprint ?? null, item.updatedAt, JSON.stringify(item.metadata ?? {}),
        JSON.stringify(item.tags ?? []), item.cover?.sourcePath ?? null, item.cover?.fileName ?? null,
        item.cover?.archiveEntry ? JSON.stringify(item.cover.archiveEntry) : null,
        item.counts?.volumes ?? 0, item.counts?.chapters ?? 0, item.counts?.pages ?? 0, item.totalBytes ?? 0);
      catalog.clearCategories.run(item.id);
      for (const kind of ['auto', 'folder']) {
        (item.categories?.[kind] ?? []).forEach((category, index) => catalog.category.run(item.id, kind, category, index));
      }
      // User overrides are read inside this transaction, so queued edits cannot be overwritten by stale snapshots.
      const metadata = catalog.metadata.get(item.sourceKey);
      const tags = catalog.tags.all(item.sourceKey).map((row) => row.value);
      if (fts.refresh(item.id, metadata?.title ?? item.title, metadata?.author ?? item.author,
        metadata?.description, [...(tags.length ? tags : item.tags ?? [])].sort().join(' '))) counters.ftsUpdated += 1;
      if (item._reused) {
        catalog.retainVolumes.run(item.id);
        catalog.retainChapters.run(item.id);
      } else {
        // Move old positions out of the positive range before reordering existing volumes/chapters.
        catalog.moveVolumes.run(item.id);
        catalog.moveChapters.run(item.id);
      }
      counters.series += 1;
    } else if (type === 'volume') {
      statements.markVolume.run(item.id);
      catalog.volume.run(item.id, record.seriesId, record.position, item.title, item.sourcePath, item.synthetic ? 1 : 0);
    } else if (type === 'chapter') {
      if (item._reused) {
        const previous = catalog.existingChapter.get(item.id);
        if (!previous || previous.series_id !== record.seriesId || previous.source_key !== item.sourceKey ||
          previous.source_path !== item.sourcePath || previous.page_count !== item.pageCount ||
          (item.scanFingerprint && previous.scan_fingerprint !== item.scanFingerprint)) {
          throw new Error(`Cannot reuse changed or missing chapter ${item.id}`);
        }
        counters.reusedChapters += 1;
      } else catalog.clearPages.run(item.id);
      statements.markChapter.run(item.id);
      catalog.chapter.run(item.id, record.seriesId, record.volumeId, record.position, item.title,
        item.sourceKey, item.sourcePath, item.volumeTitle ?? record.volumeTitle,
        item.pageCount, item.totalBytes ?? 0, item.archiveSource ? JSON.stringify(item.archiveSource) : null,
        item.scanFingerprint ?? null);
    } else if (type === 'page') {
      catalog.page.run(record.chapterId, item.index, item.sourcePath, item.sizeBytes ?? 0,
        item.mtimeMs ?? 0, item.archiveEntry ? JSON.stringify(item.archiveEntry) : null);
      counters.pages += 1;
    } else if (type === 'issue') catalog.issue.run(record.position, item);
    else throw new Error(`Unknown catalog record ${type}`);
  }
  return { accepted: records.length };
}

function commit() {
  if (!active) throw new Error('No catalog transaction is active');
  db.exec(`
    DELETE FROM chapters WHERE id NOT IN (SELECT id FROM next_chapter_ids);
    DELETE FROM volumes WHERE id NOT IN (SELECT id FROM next_volume_ids);
    DELETE FROM series WHERE id NOT IN (SELECT id FROM next_series_ids);
  `);
  fts.removeMissing();
  // Publishing a scan changes the feature set and the public catalog in the same transaction.
  db.prepare("UPDATE app_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key IN ('revision', 'catalog_revision')").run();
  const revision = Number(db.prepare("SELECT value FROM app_meta WHERE key='revision'").get().value);
  db.exec('COMMIT');
  active = false;
  return { revision, ...counters };
}

function rollback() {
  if (active) db.exec('ROLLBACK');
  active = false;
}

parentPort.on('message', ({ id, operation, payload }) => {
  try {
    let result;
    if (operation === 'begin') result = begin(payload);
    else if (operation === 'batch') result = writeRecords(payload);
    else if (operation === 'commit') result = commit();
    else if (operation === 'rollback') result = rollback();
    else if (operation === 'ping') result = { ok: true };
    else if (operation === 'close') { rollback(); db.close(); }
    else throw new Error(`Unknown database write operation: ${operation}`);
    parentPort.postMessage({ id, result });
    if (operation === 'close') parentPort.close();
  } catch (error) {
    rollback();
    parentPort.postMessage({ id, error: { message: error.message, code: error.code } });
  }
});
parentPort.postMessage({ ready: true });
