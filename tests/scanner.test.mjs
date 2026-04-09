import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { scanLibrary } from '../server/scanner.mjs';
import { toPosixPath } from '../server/utils.mjs';

async function createFile(targetPath, content = 'image') {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, 'utf8');
}

function createSettings(libraryRoot, overrides = {}) {
  return {
    libraryRoot,
    scanIntervalMinutes: 15,
    autoExportToMihon: false,
    folderPattern: {
      enabled: true,
      separator: '-',
      titleSegmentIndex: 0,
      categorySegmentIndex: 1,
      stripTokens: ['images'],
    },
    naming: {
      defaultVolumeName: 'Default Volume',
      directImageChapterTemplate: '{count}P',
    },
    categoryFolders: [],
    ...overrides,
  };
}

test('scanLibrary parses folder title, category, cover, volumes, and chapters', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-scan-'));
  const libraryRoot = path.join(tempRoot, 'library');
  const seriesRoot = path.join(libraryRoot, 'Alice-Cosplay-images');

  await createFile(path.join(seriesRoot, 'Vol.1', '1.jpg'));
  await createFile(path.join(seriesRoot, 'Vol.1', '2.jpg'));
  await createFile(path.join(seriesRoot, 'Vol.2', 'Chapter A', '1.jpg'));
  await createFile(path.join(seriesRoot, 'Vol.2', 'Chapter A', '2.jpg'));

  const snapshot = await scanLibrary(createSettings(libraryRoot), {
    seriesCategories: {
      'Alice-Cosplay-images': ['Photo'],
    },
  });

  assert.equal(snapshot.stats.seriesCount, 1);
  assert.equal(snapshot.stats.volumeCount, 2);
  assert.equal(snapshot.stats.chapterCount, 2);
  assert.equal(snapshot.stats.pageCount, 4);
  assert.deepEqual(new Set(snapshot.stats.categories), new Set(['Cosplay', 'Photo']));

  const series = snapshot.series[0];
  assert.equal(series.title, 'Alice');
  assert.equal(series.cover.fileName, '1.jpg');
  assert.deepEqual(series.categories.auto, ['Cosplay']);
  assert.deepEqual(series.categories.folder, []);
  assert.deepEqual(series.categories.manual, ['Photo']);
  assert.equal(series.volumes[0].title, 'Vol.1');
  assert.equal(series.volumes[0].chapters[0].title, '2P');
  assert.equal(series.volumes[1].chapters[0].title, 'Chapter A');
});

test('scanLibrary supports explicit category folder bindings', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-category-'));
  const libraryRoot = path.join(tempRoot, 'library');

  await createFile(path.join(libraryRoot, 'featured', 'Alice-images', 'Vol.1', '1.jpg'));
  await createFile(path.join(libraryRoot, 'featured', 'Alice-images', 'Vol.1', '2.jpg'));
  await createFile(path.join(libraryRoot, 'Bob-images', 'Vol.1', '1.jpg'));

  const snapshot = await scanLibrary(
    createSettings(libraryRoot, {
      categoryFolders: [{ name: 'Featured', folder: 'featured' }],
    }),
    { seriesCategories: {} },
  );

  assert.equal(snapshot.stats.seriesCount, 2);
  assert.ok(snapshot.stats.categories.includes('Featured'));

  const alice = snapshot.series.find((item) => item.title === 'Alice');
  const bob = snapshot.series.find((item) => item.title === 'Bob');

  assert.deepEqual(alice.categories.folder, ['Featured']);
  assert.deepEqual(bob.categories.folder, []);
  assert.equal(alice.sourceKey, 'featured/Alice-images');
});

test('scanLibrary supports absolute category folder bindings outside the library root', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-absolute-category-'));
  const libraryRoot = path.join(tempRoot, 'library');
  const externalRoot = path.join(tempRoot, 'albums');
  const externalSeriesRoot = path.join(externalRoot, 'Alice-images');
  const externalSourceKey = toPosixPath(path.resolve(externalSeriesRoot));

  await createFile(path.join(libraryRoot, 'Bob-images', 'Vol.1', '1.jpg'));
  await createFile(path.join(externalSeriesRoot, 'Vol.1', '1.jpg'));
  await createFile(path.join(externalSeriesRoot, 'Vol.1', '2.jpg'));

  const snapshot = await scanLibrary(
    createSettings(libraryRoot, {
      categoryFolders: [{ name: 'Albums', folder: externalRoot }],
    }),
    {
      seriesCategories: {
        [externalSourceKey]: ['Pinned'],
      },
    },
  );

  assert.equal(snapshot.stats.seriesCount, 2);
  assert.ok(snapshot.stats.categories.includes('Albums'));
  assert.ok(snapshot.stats.categories.includes('Pinned'));

  const alice = snapshot.series.find((item) => item.sourceKey === externalSourceKey);
  const bob = snapshot.series.find((item) => item.title === 'Bob');

  assert.ok(alice);
  assert.ok(bob);
  assert.deepEqual(alice.categories.folder, ['Albums']);
  assert.deepEqual(alice.categories.manual, ['Pinned']);
  assert.equal(alice.sourceKey, externalSourceKey);
  assert.deepEqual(bob.categories.folder, []);
});
