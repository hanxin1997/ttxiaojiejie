import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { scanLibrary } from '../server/scanner.mjs';

const SERIES_COUNT = 10_000;
const PAGES_PER_SERIES = 100;
const MAX_RSS_BYTES = 600 * 1024 * 1024;
const virtualRoot = path.resolve(os.tmpdir(), 'folder-library-virtual-cold-scan');

function entry(name, type) {
  return {
    name,
    isDirectory: () => type === 'directory',
    isFile: () => type === 'file',
  };
}

function missing(pathname) {
  const error = new Error(`ENOENT: ${pathname}`);
  error.code = 'ENOENT';
  return error;
}

// Entries are generated on demand, so the benchmark exercises scanner memory rather than
// consuming disk space/inodes for one million empty fixture files.
const filesystem = {
  async readdir(directoryPath) {
    const relativePath = path.relative(virtualRoot, path.resolve(directoryPath));
    if (relativePath === '') {
      return Array.from({ length: SERIES_COUNT }, (_, index) => {
        return entry(`series-${String(index).padStart(5, '0')}`, 'directory');
      });
    }
    if (!relativePath.includes(path.sep)) {
      return Array.from({ length: PAGES_PER_SERIES }, (_, index) => {
        return entry(`${String(index + 1).padStart(3, '0')}.jpg`, 'file');
      });
    }
    throw missing(directoryPath);
  },
  async stat(targetPath) {
    const relativePath = path.relative(virtualRoot, path.resolve(targetPath));
    const segments = relativePath.split(path.sep).filter(Boolean);
    const isDirectory = segments.length <= 1;
    if (segments.length > 2) throw missing(targetPath);
    return {
      isDirectory: () => isDirectory,
      size: isDirectory ? 0 : 1024,
      mtime: new Date('2026-08-10T00:00:00.000Z'),
      mtimeMs: 1_786_320_000_000,
    };
  },
};

const settings = {
  libraryRoot: virtualRoot,
  scanIntervalMinutes: 0,
  scanMode: 'flat',
  folderPattern: { enabled: false, separator: '-', titleSegmentIndex: 0, stripTokens: [] },
  naming: { defaultVolumeName: 'Default Volume', directImageChapterTemplate: '{count}P' },
  categoryFolders: [],
};

let activeFileStats = 0;
let peakFileStats = 0;
let peakRssBytes = process.memoryUsage().rss;
const memorySampler = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
}, 5);
memorySampler.unref?.();

const startedAt = Date.now();
const snapshot = await scanLibrary(settings, { seriesCategories: {} }, {
  filesystem,
  seriesConcurrency: 1,
  fileStatConcurrency: 16,
  onFileStatStart() {
    activeFileStats += 1;
    peakFileStats = Math.max(peakFileStats, activeFileStats);
  },
  onFileStatEnd() {
    activeFileStats -= 1;
  },
});
clearInterval(memorySampler);
peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);

assert.equal(snapshot.stats.seriesCount, SERIES_COUNT);
assert.equal(snapshot.stats.pageCount, SERIES_COUNT * PAGES_PER_SERIES);
assert.ok(peakFileStats <= 16, `lite file stat concurrency ${peakFileStats} exceeds 16`);
assert.ok(
  peakRssBytes <= MAX_RSS_BYTES,
  `cold scan peak RSS ${(peakRssBytes / 1024 / 1024).toFixed(1)}MB exceeds 600MB`,
);

console.log(JSON.stringify({
  series: snapshot.stats.seriesCount,
  pages: snapshot.stats.pageCount,
  peakRssMb: Number((peakRssBytes / 1024 / 1024).toFixed(1)),
  peakFileStats,
  elapsedMs: Date.now() - startedAt,
}));
