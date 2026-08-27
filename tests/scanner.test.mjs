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
    scanMode: 'flat',
    folderPattern: {
      enabled: false,
      separator: '-',
      authorSegmentIndex: null,
      titleSegmentIndex: 0,
      categorySegmentIndex: null,
      stripTokens: [],
    },
    naming: {
      defaultVolumeName: 'Default Volume',
      directImageChapterTemplate: '{count}P',
    },
    categoryFolders: [],
    ...overrides,
  };
}

test('scanLibrary treats a folder with direct images as one standalone series', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-direct-series-'));
  const libraryRoot = path.join(tempRoot, 'library');

  await createFile(path.join(libraryRoot, 'artist', 'NO.01 Re：从零开始的圣诞节', '1.jpg'));
  await createFile(path.join(libraryRoot, 'artist', 'NO.01 Re：从零开始的圣诞节', '2.jpg'));

  const snapshot = await scanLibrary(createSettings(libraryRoot), {
    seriesCategories: {},
  });

  assert.equal(snapshot.stats.seriesCount, 1);
  assert.equal(snapshot.stats.volumeCount, 0);
  assert.equal(snapshot.stats.chapterCount, 1);
  assert.equal(snapshot.stats.pageCount, 2);

  const series = snapshot.series[0];
  assert.equal(series.title, 'NO.01 Re：从零开始的圣诞节');
  assert.equal(series.counts.volumes, 0);
  assert.equal(series.counts.chapters, 1);
  assert.equal(series.volumes.length, 1);
  assert.equal(series.volumes[0].synthetic, true);
  assert.equal(series.volumes[0].chapters[0].title, '2P');
});

test('scanLibrary groups chapter-like child folders under the parent work folder', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-child-chapters-'));
  const libraryRoot = path.join(tempRoot, 'library');

  await createFile(path.join(libraryRoot, 'artist', 'NO.46 小吉的微醺时刻', '壁纸', '1.jpg'));
  await createFile(path.join(libraryRoot, 'artist', 'NO.46 小吉的微醺时刻', 'Pic', '1.jpg'));
  await createFile(path.join(libraryRoot, 'artist', 'NO.46 小吉的微醺时刻', 'Pic', '2.jpg'));

  const snapshot = await scanLibrary(createSettings(libraryRoot), {
    seriesCategories: {},
  });

  assert.equal(snapshot.stats.seriesCount, 1);

  const series = snapshot.series[0];
  assert.equal(series.title, 'NO.46 小吉的微醺时刻');
  assert.equal(series.counts.volumes, 0);
  assert.equal(series.counts.chapters, 2);
  assert.equal(series.counts.pages, 3);
  assert.deepEqual(
    series.volumes[0].chapters.map((chapter) => chapter.title),
    ['壁纸', 'Pic'],
  );
});

test('scanLibrary recognizes common chapter folder aliases with separators and suffixes', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-chapter-aliases-'));
  const libraryRoot = path.join(tempRoot, 'library');

  await createFile(path.join(libraryRoot, 'artist', 'NO.88 测试作品', 'Wallpaper_4K', '1.jpg'));
  await createFile(path.join(libraryRoot, 'artist', 'NO.88 测试作品', '原图', '1.jpg'));
  await createFile(path.join(libraryRoot, 'artist', 'NO.88 测试作品', 'Vol-2', '1.jpg'));

  const snapshot = await scanLibrary(createSettings(libraryRoot), {
    seriesCategories: {},
  });

  assert.equal(snapshot.stats.seriesCount, 1);

  const series = snapshot.series[0];
  assert.equal(series.title, 'NO.88 测试作品');
  assert.deepEqual(
    new Set(series.volumes[0].chapters.map((chapter) => chapter.title)),
    new Set(['Wallpaper_4K', 'Vol-2', '原图']),
  );
});

test('scanLibrary does not group generic container folders like 其它 as a series', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-generic-container-'));
  const libraryRoot = path.join(tempRoot, 'library');

  await createFile(path.join(libraryRoot, 'artist', '其它', '情人节限定', '1.jpg'));
  await createFile(path.join(libraryRoot, 'artist', '其它', 'NO.12 永恒魅魔', '1.jpg'));

  const snapshot = await scanLibrary(createSettings(libraryRoot), {
    seriesCategories: {},
  });

  assert.equal(snapshot.stats.seriesCount, 2);

  const titles = snapshot.series.map((item) => item.title).sort();
  assert.deepEqual(titles, ['NO.12 永恒魅魔', '情人节限定']);
});

test('scanLibrary applies folder-bound categories to both direct-image and chapter-group series', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-category-recursive-'));
  const libraryRoot = path.join(tempRoot, 'library');
  const taotuRoot = path.join(tempRoot, 'taotu', '爆机少女喵小吉');

  await fs.mkdir(libraryRoot, { recursive: true });
  await createFile(path.join(taotuRoot, 'NO.01 Re：从零开始的圣诞节', '1.jpg'));
  await createFile(path.join(taotuRoot, 'NO.46 小吉的微醺时刻', '壁纸', '1.jpg'));
  await createFile(path.join(taotuRoot, 'NO.46 小吉的微醺时刻', 'Pic', '1.jpg'));
  await createFile(path.join(taotuRoot, '其它', '情人节限定', '1.jpg'));

  const snapshot = await scanLibrary(
    createSettings(libraryRoot, {
      categoryFolders: [{ name: '套图', folder: taotuRoot }],
    }),
    { seriesCategories: {} },
  );

  assert.equal(snapshot.stats.seriesCount, 3);
  assert.ok(snapshot.stats.categories.includes('套图'));

  const work1 = snapshot.series.find((item) => item.title === 'NO.01 Re：从零开始的圣诞节');
  const work46 = snapshot.series.find((item) => item.title === 'NO.46 小吉的微醺时刻');
  const valentines = snapshot.series.find((item) => item.title === '情人节限定');

  assert.ok(work1);
  assert.ok(work46);
  assert.ok(valentines);
  assert.deepEqual(work1.categories.folder, ['套图']);
  assert.deepEqual(work46.categories.folder, ['套图']);
  assert.deepEqual(valentines.categories.folder, ['套图']);
  assert.deepEqual(
    work46.volumes[0].chapters.map((chapter) => chapter.title),
    ['壁纸', 'Pic'],
  );
});

test('scanLibrary supports absolute category folders outside the library root', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-absolute-category-'));
  const libraryRoot = path.join(tempRoot, 'library');
  const externalRoot = path.join(tempRoot, 'albums');
  const externalSeriesRoot = path.join(externalRoot, 'alice');
  const externalSourceKey = toPosixPath(path.resolve(externalSeriesRoot));

  await createFile(path.join(libraryRoot, 'bob', '1.jpg'));
  await createFile(path.join(externalSeriesRoot, '1.jpg'));
  await createFile(path.join(externalSeriesRoot, '2.jpg'));

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
  const bob = snapshot.series.find((item) => item.title === 'bob');

  assert.ok(alice);
  assert.ok(bob);
  assert.deepEqual(alice.categories.folder, ['Albums']);
  assert.deepEqual(alice.categories.manual, ['Pinned']);
  assert.deepEqual(bob.categories.folder, []);
});

test('scanLibrary detects an in-place image change even when the series directory mtime is restored', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-content-change-'));
  const libraryRoot = path.join(tempRoot, 'library');
  const seriesRoot = path.join(libraryRoot, 'series-a');
  const imagePath = path.join(seriesRoot, '1.jpg');
  await createFile(imagePath, 'a');

  const first = await scanLibrary(createSettings(libraryRoot), { seriesCategories: {} });
  const originalDirectoryStats = await fs.stat(seriesRoot);

  await fs.writeFile(imagePath, 'a much larger image payload', 'utf8');
  await fs.utimes(seriesRoot, originalDirectoryStats.atime, originalDirectoryStats.mtime);

  const second = await scanLibrary(
    createSettings(libraryRoot),
    { seriesCategories: {} },
    { previousLibrary: first, fileStatConcurrency: 2, seriesConcurrency: 1 },
  );

  assert.equal(first.series[0].totalBytes, 1);
  assert.equal(second.series[0].totalBytes, 27);
  assert.equal(second.scanMeta.scannedCount, 1);
  assert.equal(second.scanMeta.reusedCount, 0);
});

test('scanLibrary bounds concurrent file stat work', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-stat-limit-'));
  const libraryRoot = path.join(tempRoot, 'library');
  for (let index = 0; index < 20; index += 1) {
    await createFile(path.join(libraryRoot, 'series-a', `${index}.jpg`), String(index));
  }

  let active = 0;
  let peak = 0;
  await scanLibrary(
    createSettings(libraryRoot),
    { seriesCategories: {} },
    {
      fileStatConcurrency: 3,
      onFileStatStart() {
        active += 1;
        peak = Math.max(peak, active);
      },
      onFileStatEnd() {
        active -= 1;
      },
    },
  );

  assert.ok(peak > 0);
  assert.ok(peak <= 3, `expected peak stat concurrency <= 3, received ${peak}`);
});

test('dirty-path scans do not enumerate unrelated series directories', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-dirty-scope-'));
  const libraryRoot = path.join(tempRoot, 'library');
  const seriesA = path.join(libraryRoot, 'series-a');
  const seriesB = path.join(libraryRoot, 'series-b');
  const changedImage = path.join(seriesA, '1.jpg');
  await createFile(changedImage, 'before');
  await createFile(path.join(seriesB, '1.jpg'), 'untouched');

  const first = await scanLibrary(createSettings(libraryRoot), { seriesCategories: {} });
  await fs.writeFile(changedImage, 'after', 'utf8');

  const directoriesRead = [];
  const second = await scanLibrary(
    createSettings(libraryRoot),
    { seriesCategories: {} },
    {
      previousLibrary: first,
      dirtyPaths: [changedImage],
      seriesConcurrency: 1,
      onDirectoryRead(directoryPath) {
        directoriesRead.push(path.resolve(directoryPath));
      },
    },
  );

  assert.ok(directoriesRead.includes(path.resolve(seriesA)));
  assert.ok(!directoriesRead.some((directoryPath) => {
    return directoryPath === path.resolve(seriesB) || directoryPath.startsWith(`${path.resolve(seriesB)}${path.sep}`);
  }));
  assert.equal(second.scanMeta.scannedCount, 1);
  assert.equal(second.scanMeta.reusedCount, 1);
});

test('dirty-path scans discover new series and remove deleted series', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-dirty-lifecycle-'));
  const libraryRoot = path.join(tempRoot, 'library');
  const originalImage = path.join(libraryRoot, 'series-a', '1.jpg');
  await createFile(originalImage, 'original');

  const first = await scanLibrary(createSettings(libraryRoot), { seriesCategories: {} });
  const addedImage = path.join(libraryRoot, 'series-b', '1.jpg');
  await createFile(addedImage, 'added');

  const afterAdd = await scanLibrary(
    createSettings(libraryRoot),
    { seriesCategories: {} },
    { previousLibrary: first, dirtyPaths: [addedImage] },
  );
  assert.deepEqual(afterAdd.series.map((seriesItem) => seriesItem.title), ['series-a', 'series-b']);

  await fs.rm(originalImage);
  const afterDelete = await scanLibrary(
    createSettings(libraryRoot),
    { seriesCategories: {} },
    { previousLibrary: afterAdd, dirtyPaths: [originalImage] },
  );
  assert.deepEqual(afterDelete.series.map((seriesItem) => seriesItem.title), ['series-b']);
});
