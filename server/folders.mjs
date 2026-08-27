import fsp from 'node:fs/promises';
import path from 'node:path';

import { listMountRoots } from './mounts.mjs';
import { naturalCompare, normalizeRelativeFolderPath } from './utils.mjs';

export class FolderBrowseError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'FolderBrowseError';
    this.statusCode = statusCode;
  }
}

async function ensureDirectory(targetPath, options = {}) {
  const stat = options.stat ?? fsp.stat;

  let stats;
  try {
    stats = await stat(targetPath);
  } catch {
    throw new FolderBrowseError(`Directory does not exist or is not readable: ${targetPath}`, 404);
  }

  if (!stats.isDirectory()) {
    throw new FolderBrowseError(`Path is not a directory: ${targetPath}`, 400);
  }
}

async function readDirectoryNames(currentDir, options = {}) {
  const readdir = options.readdir ?? fsp.readdir;

  let entries = [];
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch {
    throw new FolderBrowseError(`Failed to read directory: ${currentDir}`, 500);
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => naturalCompare(left.name, right.name));
}

function buildDirectoryItems(parentPath, entries) {
  return entries.map((entry) => ({
    name: entry.name,
    path: path.join(parentPath, entry.name),
    type: 'directory',
  }));
}

function dedupeAndSortRoots(rootPaths) {
  return [...new Set((rootPaths ?? []).filter(Boolean).map((rootPath) => path.resolve(rootPath)))]
    .sort(naturalCompare);
}

function isPathInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveRelativeBrowsePath(libraryRoot, browsePath) {
  const trimmed = String(browsePath ?? '').trim();
  if (!trimmed) {
    return libraryRoot;
  }

  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }

  const normalized = normalizeRelativeFolderPath(trimmed);
  return normalized ? path.resolve(libraryRoot, normalized) : libraryRoot;
}

async function getMountRoots(options = {}) {
  const readMountRoots = options.listMountRoots ?? listMountRoots;
  return dedupeAndSortRoots(await readMountRoots(options.mountRootOptions ?? {}));
}

export async function listRelativeFolders(libraryRoot, options = {}) {
  const resolvedRoot = path.resolve(libraryRoot);
  const items = [{ path: '', label: 'Root directory' }];

  await ensureDirectory(resolvedRoot, options);

  async function walk(currentDir) {
    const entries = await readDirectoryNames(currentDir, options);

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = normalizeRelativeFolderPath(path.relative(resolvedRoot, absolutePath));
      items.push({
        path: relativePath,
        label: relativePath || 'Root directory',
      });
      await walk(absolutePath);
    }
  }

  await walk(resolvedRoot);
  return items;
}

export async function listAbsoluteFolders(rootPath, options = {}) {
  const resolvedRoot = path.resolve(rootPath);
  const items = [];
  const seen = options.seen ?? new Set();
  const nestedRoots = new Set((options.nestedRoots ?? []).map((item) => path.resolve(item)));

  function pushFolder(folderPath) {
    const resolvedPath = path.resolve(folderPath);
    if (seen.has(resolvedPath)) {
      return;
    }

    seen.add(resolvedPath);
    items.push({
      path: resolvedPath,
      label: resolvedPath,
    });
  }

  pushFolder(resolvedRoot);

  try {
    await ensureDirectory(resolvedRoot, options);
  } catch (error) {
    if (error instanceof FolderBrowseError && error.statusCode === 404) {
      return items;
    }
    throw error;
  }

  async function walk(currentDir) {
    const entries = await readDirectoryNames(currentDir, options);

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      pushFolder(absolutePath);

      if (nestedRoots.has(path.resolve(absolutePath)) && path.resolve(absolutePath) !== resolvedRoot) {
        continue;
      }

      await walk(absolutePath);
    }
  }

  await walk(resolvedRoot);
  return items;
}

export async function listAvailableFolders(libraryRoot, options = {}) {
  const mountRoots = await getMountRoots(options);
  if (mountRoots.length === 0) {
    return listRelativeFolders(libraryRoot, options);
  }

  const items = [];
  const seen = new Set();

  for (const mountRoot of mountRoots) {
    const rootItems = await listAbsoluteFolders(mountRoot, {
      ...options,
      seen,
      nestedRoots: mountRoots,
    });
    items.push(...rootItems);
  }

  return items;
}

export async function browseAvailableFolders(libraryRoot, browsePath = '', options = {}) {
  const mountRoots = await getMountRoots(options);
  if (mountRoots.length > 0) {
    const trimmed = String(browsePath ?? '').trim();
    if (!trimmed) {
      return {
        currentPath: '',
        parentPath: null,
        directories: mountRoots.map((mountRoot) => ({
          name: mountRoot,
          path: mountRoot,
          type: 'directory',
        })),
      };
    }

    if (!path.isAbsolute(trimmed)) {
      throw new FolderBrowseError(`Path must be absolute when browsing detected mounts: ${trimmed}`, 400);
    }

    const currentPath = path.resolve(trimmed);
    await ensureDirectory(currentPath, options);

    return {
      currentPath,
      parentPath: mountRoots.includes(currentPath) ? '' : path.dirname(currentPath),
      directories: buildDirectoryItems(currentPath, await readDirectoryNames(currentPath, options)),
    };
  }

  const resolvedRoot = path.resolve(libraryRoot);
  const currentPath = resolveRelativeBrowsePath(resolvedRoot, browsePath);
  if (!isPathInside(resolvedRoot, currentPath)) {
    throw new FolderBrowseError(`Path is outside the library root: ${currentPath}`, 400);
  }

  await ensureDirectory(currentPath, options);

  return {
    currentPath,
    parentPath: currentPath === resolvedRoot ? null : path.dirname(currentPath),
    directories: buildDirectoryItems(currentPath, await readDirectoryNames(currentPath, options)),
  };
}
