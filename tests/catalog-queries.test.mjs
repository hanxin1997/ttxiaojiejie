import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AppStore } from '../server/store.mjs';
import { detectDuplicates } from '../server/routes/advanced.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-catalog-query-'));
  const store = new AppStore({ dataDir: root, databaseFile: path.join(root, 'app.sqlite'),
    defaultSettings: { libraryRoot: root, scanIntervalMinutes: 0, categoryFolders: [],
      folderPattern: { enabled: false, stripTokens: [] }, naming: {} } });
  await store.init();
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const series = ['书10', '书2', 'Other'].map((title, index) => ({
    id: `s${index}`, sourceKey: `author/${index}`, sourcePath: `${root}/${index}`, sourceFolderName: title,
    title, author: index < 2 ? 'Same author' : 'Other author',
    categories: { auto: [], folder: ['Library'], manual: [], effective: ['Library'] },
    counts: { volumes: 1, chapters: 1, pages: 100 }, totalBytes: 1000,
    volumes: [{ id: `v${index}`, title: 'Volume', sourcePath: root, synthetic: false,
      chapters: [{ id: `c${index}`, title: 'Chapter', sourceKey: `author/${index}/chapter`,
        sourcePath: root, pageCount: 100, totalBytes: 1000, pages: [] }] }],
  }));
  await store.replaceLibrary({ lastScanAt: '2026-11-05T00:00:00.000Z', scanRoot: root, series, issues: [],
    stats: { seriesCount: 3, volumeCount: 3, chapterCount: 3, pageCount: 300, totalBytes: 3000, categories: ['Library'] } });
  return store;
}

test('OPDS worker preserves effective natural ordering, substring search and page clamping', async (t) => {
  const store = await fixture(t);
  const result = await store.queryCatalogOperationAsync('opds-page', { search: '书', pageSize: 1 });
  assert.equal(result.items[0].id, 's1');
  assert.equal(result.total, 2);
  assert.equal(result.totalPages, 2);
  const last = await store.queryCatalogOperationAsync('opds-page', { search: '书', pageSize: 1, page: 999 });
  assert.equal(last.page, 2);
  assert.equal(last.items[0].id, 's0');
  assert.equal((await store.queryCatalogOperationAsync('opds-page', { search: 'author/2' })).items[0].id, 's2');
  await store.setMetadata('author/0', { title: '书1', author: 'Edited author' });
  const changed = await store.queryCatalogOperationAsync('opds-page', { search: '书', pageSize: 1 });
  assert.equal(changed.items[0].title, '书1');
  assert.equal((await store.queryCatalogOperationAsync('opds-page', { search: 'edited' })).items[0].id, 's0');
});

test('recommendation features and duplicate queries refresh after visible mutations', async (t) => {
  const store = await fixture(t);
  await store.setTags('author/0', ['shared']);
  await store.setTags('author/1', ['shared']);
  const first = await store.queryCatalogOperationAsync('recommendations', { seriesId: 's0', limit: 1 });
  assert.equal(first.length, 1);
  assert.equal(first[0].series.id, 's1');
  assert.ok(first[0].reasons.some((value) => value.includes('shared tags')));
  await store.setTags('author/1', []);
  const changed = await store.queryCatalogOperationAsync('recommendations', { seriesId: 's0', limit: 1 });
  assert.ok(changed[0].score < first[0].score);
  assert.equal(await store.queryCatalogOperationAsync('recommendations', { seriesId: 'missing' }), null);
  assert.deepEqual(await store.queryCatalogOperationAsync('duplicates', {}), detectDuplicates(store.getLibraryRef().series));
});

test('latest chapter uses the last nonempty volume and progress filters still count correctly', async (t) => {
  const store = await fixture(t);
  const next = structuredClone(store.getLibraryRef());
  next.series[0].volumes.push({ id: 'empty-last', title: 'Empty', sourcePath: '/empty', synthetic: false, chapters: [] });
  await store.replaceLibrary(next);
  let page = await store.querySeriesPageAsync({}, { page: 1, pageSize: 3 });
  assert.equal(page.items.find((item) => item.id === 's0').latestChapterTitle, 'Volume / Chapter');
  await store.setReadProgress('author/0', { chapterId: 'c0', pageIndex: 2, totalPages: 100 });
  page = await store.querySeriesPageAsync({ readStatus: 'reading' }, { page: 1, pageSize: 3 });
  assert.equal(page.total, 1);
  assert.equal(page.items[0].id, 's0');
  assert.equal((await store.querySeriesPageAsync({ readStatus: 'unread' }, { page: 1, pageSize: 3 })).total, 2);
});
