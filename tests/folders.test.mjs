import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FolderBrowseError,
  browseAvailableFolders,
  listAvailableFolders,
} from '../server/folders.mjs';
import { naturalCompare } from '../server/utils.mjs';

async function createDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

test('listAvailableFolders returns detected mount roots and their child directories', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-folders-list-'));
  const libraryRoot = path.join(tempRoot, 'library');
  const externalRoot = path.join(tempRoot, 'taotu');

  await createDir(path.join(libraryRoot, 'Alice', 'Vol.1'));
  await createDir(path.join(externalRoot, 'Bob'));

  const items = await listAvailableFolders(path.join(tempRoot, 'unused'), {
    listMountRoots: async () => [externalRoot, libraryRoot],
  });

  assert.deepEqual(
    items.map((item) => item.path),
    [
      libraryRoot,
      path.join(libraryRoot, 'Alice'),
      path.join(libraryRoot, 'Alice', 'Vol.1'),
      externalRoot,
      path.join(externalRoot, 'Bob'),
    ],
  );
});

test('browseAvailableFolders returns top-level detected mount roots when no path is selected', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-folders-browse-root-'));
  const libraryRoot = path.join(tempRoot, 'library');
  const externalRoot = path.join(tempRoot, 'taotu');

  await createDir(libraryRoot);
  await createDir(externalRoot);

  const payload = await browseAvailableFolders(path.join(tempRoot, 'unused'), '', {
    listMountRoots: async () => [externalRoot, libraryRoot],
  });

  assert.equal(payload.currentPath, '');
  assert.equal(payload.parentPath, null);
  assert.deepEqual(
    payload.directories,
    [externalRoot, libraryRoot]
      .sort(naturalCompare)
      .map((mountRoot) => ({ name: mountRoot, path: mountRoot, type: 'directory' })),
  );
});

test('browseAvailableFolders lists child directories and returns root mount back-navigation as empty path', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-folders-browse-child-'));
  const libraryRoot = path.join(tempRoot, 'library');
  const externalRoot = path.join(tempRoot, 'taotu');

  await createDir(path.join(externalRoot, 'Alice'));
  await createDir(path.join(externalRoot, 'Bob'));

  const payload = await browseAvailableFolders(path.join(tempRoot, 'unused'), externalRoot, {
    listMountRoots: async () => [externalRoot, libraryRoot],
  });

  assert.equal(payload.currentPath, externalRoot);
  assert.equal(payload.parentPath, '');
  assert.deepEqual(payload.directories, [
    { name: 'Alice', path: path.join(externalRoot, 'Alice'), type: 'directory' },
    { name: 'Bob', path: path.join(externalRoot, 'Bob'), type: 'directory' },
  ]);
});

test('browseAvailableFolders falls back to the configured library root when no mount roots are detected', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-folders-fallback-'));
  const libraryRoot = path.join(tempRoot, 'library');

  await createDir(path.join(libraryRoot, 'Alice'));

  const payload = await browseAvailableFolders(libraryRoot, '', {
    listMountRoots: async () => [],
  });

  assert.equal(payload.currentPath, path.resolve(libraryRoot));
  assert.equal(payload.parentPath, null);
  assert.deepEqual(payload.directories, [
    { name: 'Alice', path: path.join(path.resolve(libraryRoot), 'Alice'), type: 'directory' },
  ]);
});

test('browseAvailableFolders rejects paths outside the configured library root in fallback mode', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-library-folders-outside-'));
  const libraryRoot = path.join(tempRoot, 'library');

  await createDir(libraryRoot);

  await assert.rejects(
    browseAvailableFolders(libraryRoot, path.join(tempRoot, 'elsewhere'), {
      listMountRoots: async () => [],
    }),
    (error) => {
      assert.ok(error instanceof FolderBrowseError);
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
});
