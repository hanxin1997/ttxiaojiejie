import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { AppStore } from '../server/store.mjs';
import { STORE_SCHEMA_VERSION } from '../server/store-schema.mjs';

function createConfig(rootDir, libraryRoot) {
  return {
    dataDir: path.join(rootDir, 'data'),
    stateFile: path.join(rootDir, 'data', 'state.json'),
    databaseFile: path.join(rootDir, 'data', 'app.sqlite'),
    defaultSettings: {
      libraryRoot,
      scanIntervalMinutes: 15,
      autoExportToMihon: false,
      scanMode: 'flat',
      folderPattern: {
        enabled: true,
        separator: '-',
        authorSegmentIndex: 0,
        titleSegmentIndex: 1,
        categorySegmentIndex: 2,
        stripTokens: ['images'],
      },
      naming: {
        defaultVolumeName: 'Default Volume',
        directImageChapterTemplate: '{count}P',
      },
      categoryFolders: [],
    },
  };
}

function createLibrary() {
  return {
    lastScanAt: '2026-08-09T00:00:00.000Z',
    scanRoot: '/library',
    stats: {
      seriesCount: 1,
      volumeCount: 0,
      chapterCount: 1,
      pageCount: 2,
      totalBytes: 30,
      categories: ['Featured'],
    },
    issues: ['one recoverable issue'],
    scanMeta: { scannedCount: 1, reusedCount: 0 },
    series: [
      {
        id: 'series-1',
        sourceKey: 'series/a',
        sourcePath: '/library/series/a',
        sourceFolderName: 'a',
        title: 'Alpha',
        author: 'Alice',
        dirMtime: '2026-08-09T00:00:00.000Z',
        scanFingerprint: 'fingerprint-a',
        updatedAt: '2026-08-09T00:00:00.000Z',
        metadata: {},
        tags: [],
        categories: {
          auto: [],
          folder: ['Featured'],
          manual: [],
          effective: ['Featured'],
        },
        cover: { sourcePath: '/library/series/a/1.jpg', fileName: '1.jpg' },
        counts: { volumes: 0, chapters: 1, pages: 2 },
        totalBytes: 30,
        volumes: [
          {
            id: 'volume-1',
            title: 'Default Volume',
            sourcePath: '/library/series/a',
            synthetic: true,
            chapters: [
              {
                id: 'chapter-1',
                title: '2P',
                sourceKey: 'series/a/Default Volume/@root',
                sourcePath: '/library/series/a',
                volumeTitle: 'Default Volume',
                pageCount: 2,
                totalBytes: 30,
                pages: [
                  { id: 'page-1', index: 1, fileName: '1.jpg', sourcePath: '/library/series/a/1.jpg', sizeBytes: 10, mtimeMs: 1 },
                  { id: 'page-2', index: 2, fileName: '2.jpg', sourcePath: '/library/series/a/2.jpg', sizeBytes: 20, mtimeMs: 2 },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

async function createStore(prefix = 'folder-library-store-v2-') {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const libraryRoot = path.join(tempRoot, 'library');
  await fs.mkdir(libraryRoot, { recursive: true });
  const config = createConfig(tempRoot, libraryRoot);
  const store = new AppStore(config);
  await store.init();
  return { store, config, tempRoot };
}

test('AppStore creates the normalized performance schema with SQLite safety pragmas', async () => {
  const { store } = await createStore();
  const db = store.getDatabase();
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all().map((row) => row.name),
  );

  assert.equal(db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value, String(STORE_SCHEMA_VERSION));
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.ok(tables.has('series'));
  assert.ok(tables.has('volumes'));
  assert.ok(tables.has('chapters'));
  assert.ok(tables.has('pages'));
  assert.ok(tables.has('metadata_jobs'));
  assert.equal(tables.has('app_state'), false);
});

test('AppStore destroys an incompatible app_state database instead of migrating it', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-store-reset-'));
  const libraryRoot = path.join(tempRoot, 'library');
  const config = createConfig(tempRoot, libraryRoot);
  await fs.mkdir(config.dataDir, { recursive: true });
  const legacyDb = new DatabaseSync(config.databaseFile);
  legacyDb.exec('CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  legacyDb.prepare('INSERT INTO app_state VALUES (?, ?)').run('library', '{"series":[{"id":"legacy"}]}');
  legacyDb.close();

  const store = new AppStore(config);
  await store.init();

  const db = store.getDatabase();
  assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'app_state'").get().count, 0);
  assert.equal(store.getLibrary().series.length, 0);
});

test('AppStore stores and reloads a catalog through normalized relation tables', async () => {
  const { store, config } = await createStore();
  await store.replaceLibrary(createLibrary());

  const db = store.getDatabase();
  assert.equal(db.prepare('SELECT count(*) AS count FROM series').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM chapters').get().count, 1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM pages').get().count, 2);
  await store.close();

  const reloaded = new AppStore(config);
  await reloaded.init();
  const series = reloaded.getSeriesById('series-1');
  assert.equal(series.title, 'Alpha');
  assert.equal(series.volumes[0].chapters[0].pages.length, 0);
  assert.equal((await reloaded.queryChapterPageAsync('chapter-1', 2)).sourcePath, '/library/series/a/2.jpg');
  assert.equal(reloaded.findChapterById('chapter-1').pageCount, 2);
  await reloaded.close();
});

test('v4 upgrade preserves settings, overrides, progress and existing image pages', async (t) => {
  const { store, config, tempRoot } = await createStore('folder-library-v4-upgrade-');
  let reopened;
  t.after(async () => {
    await reopened?.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
  await store.replaceLibrary(createLibrary());
  await store.replaceSettings({ scanIntervalMinutes: 37 });
  await store.toggleFavorite('series/a');
  await store.setSeriesCategories('series/a', ['My category']);
  await store.setMetadata('series/a', { title: 'My title', author: 'My author' });
  await store.setTags('series/a', ['My tag']);
  await store.setCustomCover('series/a', 'chapter-1', 2);
  await store.setReadProgress('series/a', { chapterId: 'chapter-1', pageIndex: 1, totalPages: 2 });
  const overrides = store.getOverrides();
  const revision = store.revision;
  await store.close();

  // 移除仅 v5 新增的两列，得到真实的旧关系表布局及已有用户数据。
  const previous = new DatabaseSync(config.databaseFile);
  previous.exec('ALTER TABLE pages DROP COLUMN archive_entry_json');
  previous.exec('ALTER TABLE series DROP COLUMN cover_archive_entry_json');
  previous.exec('ALTER TABLE chapters DROP COLUMN archive_source_json');
  previous.exec('ALTER TABLE chapters DROP COLUMN scan_fingerprint');
  previous.exec('DROP TABLE series_fts_documents');
  previous.prepare("UPDATE app_meta SET value = '4' WHERE key = 'schema_version'").run();
  previous.close();

  reopened = new AppStore(config);
  await reopened.init();
  assert.equal(reopened.getSettings().scanIntervalMinutes, 37);
  assert.deepEqual(reopened.getOverrides(), overrides);
  assert.equal(reopened.revision, revision);
  assert.equal((await reopened.queryChapterPageAsync('chapter-1', 2)).sourcePath, '/library/series/a/2.jpg');
  assert.equal((await reopened.queryChapterPageAsync('chapter-1', 2)).archiveEntry, null);
  assert.equal(reopened.getDatabase().prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get().value, String(STORE_SCHEMA_VERSION));
});

test('archive page and cover descriptors survive restart and consecutive reused scans', async (t) => {
  const { store, config, tempRoot } = await createStore('folder-library-archive-store-');
  let active = store;
  t.after(async () => {
    await active.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
  const library = createLibrary();
  const series = library.series[0];
  const chapter = series.volumes[0].chapters[0];
  chapter.sourcePath = '/library/series/a/漫画.cbz';
  chapter.pages = chapter.pages.map((page, index) => ({
    ...page,
    sourcePath: chapter.sourcePath,
    archiveEntry: {
      version: 1, index, name: `${index + 1}.jpg`, crc32: index + 1,
      compressedSize: 10, uncompressedSize: page.sizeBytes, compressionMethod: 8,
      archiveIdentity: { size: 150, mtimeMs: 1, ctimeMs: 2 },
    },
  }));
  series.cover = { ...chapter.pages[0], fileName: '1.jpg' };
  await store.replaceLibrary(library);
  await store.close();
  active = new AppStore(config);
  await active.init();

  for (let scan = 0; scan < 2; scan += 1) {
    const reused = active.getLibrary();
    assert.equal(reused.series[0].volumes[0].chapters[0].pages.length, 0);
    reused.series[0]._reused = true;
    await active.replaceLibrary(reused);
    assert.deepEqual((await active.queryChapterPageAsync(chapter.id, 2)).archiveEntry, chapter.pages[1].archiveEntry);
    assert.deepEqual((await active.queryCoverPathAsync(series.id)).archiveEntry, series.cover.archiveEntry);
  }
  const detail = await active.querySeriesDetailAsync(series.id);
  assert.equal(detail.counts.pages, 2);
  assert.doesNotMatch(JSON.stringify(detail), /archiveEntry|archiveIdentity|sourcePath/);
});

test('rescans ignore obsolete page overrides without deleting them and use current chapter length', async (t) => {
  const { store, tempRoot } = await createStore('folder-library-obsolete-cover-');
  t.after(async () => {
    await store.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
  await store.replaceLibrary(createLibrary());
  await store.setCustomCover('series/a', 'chapter-1', 2);
  await store.setReadProgress('series/a', { chapterId: 'chapter-1', pageIndex: 2, totalPages: 2 });

  const library = createLibrary();
  library.series[0].volumes[0].chapters[0].id = 'cbz-chapter';
  await store.replaceLibrary(library);
  assert.equal(store.getCustomCover('series/a'), null);
  assert.equal(store.getReadProgress('series/a'), null);
  assert.equal(store.getOverrides().customCovers['series/a'].chapterId, 'chapter-1');
  assert.equal(store.getOverrides().readProgress['series/a'].chapterId, 'chapter-1');
  for (const query of [
    () => store.querySeriesPage({}, { page: 1, pageSize: 10 }),
    () => store.querySeriesPageAsync({}, { page: 1, pageSize: 10 }),
  ]) {
    const item = (await query()).items[0];
    assert.equal(item.coverUrl, '/media/cover/series-1');
    assert.equal(item.readProgress, null);
    assert.equal(item.readStatus, 'unread');
  }
  assert.equal((await store.querySeriesPageAsync({ readStatus: 'unread' }, { page: 1, pageSize: 10 })).total, 1);

  await store.setReadProgress('series/a', { chapterId: 'cbz-chapter', pageIndex: 1, totalPages: 1 });
  const current = (await store.querySeriesPageAsync({}, { page: 1, pageSize: 10 })).items[0];
  assert.equal(current.readProgress.totalPages, 2);
  assert.equal(current.readStatus, 'reading');
  assert.equal(store.getReadProgress('series/a').totalPages, 2);
});

test('reused scanner summaries preserve database pages without retaining page snapshots in memory', async () => {
  const { store } = await createStore('folder-library-store-reused-');
  const initial = createLibrary();
  await store.replaceLibrary(initial);
  assert.equal(store.getLibraryRef().series[0].volumes[0].chapters[0].pages.length, 0);

  const reused = createLibrary();
  reused.series[0]._reused = true;
  reused.series[0].volumes[0].chapters[0].pages = [];
  await store.replaceLibrary(reused);

  assert.equal(store.getDatabase().prepare('SELECT count(*) AS count FROM pages').get().count, 2);
  assert.equal((await store.queryChapterPageAsync('chapter-1', 2)).sourcePath, '/library/series/a/2.jpg');
  await store.close();
});

test('AppStore serves bounded list queries through its dedicated database worker', async () => {
  const { store } = await createStore('folder-library-store-worker-');
  await store.replaceLibrary(createLibrary());

  const result = await store.querySeriesPageAsync({}, { page: 1, pageSize: 40 });
  const metrics = store.getDatabaseWorkerMetrics();

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, 'Alpha');
  assert.equal(result.revision, 1);
  const detail = await store.querySeriesDetailAsync('series-1');
  const chapterPages = await store.queryChapterPagesAsync('chapter-1');
  const mediaPage = await store.queryChapterPageAsync('chapter-1', 2);
  assert.equal(detail.volumes[0].chapters[0].pageCount, 2);
  assert.equal('sourcePath' in detail, false);
  assert.deepEqual(chapterPages, {
    chapterId: 'chapter-1',
    pageCount: 2,
    urlTemplate: '/media/chapter/chapter-1/{pageIndex}',
  });
  assert.equal(mediaPage.sourcePath, '/library/series/a/2.jpg');
  assert.equal(metrics.completed >= 1, true);
  assert.equal(metrics.pending, 0);
  await store.close();
});

test('catalog revision is monotonic across scans and user-visible mutations', async () => {
  const { store, config } = await createStore('folder-library-store-revision-');
  assert.equal(store.getLibrarySummary().revision, 0);

  await store.replaceLibrary(createLibrary());
  const scanRevision = store.getLibrarySummary().revision;
  assert.equal(scanRevision, 1);

  await store.setTags('series/a', ['low-memory']);
  await store.setSeriesCategories('series/a', ['Manual']);
  const mutationRevision = store.getLibrarySummary().revision;
  assert.equal(mutationRevision, 3);
  assert.deepEqual(store.getAllCategories(), ['Featured', 'Manual']);
  assert.equal((await store.querySeriesPageAsync({}, { page: 1, pageSize: 40 })).revision, 3);

  await store.close();
  const reloaded = new AppStore(config);
  await reloaded.init();
  assert.equal(reloaded.getLibrarySummary().revision, 3);
  await reloaded.close();
});

test('database worker rejects requests beyond its configured bounded queue', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-store-worker-bound-'));
  const libraryRoot = path.join(tempRoot, 'library');
  await fs.mkdir(libraryRoot, { recursive: true });
  const config = createConfig(tempRoot, libraryRoot);
  config.resourceProfile = { databaseQueueLimit: 1 };
  const store = new AppStore(config);
  await store.init();
  await store.replaceLibrary(createLibrary());

  const first = store.querySeriesPageAsync({}, { page: 1, pageSize: 40 });
  await assert.rejects(
    store.querySeriesPageAsync({}, { page: 1, pageSize: 40 }),
    /queue is full/i,
  );
  await first;
  await store.close();
});

test('single-row overrides do not rewrite or remove catalog pages', async () => {
  const { store } = await createStore();
  await store.replaceLibrary(createLibrary());
  const db = store.getDatabase();
  const beforePages = db.prepare('SELECT chapter_id, position, source_path FROM pages ORDER BY position').all();

  await store.setMetadata('series/a', { title: 'Custom Alpha', author: 'Updated Alice' });
  await store.setTags('series/a', ['tag-a', 'tag-b']);
  await store.toggleFavorite('series/a');
  await store.setReadProgress('series/a', { chapterId: 'chapter-1', pageIndex: 2, totalPages: 2 });

  assert.deepEqual(
    db.prepare('SELECT chapter_id, position, source_path FROM pages ORDER BY position').all(),
    beforePages,
  );
  assert.deepEqual(store.getMetadata('series/a'), { title: 'Custom Alpha', author: 'Updated Alice' });
  assert.deepEqual(store.getTags('series/a'), ['tag-a', 'tag-b']);
  assert.equal(store.isFavorite('series/a'), true);
  assert.equal(store.getReadProgress('series/a').pageIndex, 2);
});

test('AppStore persists settings without exposing legacy backup compatibility', async () => {
  const { store, config } = await createStore();
  await store.replaceCategoryFolders([{ name: 'Featured', folder: 'featured' }]);
  await store.setTags('series/a', ['tag-a']);
  assert.equal(typeof store.createBackupSnapshot, 'undefined');
  assert.equal(typeof store.importBackup, 'undefined');
  await store.close();

  const reloaded = new AppStore(config);
  await reloaded.init();
  assert.deepEqual(reloaded.getSettings().categoryFolders, [{ name: 'Featured', folder: 'featured' }]);
  assert.deepEqual(reloaded.getTags('series/a'), ['tag-a']);
  await reloaded.close();
});

test('concurrent queued metadata and tags publish their combined FTS content', async (t) => {
  const { store, tempRoot } = await createStore('folder-library-write-publication-');
  t.after(async () => { await store.close(); await fs.rm(tempRoot, { recursive: true, force: true }); });
  await store.replaceLibrary(createLibrary());
  await Promise.all([
    store.setMetadata('series/a', { title: 'Concurrent Title' }),
    store.setTags('series/a', ['concurrenttag']),
  ]);
  const row = store.getDatabase().prepare('SELECT title,tags FROM series_fts').get();
  assert.equal(row.title, 'Concurrent Title');
  assert.equal(row.tags, 'concurrenttag');
});

test('concurrent favorite toggles preserve sequential toggle semantics', async (t) => {
  const { store, tempRoot } = await createStore('folder-library-toggle-queue-');
  t.after(async () => { await store.close(); await fs.rm(tempRoot, { recursive: true, force: true }); });
  await store.replaceLibrary(createLibrary());
  await Promise.all([store.toggleFavorite('series/a'), store.toggleFavorite('series/a')]);
  assert.equal(store.isFavorite('series/a'), false);
});

test('v5 migration preserves catalog, FTS rowids and overrides while removing redundant indexes', async (t) => {
  const { store, config, tempRoot } = await createStore('folder-library-v5-upgrade-');
  let active = store;
  t.after(async () => { await active.close(); await fs.rm(tempRoot, { recursive: true, force: true }); });
  await store.replaceLibrary(createLibrary());
  await store.setMetadataAndTags('series/a', { title: 'Migrated Title' }, ['migrationtag']);
  await store.toggleFavorite('series/a');
  const before = store.getOverrides();
  const rowid = store.getDatabase().prepare('SELECT rowid FROM series_fts').get().rowid;
  await store.close();
  const old = new DatabaseSync(config.databaseFile);
  old.exec(`
    ALTER TABLE chapters DROP COLUMN archive_source_json;
    ALTER TABLE chapters DROP COLUMN scan_fingerprint;
    DROP TABLE series_fts_documents;
    CREATE INDEX volumes_series_idx ON volumes(series_id,position);
    CREATE INDEX chapters_volume_idx ON chapters(volume_id,position);
    CREATE INDEX pages_chapter_idx ON pages(chapter_id,position);
    UPDATE app_meta SET value='5' WHERE key='schema_version';
  `);
  old.close();
  active = new AppStore(config);
  await active.init();
  assert.deepEqual(active.getOverrides(), before);
  assert.equal(active.getDatabase().prepare('SELECT document_id FROM series_fts_documents').get().document_id, rowid);
  assert.equal((await active.querySeriesPageAsync({ search: 'migrationtag' }, { page: 1, pageSize: 10 })).total, 1);
  for (const [table, removed] of [['volumes', 'volumes_series_idx'], ['chapters', 'chapters_volume_idx'], ['pages', 'pages_chapter_idx']]) {
    const indexes = active.getDatabase().prepare(`PRAGMA index_list(${table})`).all();
    assert.equal(indexes.some((index) => index.name === removed), false);
    assert.ok(indexes.some((index) => index.unique));
  }
  assert.match(active.getDatabase().prepare('EXPLAIN QUERY PLAN SELECT * FROM pages WHERE chapter_id=? AND position=?').all('chapter-1', 1).map((row) => row.detail).join(' '), /sqlite_autoindex_pages/);
});

test('unchanged scans preserve FTS rows and single or batch edits use the stable mapping', async (t) => {
  const { store, tempRoot } = await createStore('folder-library-fts-stable-');
  t.after(async () => { await store.close(); await fs.rm(tempRoot, { recursive: true, force: true }); });
  await store.replaceLibrary(createLibrary());
  const db = store.getDatabase();
  const firstRow = db.prepare('SELECT rowid,* FROM series_fts').get();
  const reused = store.getLibrary();
  reused.series[0]._reused = true;
  await store.replaceLibrary(reused);
  assert.equal(store.getDatabaseWriteWorkerMetrics().lastWrite.ftsUpdated, 0);
  assert.deepEqual(db.prepare('SELECT rowid,* FROM series_fts').get(), firstRow);
  const revision = store.revision;
  await store.batchSetTags(['series/a'], ['beta', 'alpha']);
  assert.equal(store.revision, revision + 1);
  assert.equal(db.prepare('SELECT rowid FROM series_fts').get().rowid, firstRow.rowid);
  await store.batchSetTags(['series/a'], ['gamma']);
  assert.deepEqual(new Set(store.getTags('series/a')), new Set(['alpha', 'beta', 'gamma']));
  await store.batchSetTags(['series/a'], ['replacement'], { mode: 'replace' });
  await store.setMetadataAndTags('series/a', { title: 'Stable Title' }, ['lasttag']);
  assert.equal(db.prepare('SELECT rowid FROM series_fts').get().rowid, firstRow.rowid);
  assert.equal((await store.querySeriesPageAsync({ search: 'lasttag' }, { page: 1, pageSize: 10 })).total, 1);
  await store.replaceLibrary({ ...createLibrary(), series: [], stats: { seriesCount: 0 } });
  assert.equal(db.prepare('SELECT count(*) AS n FROM series_fts').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM series_fts_documents').get().n, 0);
});

test('chapter archive identity survives restart and mixed reused/new chapter replacement', async (t) => {
  const { store, config, tempRoot } = await createStore('folder-library-chapter-reuse-');
  let active = store;
  t.after(async () => { await active.close(); await fs.rm(tempRoot, { recursive: true, force: true }); });
  const library = createLibrary();
  const chapter = library.series[0].volumes[0].chapters[0];
  chapter.scanFingerprint = 'cbz-chapter-v1:stable';
  chapter.archiveSource = { version: 1, identity: { size: 30, mtimeMs: 1, ctimeMs: 2 }, firstPage: chapter.pages[0], latestPageMtime: 2 };
  await store.replaceLibrary(library);
  await store.close();
  active = new AppStore(config);
  await active.init();
  const next = active.getLibrary();
  const original = next.series[0].volumes[0].chapters[0];
  assert.deepEqual(original.archiveSource, chapter.archiveSource);
  assert.equal(original.scanFingerprint, chapter.scanFingerprint);
  original._reused = true;
  const newChapter = { ...chapter, id: 'chapter-2', sourceKey: 'series/a/new', title: 'New', scanFingerprint: null,
    archiveSource: null, pages: [{ ...chapter.pages[0], sourcePath: '/library/new.jpg' }], pageCount: 1 };
  // Reorder retained and inserted chapters: temporary negative positions prevent UNIQUE collisions.
  next.series[0].volumes[0].chapters = [newChapter, original];
  await active.replaceLibrary(next);
  assert.equal((await active.queryChapterPageAsync('chapter-1', 2)).sourcePath, chapter.pages[1].sourcePath);
  assert.equal((await active.queryChapterPageAsync('chapter-2', 1)).sourcePath, '/library/new.jpg');
  assert.equal(active.getDatabaseWriteWorkerMetrics().lastWrite.reusedChapters, 1);
  assert.equal('_reused' in active.findChapterById('chapter-1'), false);
  assert.equal(active.findChapterById('chapter-1').pages.length, 0);
});

test('failed scan rolls back pages, FTS and revision and leaves the published snapshot intact', async (t) => {
  const { store, tempRoot } = await createStore('folder-library-write-rollback-');
  t.after(async () => { await store.close(); await fs.rm(tempRoot, { recursive: true, force: true }); });
  await store.replaceLibrary(createLibrary());
  const revision = store.revision;
  const previous = store.getLibraryRef();
  const invalid = createLibrary();
  invalid.series[0].title = 'Uncommitted';
  invalid.series[0].volumes[0].chapters[0].pages.push({ ...invalid.series[0].volumes[0].chapters[0].pages[0] });
  await assert.rejects(store.replaceLibrary(invalid), /UNIQUE constraint/i);
  assert.equal(store.getLibraryRef(), previous);
  assert.equal(store.revision, revision);
  assert.equal(store.getDatabase().prepare('SELECT title FROM series_fts').get().title, 'Alpha');
  assert.equal(store.getDatabase().prepare('SELECT count(*) AS n FROM pages').get().n, 2);
  await store.setTags('series/a', ['recovered']);
  assert.equal(store.revision, revision + 1);
});

test('scan commits before queued user changes and close drains all accepted writes', async (t) => {
  const { store, config, tempRoot } = await createStore('folder-library-close-drain-');
  let reopened;
  t.after(async () => { await store.close(); await reopened?.close(); await fs.rm(tempRoot, { recursive: true, force: true }); });
  const scan = store.replaceLibrary(createLibrary());
  const tags = store.setTags('series/a', ['after-scan']);
  const progress = store.setReadProgress('series/a', { chapterId: 'chapter-1', pageIndex: 1, totalPages: 2 });
  const close = store.close();
  await assert.rejects(store.setTags('series/a', ['too-late']), /closing/);
  await Promise.all([scan, tags, progress, close]);
  reopened = new AppStore(config);
  await reopened.init();
  assert.deepEqual(reopened.getTags('series/a'), ['after-scan']);
  assert.equal(reopened.getReadProgress('series/a').pageIndex, 1);
  assert.equal(reopened.revision, 3);
});

test('scanner to store to restart retains unchanged CBZ pages when a sibling archive changes', async (t) => {
  const { scanLibrary } = await import('../server/scanner.mjs');
  const { store, config, tempRoot } = await createStore('folder-library-scan-store-cbz-');
  let active = store;
  t.after(async () => { await active.close(); await fs.rm(tempRoot, { recursive: true, force: true }); });
  const seriesRoot = path.join(config.defaultSettings.libraryRoot, 'work');
  await fs.mkdir(seriesRoot, { recursive: true });
  const first = path.join(seriesRoot, '1.cbz');
  const second = path.join(seriesRoot, '2.cbz');
  await fs.writeFile(first, 'first archive boundary fixture');
  await fs.writeFile(second, 'second archive boundary fixture');
  const counts = new Map([[first, 2], [second, 1]]);
  const indexed = [];
  // ZIP parsing has its own integration suite; this tests scanner/store identity and persistence contracts.
  const listArchivePages = async (sourcePath) => {
    indexed.push(sourcePath);
    const stat = await fs.stat(sourcePath);
    return Array.from({ length: counts.get(sourcePath) }, (_, index) => ({
      sourcePath, relativePath: `${index + 1}.jpg`, sizeBytes: 10, mtimeMs: stat.mtimeMs,
      archiveEntry: { version: 1, index, name: `${index + 1}.jpg`, crc32: index,
        compressedSize: 10, uncompressedSize: 10, compressionMethod: 0,
        archiveIdentity: { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs } },
    }));
  };
  const scan = () => scanLibrary(active.getSettings(), active.getOverridesRef(), {
    previousLibrary: active.getLibraryRef(), listArchivePages,
  });
  await active.replaceLibrary(await scan());
  const firstChapterId = active.getLibraryRef().series[0].volumes[0].chapters[0].id;
  const firstPage = await active.queryChapterPageAsync(firstChapterId, 2);
  await active.close();
  active = new AppStore(config);
  await active.init();
  indexed.length = 0;
  await active.replaceLibrary(await scan());
  assert.deepEqual(indexed, []);
  assert.deepEqual(await active.queryChapterPageAsync(firstChapterId, 2), firstPage);
  await fs.writeFile(second, 'changed archive with three pages and a different size');
  counts.set(second, 3);
  await active.replaceLibrary(await scan());
  assert.deepEqual(indexed, [second]);
  assert.equal(active.getLibrarySummary().stats.pageCount, 5);
  assert.deepEqual(await active.queryChapterPageAsync(firstChapterId, 2), firstPage);
  assert.equal(active.getDatabaseWriteWorkerMetrics().lastWrite.reusedChapters, 1);
});

test('batch overrides preserve case-sensitive source identities', async (t) => {
  const { store, tempRoot } = await createStore('folder-library-batch-identities-');
  t.after(async () => { await store.close(); await fs.rm(tempRoot, { recursive: true, force: true }); });
  await store.batchSetTags(['series/A', 'series/a', 'series/A'], ['tag'], { mode: 'replace' });
  await store.batchSetCategories(['series/A', 'series/a', 'series/A'], ['category']);
  assert.deepEqual(store.getTags('series/A'), ['tag']);
  assert.deepEqual(store.getTags('series/a'), ['tag']);
  assert.deepEqual(store.getOverrides().seriesCategories['series/A'], ['category']);
  assert.deepEqual(store.getOverrides().seriesCategories['series/a'], ['category']);
});

test('catalog content revision excludes reading state but advances for feature changes and scans', async (t) => {
  const { store, config, tempRoot } = await createStore('folder-library-content-revision-');
  let active = store;
  t.after(async () => { await active.close(); await fs.rm(tempRoot, { recursive: true, force: true }); });
  const contentRevision = () => Number(active.getDatabase().prepare("SELECT value FROM app_meta WHERE key='catalog_revision'").get().value);
  assert.equal(contentRevision(), 0);
  await active.replaceLibrary(createLibrary());
  assert.equal(contentRevision(), 1);
  const globalBefore = active.revision;
  const liveOnlyWrites = [
    () => active.toggleFavorite('series/a'),
    () => active.setCustomCover('series/a', 'chapter-1', 1),
    () => active.removeCustomCover('series/a'),
    () => active.setReadProgress('series/a', { chapterId: 'chapter-1', pageIndex: 1, totalPages: 2 }),
    () => active.clearReadProgress('series/a'),
    () => active.replaceSettings({ scanIntervalMinutes: 45 }),
  ];
  for (const write of liveOnlyWrites) {
    await write();
    assert.equal(contentRevision(), 1);
  }
  assert.equal(active.revision, globalBefore + liveOnlyWrites.length);
  const featureWrites = [
    () => active.setMetadata('series/a', { title: 'Updated title' }),
    () => active.setTags('series/a', ['tag']),
    () => active.batchSetTags(['series/a'], ['batch-tag']),
    () => active.setMetadataAndTags('series/a', { author: 'Updated author' }, ['combined']),
    () => active.setSeriesCategories('series/a', ['category']),
    () => active.batchSetCategories(['series/a'], ['batch-category']),
  ];
  for (let index = 0; index < featureWrites.length; index += 1) {
    await featureWrites[index]();
    assert.equal(contentRevision(), index + 2);
  }
  const beforeFailedScan = contentRevision();
  const invalid = createLibrary();
  invalid.series[0].volumes[0].chapters[0].pages.push({ ...invalid.series[0].volumes[0].chapters[0].pages[0] });
  await assert.rejects(active.replaceLibrary(invalid), /UNIQUE constraint/);
  assert.equal(contentRevision(), beforeFailedScan);
  const reused = active.getLibrary();
  reused.series[0]._reused = true;
  await active.replaceLibrary(reused);
  assert.equal(contentRevision(), beforeFailedScan + 1);
  await active.close();
  active = new AppStore(config);
  await active.init();
  assert.equal(contentRevision(), beforeFailedScan + 1);
});

test('existing v6 databases seed the missing content revision without losing user data', async (t) => {
  const { store, config, tempRoot } = await createStore('folder-library-seed-content-revision-');
  let active = store;
  t.after(async () => { await active.close(); await fs.rm(tempRoot, { recursive: true, force: true }); });
  await active.replaceLibrary(createLibrary());
  await active.setTags('series/a', ['preserved']);
  await active.setReadProgress('series/a', { chapterId: 'chapter-1', pageIndex: 1, totalPages: 2 });
  const revision = active.revision;
  active.getDatabase().prepare("DELETE FROM app_meta WHERE key='catalog_revision'").run();
  await active.close();
  active = new AppStore(config);
  await active.init();
  assert.equal(Number(active.getDatabase().prepare("SELECT value FROM app_meta WHERE key='catalog_revision'").get().value), revision);
  assert.deepEqual(active.getTags('series/a'), ['preserved']);
  assert.equal(active.getReadProgress('series/a').pageIndex, 1);
  assert.equal((await active.queryChapterPageAsync('chapter-1', 2)).sourcePath, '/library/series/a/2.jpg');
});
