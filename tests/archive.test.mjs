import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { extractArchivePage, listArchivePages } from '../server/archive.mjs';
import { ArchiveIndexCache } from '../server/archive-index-cache.mjs';
import { createCbzBuffer, writeCbz } from './helpers/cbz-fixtures.mjs';

const require = createRequire(import.meta.url);
let hasYauzl = false;
try {
  require.resolve('yauzl');
  hasYauzl = true;
} catch {
  // The user's local machine intentionally has no installed project dependencies.
}

function requireYauzl(t) {
  if (hasYauzl) return true;
  assert.ok(!process.env.CI && process.env.REQUIRE_ARCHIVE_DEPS !== '1',
    'CI must install yauzl before running real archive integration tests');
  t.skip('yauzl is unavailable locally; real ZIP parsing and extraction must run in CI');
  return false;
}

async function fixtureRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-archive-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('real CBZ naturally sorts nested Chinese pages and preserves duplicate entry identities', { timeout: 10_000 }, async (t) => {
  if (!requireYauzl(t)) return;
  const root = await fixtureRoot(t);
  const entries = [
    { name: '中文/10.JPG', content: 'ten', method: 'store' },
    { name: '中文/2.png', content: 'first-two', method: 'deflate' },
    { name: '中文/1.jpg', content: 'one', method: 'store' },
    { name: '中文/2.png', content: 'second-two', method: 'deflate' },
    { name: '__MACOSX/ignored.jpg', content: 'ignored' },
    { name: '中文/._1.jpg', content: 'ignored' },
    { name: 'ComicInfo.xml', content: '<ComicInfo/>' },
    { name: '中文/', content: '' },
  ];
  const archive = await writeCbz(path.join(root, '漫画.cbz'), entries);
  const pages = await listArchivePages(archive);
  assert.deepEqual(pages.map((page) => page.relativePath), ['中文/1.jpg', '中文/2.png', '中文/2.png', '中文/10.JPG']);
  assert.deepEqual(pages.map((page) => page.archiveEntry.index), [2, 1, 3, 0]);
  for (const page of pages) {
    assert.equal(page.sourcePath, archive);
    const target = path.join(root, `page-${page.archiveEntry.index}.tmp`);
    await extractArchivePage(archive, page.archiveEntry, target);
    assert.equal(await fs.readFile(target, 'utf8'), entries[page.archiveEntry.index].content);
  }
});

test('real ZIP64 central directories support Store and Deflate pages', { timeout: 10_000 }, async (t) => {
  if (!requireYauzl(t)) return;
  const root = await fixtureRoot(t);
  const entries = [{ name: '1.jpg', content: 'stored', method: 0 }, { name: '2.png', content: 'deflated', method: 8 }];
  const archive = await writeCbz(path.join(root, 'zip64.cbz'), entries, { zip64: true });
  const pages = await listArchivePages(archive);
  assert.equal(pages.length, 2);
  for (let index = 0; index < pages.length; index += 1) {
    const target = path.join(root, `${index}.tmp`);
    await extractArchivePage(archive, pages[index].archiveEntry, target);
    assert.equal(await fs.readFile(target, 'utf8'), entries[index].content);
  }
});

test('real archive extraction rejects CRC failures and removes partial output', { timeout: 10_000 }, async (t) => {
  if (!requireYauzl(t)) return;
  const root = await fixtureRoot(t);
  for (const method of [0, 8]) {
    const archive = await writeCbz(path.join(root, `bad-crc-${method}.cbz`), [
      { name: '1.jpg', content: 'checksum-must-not-match', method, crc32Override: 0 },
    ]);
    const [page] = await listArchivePages(archive);
    const target = path.join(root, `${method}.tmp`);
    await assert.rejects(extractArchivePage(archive, page.archiveEntry, target), { code: 'ARCHIVE_INVALID' });
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  }
});

test('real archives reject unsafe paths, symlinks, encryption and unsupported compression', { timeout: 10_000 }, async (t) => {
  if (!requireYauzl(t)) return;
  const root = await fixtureRoot(t);
  const entries = [
    { name: '../escape.jpg' }, { name: '/absolute.jpg' }, { name: 'C:/escape.jpg' },
    { name: 'a/../escape.jpg' }, { name: 'link.jpg', externalFileAttributes: 0xa1ff0000 },
    { name: 'encrypted.jpg', flags: 0x0801 }, { name: 'unsupported.jpg', method: 9 },
  ];
  for (let index = 0; index < entries.length; index += 1) {
    const archive = await writeCbz(path.join(root, `${index}.cbz`), [{ ...entries[index], content: 'page' }]);
    await assert.rejects(listArchivePages(archive), { code: 'ARCHIVE_INVALID' });
  }
});

test('real archives enforce entry, index, comment and expanded-page budgets', { timeout: 10_000 }, async (t) => {
  if (!requireYauzl(t)) return;
  const root = await fixtureRoot(t);
  const archive = await writeCbz(path.join(root, 'limits.cbz'), [
    { name: '1.jpg', content: 'longer-than-three' }, { name: '2.jpg', content: 'page' },
  ]);
  await assert.rejects(listArchivePages(archive, { maxEntries: 1 }), { code: 'ARCHIVE_LIMIT' });
  await assert.rejects(listArchivePages(archive, { maxIndexBytes: 256 }), { code: 'ARCHIVE_LIMIT' });
  await assert.rejects(listArchivePages(archive, { maxPageBytes: 3 }), { code: 'ARCHIVE_LIMIT' });
  const commentArchive = await writeCbz(path.join(root, 'comment.cbz'), [
    { name: '1.jpg', content: 'page', comment: 'x'.repeat(1024) },
  ]);
  await assert.rejects(listArchivePages(commentArchive, { maxIndexBytes: 512 }), { code: 'ARCHIVE_LIMIT' });
});

test('real archives report empty, truncated and incorrect-size input', { timeout: 10_000 }, async (t) => {
  if (!requireYauzl(t)) return;
  const root = await fixtureRoot(t);
  const empty = await writeCbz(path.join(root, 'empty.cbz'), [{ name: 'ComicInfo.xml', content: 'metadata' }]);
  await assert.rejects(listArchivePages(empty), { code: 'ARCHIVE_EMPTY' });
  const truncated = path.join(root, 'truncated.cbz');
  const bytes = createCbzBuffer([{ name: '1.jpg', content: 'page' }]);
  await fs.writeFile(truncated, bytes.subarray(0, bytes.length - 10));
  await assert.rejects(listArchivePages(truncated), { code: 'ARCHIVE_INVALID' });
  const wrongSize = await writeCbz(path.join(root, 'wrong-size.cbz'), [
    { name: '1.jpg', content: 'page', method: 8, uncompressedSizeOverride: 99 },
  ]);
  const [page] = await listArchivePages(wrongSize);
  const target = path.join(root, 'wrong-size.tmp');
  await assert.rejects(extractArchivePage(wrongSize, page.archiveEntry, target));
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('real extraction rejects stale descriptors and never overwrites an existing destination', { timeout: 10_000 }, async (t) => {
  if (!requireYauzl(t)) return;
  const root = await fixtureRoot(t);
  const archive = await writeCbz(path.join(root, 'source.cbz'), [{ name: '1.jpg', content: 'original' }]);
  const [page] = await listArchivePages(archive);
  const existing = path.join(root, 'existing.jpg');
  await fs.writeFile(existing, 'keep');
  await assert.rejects(extractArchivePage(archive, page.archiveEntry, existing));
  assert.equal(await fs.readFile(existing, 'utf8'), 'keep');
  await fs.writeFile(archive, 'archive-replaced-with-different-bytes');
  await assert.rejects(extractArchivePage(archive, page.archiveEntry, path.join(root, 'stale.tmp')),
    { code: 'ARCHIVE_STALE' });
});

test('real cold sequential and random page reads enumerate the central directory once per identity', { timeout: 20_000 }, async (t) => {
  if (!requireYauzl(t)) return;
  const root = await fixtureRoot(t);
  const indexCache = new ArchiveIndexCache({ maxArchives: 2 });
  t.after(() => indexCache.close());
  const archive = await writeCbz(path.join(root, 'many-pages.cbz'), Array.from({ length: 128 }, (_, index) => ({
    name: `${String(index).padStart(4, '0')}.jpg`, content: `page-${index}`, method: index % 2 ? 8 : 0,
  })), { zip64: true });
  const pages = await listArchivePages(archive, { indexCache });
  indexCache.clear(); // Model a restart: persisted descriptors, no warm in-memory index.
  const yauzl = require('yauzl');
  const original = yauzl.ZipFile.prototype.readEntry;
  let reads = 0;
  yauzl.ZipFile.prototype.readEntry = function (...args) {
    reads += 1;
    return original.apply(this, args);
  };
  try {
    for (const index of [127, 3, ...pages.map((_, index) => index)]) {
      const target = path.join(root, `read-${reads}-${index}.tmp`);
      await extractArchivePage(archive, pages[index].archiveEntry, target, { indexCache });
      assert.equal(await fs.readFile(target, 'utf8'), `page-${index}`);
      await fs.unlink(target);
    }
    assert.equal(reads, pages.length + 1);
    assert.equal(indexCache.getStats().handles, 0);
    assert.equal(indexCache.getStats().count, 1);
    // Cache identity includes parsing budgets, so a warm lenient index cannot
    // bypass a tighter limit applied after configuration changes.
    await assert.rejects(listArchivePages(archive, { indexCache, maxEntries: 2 }), { code: 'ARCHIVE_LIMIT' });
  } finally {
    yauzl.ZipFile.prototype.readEntry = original;
  }
});
