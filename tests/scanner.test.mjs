import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { syncMihonExport } from '../server/exporter.mjs';
import { scanLibrary } from '../server/scanner.mjs';

async function createFile(targetPath, content = 'image') {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, 'utf8');
}

function createSettings(libraryRoot, overrides = {}) {
  return {
    libraryRoot,
    scanIntervalMinutes: 15,
    autoExportToMihon: true,
    folderPattern: {
      enabled: true,
      separator: '-',
      titleSegmentIndex: 0,
      categorySegmentIndex: 1,
      stripTokens: ['图片'],
    },
    naming: {
      defaultVolumeName: '默认卷',
      directImageChapterTemplate: '{count}P',
    },
    categoryFolders: [],
    ...overrides,
  };
}

test('scanLibrary parses folder title, category, cover, volumes, and chapters', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-scan-'));
  const libraryRoot = path.join(tempRoot, 'library');
  const seriesRoot = path.join(libraryRoot, 'Alice-Cosplay-图片');

  await createFile(path.join(seriesRoot, 'Vol.1', '1.jpg'));
  await createFile(path.join(seriesRoot, 'Vol.1', '2.jpg'));
  await createFile(path.join(seriesRoot, 'Vol.2', 'Chapter A', '1.jpg'));
  await createFile(path.join(seriesRoot, 'Vol.2', 'Chapter A', '2.jpg'));

  const snapshot = await scanLibrary(createSettings(libraryRoot), {
    seriesCategories: {
      'Alice-Cosplay-图片': ['写真'],
    },
  });

  assert.equal(snapshot.stats.seriesCount, 1);
  assert.equal(snapshot.stats.volumeCount, 2);
  assert.equal(snapshot.stats.chapterCount, 2);
  assert.equal(snapshot.stats.pageCount, 4);
  assert.deepEqual(new Set(snapshot.stats.categories), new Set(['Cosplay', '写真']));

  const series = snapshot.series[0];
  assert.equal(series.title, 'Alice');
  assert.equal(series.cover.fileName, '1.jpg');
  assert.deepEqual(series.categories.auto, ['Cosplay']);
  assert.deepEqual(series.categories.folder, []);
  assert.deepEqual(series.categories.manual, ['写真']);
  assert.equal(series.volumes[0].title, 'Vol.1');
  assert.equal(series.volumes[0].chapters[0].title, '2P');
  assert.equal(series.volumes[1].chapters[0].title, 'Chapter A');
});

test('scanLibrary supports explicit category folder bindings', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-category-'));
  const libraryRoot = path.join(tempRoot, 'library');

  await createFile(path.join(libraryRoot, '热门', 'Alice-图片', 'Vol.1', '1.jpg'));
  await createFile(path.join(libraryRoot, '热门', 'Alice-图片', 'Vol.1', '2.jpg'));
  await createFile(path.join(libraryRoot, 'Bob-图片', 'Vol.1', '1.jpg'));

  const snapshot = await scanLibrary(
    createSettings(libraryRoot, {
      categoryFolders: [{ name: '热门推荐', folder: '热门' }],
    }),
    { seriesCategories: {} },
  );

  assert.equal(snapshot.stats.seriesCount, 2);
  assert.ok(snapshot.stats.categories.includes('热门推荐'));

  const alice = snapshot.series.find((item) => item.title === 'Alice');
  const bob = snapshot.series.find((item) => item.title === 'Bob');

  assert.deepEqual(alice.categories.folder, ['热门推荐']);
  assert.deepEqual(bob.categories.folder, []);
  assert.equal(alice.sourceKey, '热门/Alice-图片');
});

test('syncMihonExport writes local source structure', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-export-'));
  const libraryRoot = path.join(tempRoot, 'library');
  const exportRoot = path.join(tempRoot, 'mihon', 'local');
  const seriesRoot = path.join(libraryRoot, 'Bob-写真-图片');

  await createFile(path.join(seriesRoot, 'Vol.1', '1.jpg'));
  await createFile(path.join(seriesRoot, 'Vol.1', '2.jpg'));

  const snapshot = await scanLibrary(createSettings(libraryRoot), { seriesCategories: {} });
  const exportInfo = await syncMihonExport(snapshot, exportRoot);

  assert.equal(exportInfo.seriesCount, 1);
  assert.equal(exportInfo.chapterCount, 1);

  const rootEntries = await fs.readdir(exportRoot);
  assert.ok(rootEntries.includes('.nomedia'));

  const seriesEntries = await fs.readdir(path.join(exportRoot, 'Bob'));
  assert.ok(seriesEntries.includes('cover.jpg'));
  assert.ok(seriesEntries.includes('details.json'));

  const chapterDirs = seriesEntries.filter((entry) => entry.startsWith('0001'));
  assert.equal(chapterDirs.length, 1);

  const chapterEntries = await fs.readdir(path.join(exportRoot, 'Bob', chapterDirs[0]));
  assert.deepEqual(chapterEntries, ['0001.jpg', '0002.jpg']);
});
