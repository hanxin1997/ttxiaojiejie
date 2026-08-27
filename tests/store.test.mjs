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
