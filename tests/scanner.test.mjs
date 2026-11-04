import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';

import { scanLibrary } from '../server/scanner.mjs';
import { toPosixPath } from '../server/utils.mjs';
import { writeCbz } from './helpers/cbz-fixtures.mjs';

const require = createRequire(import.meta.url);
let hasArchiveDependency = false;
try {
  require.resolve('yauzl');
  hasArchiveDependency = true;
} catch {
  // The local machine deliberately does not install dependencies. CI must run
  // the real ZIP integration case; only this constrained local run may skip it.
}

function requireArchiveDependency(t) {
  if (hasArchiveDependency) return true;
  assert.ok(!process.env.CI && process.env.REQUIRE_ARCHIVE_DEPS !== '1',
    'CI must install yauzl before running real CBZ scanner tests');
  t.skip('yauzl is not installed locally; archive metadata boundary cases still run');
  return false;
}

// This boundary double does not parse ZIP bytes. Its rows model the archive
// module's documented result, while real file stats exercise scanner invalidation.
function createArchiveIndexStub(entriesByPath) {
  return async (sourcePath) => {
    const entries = entriesByPath.get(sourcePath);
    if (entries instanceof Error) throw entries;
    assert.ok(Array.isArray(entries), `unexpected archive lookup: ${sourcePath}`);
    const stat = await fs.stat(sourcePath);
    return entries.map((entry, index) => {
      const content = Buffer.from(entry.content ?? 'page');
      return {
        sourcePath,
        relativePath: entry.name,
        sizeBytes: content.length,
        mtimeMs: stat.mtimeMs,
        archiveEntry: {
          version: 1,
          index: entry.ordinal ?? index,
          name: entry.name,
          crc32: crc32(content),
          compressedSize: content.length,
          uncompressedSize: content.length,
          compressionMethod: 0,
          archiveIdentity: { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs },
        },
      };
    });
  };
}

async function createArchiveTestRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-cbz-scan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

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

test('directory cache release visits only consumers and keeps overlapping candidate reads shared', async () => {
  for (const count of [100, 200, 400]) {
    const root = path.resolve('virtual-linear-scan');
    const reads = new Map();
    let releases = 0;
    const entry = (name, directory) => ({ name, isDirectory: () => directory, isFile: () => !directory });
    const filesystem = {
      async readdir(directory) {
        reads.set(directory, (reads.get(directory) ?? 0) + 1);
        if (directory === root) return Array.from({ length: count }, (_, index) => entry(`work-${index}`, true));
        // Both a work and its non-chapter-like child are candidates. The parent
        // peeks at that child while the child also consumes its own cached read.
        return path.basename(directory) === 'bonus-gallery'
          ? [entry('1.jpg', false)] : [entry('1.jpg', false), entry('bonus-gallery', true)];
      },
      async stat(target) {
        return { isDirectory: () => !target.endsWith('.jpg'), isFile: () => target.endsWith('.jpg'),
          size: 1, mtime: new Date(1000), mtimeMs: 1000 };
      },
    };
    const snapshot = await scanLibrary(createSettings(root), { seriesCategories: {} }, {
      filesystem, seriesConcurrency: 8, onDirectoryRelease: () => { releases += 1; },
    });
    assert.equal(snapshot.series.length, count * 2);
    assert.equal(reads.size, count * 2 + 1);
    assert.ok([...reads.values()].every((value) => value === 1));
    assert.equal(releases, count * 3);
  }
});

test('unchanged CBZ chapters skip indexing with empty runtime pages and survive a changed sibling', async (t) => {
  const root = await createArchiveTestRoot(t);
  const firstPath = path.join(root, 'work', '1.cbz');
  const secondPath = path.join(root, 'work', '2.cbz');
  await createFile(firstPath, 'first-archive');
  await createFile(secondPath, 'second-archive');
  const entries = new Map([
    [firstPath, [{ name: '1.jpg' }, { name: '2.jpg' }]],
    [secondPath, [{ name: '1.jpg' }]],
  ]);
  const index = createArchiveIndexStub(entries);
  const indexed = [];
  const options = { listArchivePages: async (source) => { indexed.push(source); return index(source); } };
  const settings = createSettings(root);
  const first = await scanLibrary(settings, { seriesCategories: {} }, options);
  const runtime = structuredClone(first);
  for (const chapter of runtime.series[0].volumes[0].chapters) chapter.pages = [];
  indexed.length = 0;
  const unchanged = await scanLibrary(settings, { seriesCategories: {} }, { ...options, previousLibrary: runtime });
  assert.deepEqual(indexed, []);
  assert.equal(unchanged.scanMeta.reusedCount, 1);
  assert.deepEqual(unchanged.series[0].cover, first.series[0].cover);
  assert.equal(unchanged.stats.pageCount, 3);

  await createFile(secondPath, 'changed-and-larger-second-archive');
  entries.set(secondPath, [{ name: '1.jpg' }, { name: '2.jpg' }, { name: '3.jpg' }]);
  const changed = await scanLibrary(settings, { seriesCategories: {} }, { ...options, previousLibrary: unchanged });
  assert.deepEqual(indexed, [secondPath]);
  assert.equal(changed.scanMeta.scannedCount, 1);
  assert.equal(changed.stats.pageCount, 5);
  const chapters = changed.series[0].volumes[0].chapters;
  assert.equal(chapters[0]._reused, true);
  assert.equal(chapters[0].pages.length, 0);
  assert.equal(chapters[0].pageCount, 2);
  assert.equal(chapters[1].pages.length, 3);
  assert.deepEqual(changed.series[0].cover, first.series[0].cover);

  indexed.length = 0;
  await scanLibrary(settings, { seriesCategories: {} }, {
    ...options, previousLibrary: changed, archiveOptions: { maxPageBytes: 1024 },
  });
  assert.deepEqual(indexed, [firstPath, secondPath]);
});

test('scanLibrary reads CBZ pages beside an external cover under an author and work folder', async (t) => {
  if (!requireArchiveDependency(t)) return;
  const libraryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-cbz-reproduction-'));
  t.after(() => fs.rm(libraryRoot, { recursive: true, force: true }));
  const seriesRoot = path.join(libraryRoot, '作者名', '漫画名字');
  const coverPath = path.join(seriesRoot, '封面.jpg');
  const archivePath = path.join(seriesRoot, '漫画.cbz');
  await createFile(coverPath, 'external cover');
  await writeCbz(archivePath, [
    { name: '2.jpg', content: 'second page' },
    { name: '1.jpg', content: 'first page' },
  ]);

  const snapshot = await scanLibrary(createSettings(libraryRoot), { seriesCategories: {} });

  assert.equal(snapshot.stats.seriesCount, 1);
  assert.equal(snapshot.stats.pageCount, 2);
  const series = snapshot.series[0];
  assert.equal(series.title, '漫画名字');
  assert.equal(series.cover.sourcePath, coverPath);
  assert.equal(series.counts.chapters, 1);
  assert.equal(series.volumes[0].chapters[0].title, '漫画');
  assert.equal(series.volumes[0].chapters[0].sourcePath, archivePath);
});

test('archive metadata becomes readable chapters while named and lone external covers stay out of the body', async (t) => {
  const libraryRoot = await createArchiveTestRoot(t);
  const entries = [{ name: '1.jpg' }, { name: '2.jpg' }];
  const rows = new Map();
  for (const [work, cover] of [['漫画名字', '封面.jpg'], ['另一作品', 'poster.png']]) {
    const seriesRoot = path.join(libraryRoot, '作者名', work);
    const archivePath = path.join(seriesRoot, '漫画.cbz');
    await createFile(path.join(seriesRoot, cover));
    await writeCbz(archivePath, entries);
    rows.set(archivePath, entries);
  }
  const snapshot = await scanLibrary(createSettings(libraryRoot), { seriesCategories: {} }, {
    listArchivePages: createArchiveIndexStub(rows),
  });
  assert.equal(snapshot.stats.seriesCount, 2);
  assert.equal(snapshot.stats.pageCount, 4);
  assert.equal(snapshot.stats.chapterCount, 2);
  for (const series of snapshot.series) {
    assert.equal(series.author, null);
    assert.equal(series.counts.volumes, 0);
    assert.equal(series.volumes[0].chapters[0].title, '漫画');
    assert.equal(series.volumes[0].chapters[0].pageCount, 2);
    assert.equal(series.cover.archiveEntry, undefined);
    assert.equal(path.dirname(series.cover.sourcePath), series.sourcePath);
  }
});

test('pure CBZ works sort chapters naturally and use an indexed archive page as their default cover', async (t) => {
  const libraryRoot = await createArchiveTestRoot(t);
  const seriesRoot = path.join(libraryRoot, '作者', '作品');
  const entries = [{ name: '子目录/1.jpg', ordinal: 1 }, { name: '子目录/2.jpg', ordinal: 0 }];
  const rows = new Map();
  for (const name of ['10.cbz', '2.CBZ', '1.cbz']) {
    const archivePath = path.join(seriesRoot, name);
    await writeCbz(archivePath, entries);
    rows.set(archivePath, entries);
  }
  const snapshot = await scanLibrary(createSettings(libraryRoot), { seriesCategories: {} }, {
    listArchivePages: createArchiveIndexStub(rows),
  });
  const series = snapshot.series[0];
  assert.equal(snapshot.stats.seriesCount, 1);
  assert.equal(series.counts.pages, 6);
  assert.deepEqual(series.volumes[0].chapters.map((chapter) => chapter.title), ['1', '2', '10']);
  assert.equal(series.cover.sourcePath, path.join(seriesRoot, '1.cbz'));
  assert.equal(series.cover.fileName, '1.jpg');
  assert.equal(series.cover.archiveEntry.name, '子目录/1.jpg');
  assert.equal(series.cover.archiveEntry.index, 1);
  assert.deepEqual(series.volumes[0].chapters[0].pages.map((page) => page.index), [1, 2]);
});

test('mixed CBZ works retain loose body pages and ordinary image galleries retain cover-named pages', async (t) => {
  const libraryRoot = await createArchiveTestRoot(t);
  const seriesRoot = path.join(libraryRoot, 'mixed');
  const archivePath = path.join(seriesRoot, 'book.cbz');
  const entries = [{ name: '1.jpg' }, { name: '2.jpg' }];
  for (const name of ['cover.jpg', '01.jpg', '02.jpg']) await createFile(path.join(seriesRoot, name));
  await createFile(path.join(libraryRoot, 'loose-work', 'folder.jpg'));
  await writeCbz(archivePath, entries);
  const snapshot = await scanLibrary(createSettings(libraryRoot), { seriesCategories: {} }, {
    listArchivePages: createArchiveIndexStub(new Map([[archivePath, entries]])),
  });
  const mixed = snapshot.series.find((series) => series.title === 'mixed');
  const gallery = snapshot.series.find((series) => series.title === 'loose-work');
  assert.equal(mixed.counts.pages, 4);
  assert.deepEqual(mixed.volumes[0].chapters.map((chapter) => chapter.title), ['2P', 'book']);
  assert.equal(mixed.cover.sourcePath, path.join(seriesRoot, 'cover.jpg'));
  assert.equal(gallery.counts.pages, 1);
  assert.equal(gallery.volumes[0].chapters[0].pages[0].relativePath, 'folder.jpg');
});

test('chapter-like directories can combine archive chapters and loose image chapters under one work', async (t) => {
  const libraryRoot = await createArchiveTestRoot(t);
  const seriesRoot = path.join(libraryRoot, '作者', '作品');
  const archivePath = path.join(seriesRoot, 'Chapter1', 'book.cbz');
  const entries = [{ name: '1.jpg' }, { name: '2.jpg' }];
  await createFile(path.join(seriesRoot, 'cover.jpg'));
  await createFile(path.join(seriesRoot, 'Pic', '1.jpg'));
  await writeCbz(archivePath, entries);
  const snapshot = await scanLibrary(createSettings(libraryRoot), { seriesCategories: {} }, {
    listArchivePages: createArchiveIndexStub(new Map([[archivePath, entries]])),
  });
  assert.equal(snapshot.stats.seriesCount, 1);
  const series = snapshot.series[0];
  assert.equal(series.title, '作品');
  assert.equal(series.counts.pages, 3);
  assert.deepEqual(series.volumes[0].chapters.map((chapter) => chapter.title), ['Chapter1/book', 'Pic']);
  assert.equal(series.cover.sourcePath, path.join(seriesRoot, 'cover.jpg'));
});

test('bad archives are isolated and their issues survive unrelated dirty scans until their paths are rescanned', async (t) => {
  const libraryRoot = await createArchiveTestRoot(t);
  const goodPath = path.join(libraryRoot, 'mixed', 'good.cbz');
  const badPath = path.join(libraryRoot, 'mixed', 'bad.cbz');
  const onlyBadPath = path.join(libraryRoot, 'broken', 'bad.cbz');
  const loosePage = path.join(libraryRoot, 'loose-work', '1.jpg');
  const entries = [{ name: '1.jpg' }, { name: '2.jpg' }];
  await writeCbz(goodPath, entries);
  for (const archivePath of [badPath, onlyBadPath]) await createFile(archivePath, 'broken ZIP');
  await createFile(path.join(libraryRoot, 'broken', 'cover.jpg'));
  await createFile(loosePage);
  const rows = new Map([
    [goodPath, entries], [badPath, new Error('invalid ZIP')], [onlyBadPath, new Error('invalid ZIP')],
  ]);
  const options = { listArchivePages: createArchiveIndexStub(rows) };
  const settings = createSettings(libraryRoot);
  const first = await scanLibrary(settings, { seriesCategories: {} }, options);
  assert.deepEqual(first.series.map((series) => series.title), ['loose-work', 'mixed']);
  assert.equal(first.issues.length, 2);
  assert.ok(first.issues.some((issue) => issue.includes(toPosixPath(onlyBadPath))));

  await fs.writeFile(loosePage, 'changed loose page');
  const second = await scanLibrary(settings, { seriesCategories: {} }, {
    ...options, previousLibrary: first, dirtyPaths: [loosePage],
  });
  assert.deepEqual(second.issues, first.issues);
  assert.equal(second.scanMeta.reusedCount, 1);

  await fs.rm(badPath);
  await fs.rm(onlyBadPath);
  const third = await scanLibrary(settings, { seriesCategories: {} }, {
    ...options, previousLibrary: second, dirtyPaths: [badPath, onlyBadPath],
  });
  assert.deepEqual(third.issues, []);
});

test('archive identity and external cover changes invalidate fingerprints even when the work directory mtime is unchanged', async (t) => {
  const libraryRoot = await createArchiveTestRoot(t);
  const seriesRoot = path.join(libraryRoot, 'work');
  const archivePath = path.join(seriesRoot, 'book.cbz');
  const coverPath = path.join(seriesRoot, 'cover.jpg');
  const entries = [{ name: '1.jpg' }, { name: '2.jpg' }];
  await writeCbz(archivePath, entries);
  await createFile(coverPath);
  const options = { listArchivePages: createArchiveIndexStub(new Map([[archivePath, entries]])) };
  const settings = createSettings(libraryRoot);
  const first = await scanLibrary(settings, { seriesCategories: {} }, options);
  const directoryStats = await fs.stat(seriesRoot);
  // The returned page metadata stays identical while the container identity changes.
  await writeCbz(archivePath, entries, { comment: 'replaced container' });
  await fs.utimes(seriesRoot, directoryStats.atime, directoryStats.mtime);
  const second = await scanLibrary(settings, { seriesCategories: {} }, { ...options, previousLibrary: first });
  assert.notEqual(second.series[0].scanFingerprint, first.series[0].scanFingerprint);
  assert.equal(second.scanMeta.reusedCount, 0);
  assert.equal(second.series[0].volumes[0].chapters[0].id, first.series[0].volumes[0].chapters[0].id);

  const unchanged = await scanLibrary(settings, { seriesCategories: {} }, { ...options, previousLibrary: second });
  assert.equal(unchanged.scanMeta.reusedCount, 1);
  await fs.writeFile(coverPath, 'replacement external cover');
  await fs.utimes(seriesRoot, directoryStats.atime, directoryStats.mtime);
  const changedCover = await scanLibrary(settings, { seriesCategories: {} }, { ...options, previousLibrary: unchanged });
  assert.notEqual(changedCover.series[0].scanFingerprint, unchanged.series[0].scanFingerprint);
  assert.equal(changedCover.scanMeta.reusedCount, 0);
});

test('dirty scans discover root CBZ files, external category archives and removal without losing existing works', async (t) => {
  const tempRoot = await createArchiveTestRoot(t);
  const libraryRoot = path.join(tempRoot, 'library');
  const externalRoot = path.join(tempRoot, 'external');
  await fs.mkdir(externalRoot, { recursive: true });
  await createFile(path.join(libraryRoot, 'loose-work', '1.jpg'));
  const settings = createSettings(libraryRoot, { categoryFolders: [{ name: '外部', folder: externalRoot }] });
  const rows = new Map();
  const options = { listArchivePages: createArchiveIndexStub(rows) };
  const first = await scanLibrary(settings, { seriesCategories: {} }, options);
  const rootArchive = path.join(libraryRoot, 'root.cbz');
  const externalArchive = path.join(externalRoot, '作者', '漫画', 'book.cbz');
  const entries = [{ name: '1.jpg' }];
  for (const archivePath of [rootArchive, externalArchive]) {
    await writeCbz(archivePath, entries);
    rows.set(archivePath, entries);
  }
  const second = await scanLibrary(settings, { seriesCategories: {} }, {
    ...options, previousLibrary: first, dirtyPaths: [rootArchive, externalArchive],
  });
  assert.equal(second.stats.seriesCount, 3);
  assert.ok(second.series.some((series) => series.sourcePath === libraryRoot));
  assert.deepEqual(second.series.find((series) => series.title === '漫画').categories.folder, ['外部']);
  await fs.rm(rootArchive);
  const third = await scanLibrary(settings, { seriesCategories: {} }, {
    ...options, previousLibrary: second, dirtyPaths: [rootArchive],
  });
  assert.deepEqual(third.series.map((series) => series.title).sort(), ['loose-work', '漫画']);
});

test('an old cover-only snapshot gets a full discovery pass even when the first change is unrelated', async (t) => {
  const libraryRoot = await createArchiveTestRoot(t);
  const seriesRoot = path.join(libraryRoot, 'work');
  const loosePage = path.join(libraryRoot, 'loose-work', '1.jpg');
  await createFile(path.join(seriesRoot, 'cover.jpg'));
  await createFile(loosePage);
  const settings = createSettings(libraryRoot);
  const previous = await scanLibrary(settings, { seriesCategories: {} });
  for (const series of previous.series) series.scanFingerprint = 'old-image-only-fingerprint';
  const archivePath = path.join(seriesRoot, 'book.cbz');
  const entries = [{ name: '1.jpg' }, { name: '2.jpg' }];
  await writeCbz(archivePath, entries);
  await fs.writeFile(loosePage, 'changed');
  const next = await scanLibrary(settings, { seriesCategories: {} }, {
    previousLibrary: previous,
    dirtyPaths: [loosePage],
    listArchivePages: createArchiveIndexStub(new Map([[archivePath, entries]])),
  });
  const work = next.series.find((series) => series.title === 'work');
  assert.equal(work.counts.pages, 2);
  assert.equal(work.volumes[0].chapters[0].title, 'book');
  assert.notEqual(work.volumes[0].chapters[0].id, previous.series.find((series) => series.title === 'work').volumes[0].chapters[0].id);
});

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
