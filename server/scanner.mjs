import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { DEFAULT_ARCHIVE_LIMITS, listArchivePages } from './archive.mjs';
import {
  ARCHIVE_EXTENSIONS,
  IMAGE_EXTENSIONS,
  formatPageTemplate,
  naturalCompare,
  normalizeArray,
  normalizeRelativeFolderPath,
  stableId,
  toPosixPath,
} from './utils.mjs';

const SCAN_FINGERPRINT_PREFIX = 'cbz-v2:';
const ARCHIVE_ISSUE_PREFIX = 'CBZ 读取失败: ';

/**
 * @typedef {Object} ScanProgress
 * @property {number} current - 当前已处理的 series 数量
 * @property {number} total - 候选 series 总数
 * @property {string|null} currentDir - 当前正在扫描的目录名
 * @property {'collecting'|'scanning'|'finalizing'} phase - 扫描阶段
 */

/**
 * @callback ProgressCallback
 * @param {ScanProgress} progress
 */

function createScanContext(options) {
  const fileStatConcurrency = Math.max(1, Math.trunc(options.fileStatConcurrency ?? 64));
  const statWaiters = [];
  let activeFileStats = 0;

  return {
    filesystem: options.filesystem ?? fs,
    listArchivePages: options.listArchivePages ?? listArchivePages,
    archiveOptions: options.archiveOptions ?? {},
    archiveIssues: [],
    directoryFacts: new Map(),
    directoryConsumers: new Map(),
    fileStats: new Map(),
    fileStatConcurrency,
    onDirectoryRead: options.onDirectoryRead,
    onFileStatStart: options.onFileStatStart,
    onFileStatEnd: options.onFileStatEnd,
    onDirectoryRelease: options.onDirectoryRelease,
    async prepareDirectoryConsumers(seriesDirs) {
      // A flat work reads its own directory and immediate children. Count those
      // exact consumers once, including nested candidates that share a read.
      for (const seriesDir of seriesDirs) {
        const root = path.resolve(seriesDir);
        const facts = await this.directoryFacts.get(root);
        const directories = [root, ...(facts?.directoryNames ?? []).map((name) => path.join(root, name))];
        for (const directory of directories) {
          this.directoryConsumers.set(directory, (this.directoryConsumers.get(directory) ?? 0) + 1);
        }
      }
      // Discovery can also visit empty ancestors and branches that are not works.
      // Once consumers are known, their names no longer need to remain resident.
      for (const directory of this.directoryFacts.keys()) {
        if (!this.directoryConsumers.has(directory)) this.directoryFacts.delete(directory);
      }
    },
    async releaseDirectoryTree(rootPath) {
      const root = path.resolve(rootPath);
      const facts = await this.directoryFacts.get(root);
      for (const directory of [root, ...(facts?.directoryNames ?? []).map((name) => path.join(root, name))]) {
        this.onDirectoryRelease?.(directory);
        const remaining = this.directoryConsumers.get(directory) - 1;
        if (remaining > 0) this.directoryConsumers.set(directory, remaining);
        else {
          this.directoryConsumers.delete(directory);
          this.directoryFacts.delete(directory);
        }
      }
    },
    async withFileStatSlot(task) {
      if (activeFileStats >= fileStatConcurrency) {
        await new Promise((resolve) => statWaiters.push(resolve));
      }

      activeFileStats += 1;
      this.onFileStatStart?.();
      try {
        return await task();
      } finally {
        this.onFileStatEnd?.();
        activeFileStats -= 1;
        statWaiters.shift()?.();
      }
    },
  };
}

async function readDirectoryFacts(dirPath, scanContext = null) {
  const resolvedPath = path.resolve(dirPath);
  if (scanContext?.directoryFacts.has(resolvedPath)) {
    return scanContext.directoryFacts.get(resolvedPath);
  }

  scanContext?.onDirectoryRead?.(resolvedPath);
  const task = (scanContext?.filesystem ?? fs)
    .readdir(resolvedPath, { withFileTypes: true })
    .then((entries) => {
      const imageNames = [];
      const archiveNames = [];
      const directoryNames = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          directoryNames.push(entry.name);
        } else if (
          entry.isFile() &&
          IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
        ) {
          imageNames.push(entry.name);
        } else if (
          entry.isFile() &&
          ARCHIVE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
        ) {
          archiveNames.push(entry.name);
        }
      }
      imageNames.sort(naturalCompare);
      archiveNames.sort(naturalCompare);
      directoryNames.sort(naturalCompare);
      return { imageNames, archiveNames, directoryNames };
    });
  scanContext?.directoryFacts.set(resolvedPath, task);
  return task;
}

function buildEmptySnapshot(libraryRoot, errorMessage = null) {
  return {
    lastScanAt: new Date().toISOString(),
    scanRoot: libraryRoot,
    stats: {
      seriesCount: 0,
      volumeCount: 0,
      chapterCount: 0,
      pageCount: 0,
      categories: [],
    },
    series: [],
    issues: errorMessage ? [errorMessage] : [],
    exportInfo: null,
  };
}

async function buildPageRecords(imagePaths, scanContext) {
  return runPool(imagePaths, async (imagePath, index) => {
    const fileStats = await getFileStats(imagePath, scanContext);
    return {
      index: index + 1,
      relativePath: path.basename(imagePath),
      sizeBytes: fileStats?.size ?? 0,
      mtimeMs: fileStats?.mtimeMs ?? 0,
    };
  }, scanContext?.fileStatConcurrency ?? 64);
}

function resolvePageSourcePath(chapter, page) {
  return path.join(chapter.sourcePath, page.relativePath);
}

async function listSubdirectories(dirPath, scanContext = null) {
  const facts = await readDirectoryFacts(dirPath, scanContext);
  return facts.directoryNames.map((name) => path.join(dirPath, name));
}

async function listImageFiles(dirPath, scanContext = null) {
  const facts = await readDirectoryFacts(dirPath, scanContext);
  return facts.imageNames.map((name) => path.join(dirPath, name));
}

async function listArchiveFiles(dirPath, scanContext) {
  const facts = await readDirectoryFacts(dirPath, scanContext);
  return facts.archiveNames.map((name) => path.join(dirPath, name));
}

/**
 * 获取单个文件的大小（字节），出错返回 0
 */
async function getFileStats(filePath, scanContext = null) {
  const resolvedPath = path.resolve(filePath);
  if (scanContext?.fileStats.has(resolvedPath)) {
    return scanContext.fileStats.get(resolvedPath);
  }

  const readStats = async () => {
    try {
      return await (scanContext?.filesystem ?? fs).stat(resolvedPath);
    } catch {
      return null;
    }
  };
  const task = scanContext ? scanContext.withFileStatSlot(readStats) : readStats();
  scanContext?.fileStats.set(resolvedPath, task);
  try {
    return await task;
  } finally {
    // 页面 stat 只需在同一时刻去重；完成后立即释放，避免百万页扫描积累 Promise。
    if (scanContext?.fileStats.get(resolvedPath) === task) {
      scanContext.fileStats.delete(resolvedPath);
    }
  }
}

/**
 * 获取目录的 mtime（用于增量扫描判断）
 * 返回 ISO 字符串，出错返回 null
 */
async function getDirMtime(dirPath, scanContext = null) {
  try {
    const stat = await (scanContext?.filesystem ?? fs).stat(dirPath);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

function parseFolderMetadata(folderName, folderPattern) {
  if (!folderPattern.enabled) {
    return { title: folderName, author: null, autoCategories: [] };
  }

  const separator = folderPattern.separator || '-';
  const stripTokens = new Set((folderPattern.stripTokens ?? []).map((token) => token.toLowerCase()));
  const segments = folderName
    .split(separator)
    .map((segment) => segment.trim())
    .filter(Boolean);

  while (segments.length > 0 && stripTokens.has(segments.at(-1).toLowerCase())) {
    segments.pop();
  }

  const title = segments[folderPattern.titleSegmentIndex] || folderName;
  const autoCategories = [];

  if (
    Number.isInteger(folderPattern.categorySegmentIndex) &&
    folderPattern.categorySegmentIndex >= 0 &&
    segments[folderPattern.categorySegmentIndex]
  ) {
    autoCategories.push(segments[folderPattern.categorySegmentIndex]);
  }

  // 作者段解析
  let author = null;
  if (
    Number.isInteger(folderPattern.authorSegmentIndex) &&
    folderPattern.authorSegmentIndex >= 0 &&
    segments[folderPattern.authorSegmentIndex]
  ) {
    author = segments[folderPattern.authorSegmentIndex].trim() || null;
  }

  return {
    title: title.trim() || folderName,
    author,
    autoCategories: normalizeArray(autoCategories),
  };
}

function parseFlatFolderMetadata(folderName) {
  return {
    title: folderName,
    author: null,
    autoCategories: [],
  };
}

const GENERIC_GROUP_FOLDER_NAMES = new Set([
  '其它',
  '其他',
  'misc',
  'other',
  'others',
  'etc',
  '合集',
  'collection',
  'collections',
  'archive',
  'archives',
]);

const CHAPTER_FOLDER_PATTERNS = [
  /^(pic|pics|image|images|photo|photos|picture|pictures|gallery|album)\d*$/i,
  /^(wallpaper|wallpapers|phonewallpaper|mobilewallpaper|desktopwallpaper|preview|sample|bonus|extra|cover|raw|full|hd|uhd|4k|gif|gifs|video|videos)\d*$/i,
  /^(chapter|ch|part|set|vol|volume)\d+$/i,
  /^(壁纸|手机壁纸|电脑壁纸|原图|原版|预览|特典|封面|花絮|自拍|视频|图包|正片|横屏|竖屏|动图|表情包)\d*$/i,
];

function normalizeFolderToken(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s._-]+/g, '');
}

function isGenericGroupFolderName(folderName) {
  return GENERIC_GROUP_FOLDER_NAMES.has(normalizeFolderToken(folderName));
}

function isChapterLikeFolderName(folderName) {
  const normalized = normalizeFolderToken(folderName);
  return CHAPTER_FOLDER_PATTERNS.some((pattern) => pattern.test(normalized));
}

function shouldGroupChildImageDirsAsChapters(seriesDir, childImageDirs) {
  if (childImageDirs.length === 0) {
    return false;
  }

  if (isGenericGroupFolderName(path.basename(seriesDir))) {
    return false;
  }

  return childImageDirs
    .map((childDir) => path.basename(childDir))
    .some((childName) => isChapterLikeFolderName(childName));
}

function isSameOrChildFolder(parentFolder, childFolder) {
  if (!parentFolder) {
    return false;
  }

  return childFolder === parentFolder || childFolder.startsWith(`${parentFolder}/`);
}

function isAbsoluteConfiguredFolder(folder) {
  const normalized = String(folder ?? '').trim();
  return Boolean(normalized) && (normalized.startsWith('/') || path.isAbsolute(normalized));
}

function resolveConfiguredFolderPath(folder, libraryRoot) {
  const normalized = String(folder ?? '').trim();
  if (!normalized) {
    return '';
  }

  if (isAbsoluteConfiguredFolder(normalized)) {
    return path.resolve(normalized);
  }

  const relativeFolder = normalizeRelativeFolderPath(normalized);
  return relativeFolder ? path.resolve(libraryRoot, relativeFolder) : '';
}

function isPathInside(parentPath, childPath) {
  const relativePath = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function buildSeriesSourceKey(seriesDir, libraryRoot) {
  const absoluteSeriesDir = path.resolve(seriesDir);
  if (isPathInside(libraryRoot, absoluteSeriesDir)) {
    return toPosixPath(path.relative(libraryRoot, absoluteSeriesDir));
  }

  return toPosixPath(absoluteSeriesDir);
}

function resolveFolderCategories(seriesDir, seriesSourceKey, settings, libraryRoot) {
  const absoluteSeriesDir = toPosixPath(path.resolve(seriesDir));
  return normalizeArray(
    (settings.categoryFolders ?? [])
      .filter((item) => {
        const folder = String(item.folder ?? '').trim();
        if (!folder) {
          return false;
        }

        if (isAbsoluteConfiguredFolder(folder)) {
          return isSameOrChildFolder(toPosixPath(path.resolve(folder)), absoluteSeriesDir);
        }

        const relativeFolder = normalizeRelativeFolderPath(folder);
        return relativeFolder ? isSameOrChildFolder(relativeFolder, seriesSourceKey) : false;
      })
      .map((item) => item.name),
  );
}

async function buildChapter({
  chapterDir,
  chapterTitle,
  volumeTitle,
  imagePaths,
  seriesSourceKey,
  relativeInsideVolume,
  scanContext,
}) {
  const chapterSourceKey = toPosixPath(
    path.join(seriesSourceKey, volumeTitle, relativeInsideVolume || '@root'),
  );
  const chapterId = stableId(`chapter:${chapterDir}`);
  const pages = await buildPageRecords(imagePaths, scanContext);
  const totalBytes = pages.reduce((sum, page) => sum + page.sizeBytes, 0);

  return {
    id: chapterId,
    title: chapterTitle,
    sourcePath: chapterDir,
    sourceKey: chapterSourceKey,
    volumeTitle,
    pageCount: pages.length,
    totalBytes,
    pages,
  };
}

async function buildArchiveChapter({ archivePath, volumeTitle, seriesSourceKey, relativePath, scanContext, previousChapter }) {
  try {
    const id = stableId(`chapter:archive:${path.resolve(archivePath)}`);
    const sourceKey = toPosixPath(path.join(seriesSourceKey, volumeTitle, relativePath));
    const title = toPosixPath(relativePath.slice(0, -path.extname(relativePath).length));
    const limits = Object.fromEntries(Object.entries(DEFAULT_ARCHIVE_LIMITS).map(([name, fallback]) => {
      const value = Number((scanContext.archiveOptions.limits ?? scanContext.archiveOptions)[name]);
      return [name, Number.isSafeInteger(value) && value > 0 ? value : fallback];
    }));
    const stats = await getFileStats(archivePath, scanContext);
    const previousSource = previousChapter?.archiveSource;
    if (stats?.isFile() && previousChapter?.id === id && previousChapter.sourceKey === sourceKey &&
        previousSource?.version === 1 && previousSource.identity && previousSource.firstPage?.archiveEntry &&
        previousChapter.scanFingerprint?.startsWith('cbz-chapter-v1:') &&
        previousSource.identity.size === stats.size && previousSource.identity.mtimeMs === stats.mtimeMs &&
        previousSource.identity.ctimeMs === stats.ctimeMs &&
        JSON.stringify(previousSource.limits) === JSON.stringify(limits)) {
      // Runtime snapshots intentionally have no pages. The writer preserves this
      // chapter's SQLite rows; firstPage retains only what cover selection needs.
      return { ...previousChapter, title, volumeTitle, pages: [], _reused: true };
    }
    const archivePages = await scanContext.listArchivePages(archivePath, scanContext.archiveOptions);
    if (archivePages.length === 0) throw new Error('归档内没有可阅读的图片');
    const pages = archivePages.map((page, index) => ({ ...page, index: index + 1 }));
    const fingerprint = crypto.createHash('sha256');
    for (const page of pages) fingerprint.update(JSON.stringify(page));
    return {
      id,
      title,
      sourcePath: archivePath,
      sourceKey,
      volumeTitle,
      pageCount: pages.length,
      totalBytes: pages.reduce((sum, page) => sum + page.sizeBytes, 0),
      scanFingerprint: `cbz-chapter-v1:${fingerprint.digest('hex')}`,
      archiveSource: {
        version: 1,
        identity: { ...pages[0].archiveEntry.archiveIdentity },
        firstPage: pages[0],
        latestPageMtime: pages.reduce((latest, page) => Math.max(latest, page.mtimeMs), 0),
        limits,
      },
      pages,
    };
  } catch (error) {
    // A damaged or unsupported archive must not discard the rest of the library.
    scanContext.archiveIssues.push(`${ARCHIVE_ISSUE_PREFIX}${toPosixPath(archivePath)} (${error.message})`);
    return null;
  }
}

function selectExternalCoverImages(imagePaths, hasArchiveContext) {
  if (!hasArchiveContext) return [];
  const namedCovers = imagePaths.filter((imagePath) => {
    const name = path.basename(imagePath, path.extname(imagePath));
    return /^(cover|folder|封面)$/i.test(name);
  });
  // A lone accompanying image is conventionally an external cover. Other loose
  // pages retain their existing chapter so mixed directories never lose content.
  return namedCovers.length > 0 ? namedCovers : imagePaths.length === 1 ? imagePaths : [];
}

async function collectVolumeChapters(volumeDir, volumeTitle, settings, seriesSourceKey, scanContext) {
  const chapters = [];
  const directImages = await listImageFiles(volumeDir, scanContext);

  if (directImages.length > 0) {
    chapters.push(
      await buildChapter({
        chapterDir: volumeDir,
        chapterTitle: formatPageTemplate(settings.naming.directImageChapterTemplate, directImages.length),
        volumeTitle,
        imagePaths: directImages,
        seriesSourceKey,
        relativeInsideVolume: '@root',
      }),
    );
  }

  async function walk(nodeDir) {
    const childDirs = await listSubdirectories(nodeDir, scanContext);

    for (const childDir of childDirs) {
      const childImages = await listImageFiles(childDir, scanContext);
      if (childImages.length > 0) {
        const relativePath = toPosixPath(path.relative(volumeDir, childDir));
        chapters.push(
          await buildChapter({
            chapterDir: childDir,
            chapterTitle: relativePath,
            volumeTitle,
            imagePaths: childImages,
            seriesSourceKey,
            relativeInsideVolume: relativePath,
            scanContext,
          }),
        );
      }

      await walk(childDir);
    }
  }

  await walk(volumeDir);
  return chapters;
}

async function scanSeries(seriesDir, libraryRoot, settings, overrides, previousSeries = null) {
  const folderName = path.basename(seriesDir);
  const seriesSourceKey = buildSeriesSourceKey(seriesDir, libraryRoot);

  // 增量扫描：检查目录 mtime 是否变化
  const dirMtime = await getDirMtime(seriesDir);
  if (previousSeries && previousSeries.dirMtime && dirMtime === previousSeries.dirMtime) {
    // 目录未变化，复用之前的扫描结果（但重新计算分类，因为分类配置可能变了）
    const { title, author, autoCategories } = parseFolderMetadata(folderName, settings.folderPattern);
    const folderCategories = resolveFolderCategories(seriesDir, seriesSourceKey, settings, libraryRoot);
    const manualCategories = normalizeArray(overrides.seriesCategories[seriesSourceKey]);
    return {
      ...previousSeries,
      title,
      author,
      categories: {
        auto: autoCategories,
        folder: folderCategories,
        manual: manualCategories,
        effective: normalizeArray([...autoCategories, ...folderCategories, ...manualCategories]),
      },
      dirMtime,
      _reused: true,
    };
  }

  const { title, author, autoCategories } = parseFolderMetadata(folderName, settings.folderPattern);
  const folderCategories = resolveFolderCategories(seriesDir, seriesSourceKey, settings, libraryRoot);
  const manualCategories = normalizeArray(overrides.seriesCategories[seriesSourceKey]);
  const volumes = [];

  const rootImages = await listImageFiles(seriesDir);
  if (rootImages.length > 0) {
    const syntheticVolumeTitle = settings.naming.defaultVolumeName;
    const chapter = await buildChapter({
      chapterDir: seriesDir,
      chapterTitle: formatPageTemplate(settings.naming.directImageChapterTemplate, rootImages.length),
      volumeTitle: syntheticVolumeTitle,
      imagePaths: rootImages,
      seriesSourceKey,
      relativeInsideVolume: '@root',
    });

    volumes.push({
      id: stableId(`volume:${seriesDir}:root`),
      title: syntheticVolumeTitle,
      sourcePath: seriesDir,
      synthetic: true,
      chapters: [chapter],
    });
  }

  const volumeDirs = await listSubdirectories(seriesDir);
  for (const volumeDir of volumeDirs) {
    const volumeTitle = path.basename(volumeDir);
    const chapters = await collectVolumeChapters(volumeDir, volumeTitle, settings, seriesSourceKey);
    if (chapters.length === 0) {
      continue;
    }

    volumes.push({
      id: stableId(`volume:${volumeDir}`),
      title: volumeTitle,
      sourcePath: volumeDir,
      synthetic: false,
      chapters,
    });
  }

  if (volumes.length === 0) {
    return null;
  }

  const firstChapter = volumes[0]?.chapters[0];
  const coverPath = firstChapter?.pages[0]
    ? resolvePageSourcePath(firstChapter, firstChapter.pages[0])
    : null;
  const chapterCount = volumes.reduce((total, volume) => total + volume.chapters.length, 0);
  const pageCount = volumes.reduce((total, volume) => {
    return total + volume.chapters.reduce((chapterTotal, chapter) => chapterTotal + chapter.pageCount, 0);
  }, 0);
  const totalBytes = volumes.reduce((total, volume) => {
    return total + volume.chapters.reduce((chapterTotal, chapter) => chapterTotal + (chapter.totalBytes ?? 0), 0);
  }, 0);

  return {
    id: stableId(`series:${seriesSourceKey}`),
    title,
    author,
    sourceFolderName: folderName,
    sourceKey: seriesSourceKey,
    sourcePath: seriesDir,
    dirMtime,
    metadata: {},
    tags: [],
    categories: {
      auto: autoCategories,
      folder: folderCategories,
      manual: manualCategories,
      effective: normalizeArray([...autoCategories, ...folderCategories, ...manualCategories]),
    },
    cover: coverPath
      ? {
          sourcePath: coverPath,
          fileName: path.basename(coverPath),
        }
      : null,
    counts: {
      volumes: volumes.length,
      chapters: chapterCount,
      pages: pageCount,
    },
    totalBytes,
    volumes,
  };
}

/**
 * Flat 模式扫描：只取目录内直接图片，生成单卷单章节的系列
 */
function buildSeriesFingerprint(chapters, coverIdentity) {
  const hash = crypto.createHash('sha256');
  hash.update(SCAN_FINGERPRINT_PREFIX);
  for (const chapter of chapters) {
    hash.update(JSON.stringify([chapter.id, chapter.sourceKey, chapter.sourcePath]));
    if (chapter.archiveSource && chapter.scanFingerprint) {
      hash.update(chapter.scanFingerprint);
      continue;
    }
    for (const page of chapter.pages) {
      hash.update(JSON.stringify([
        toPosixPath(page.relativePath), page.sizeBytes, page.mtimeMs, page.archiveEntry ?? null,
      ]));
    }
  }
  hash.update(JSON.stringify(coverIdentity));
  return `${SCAN_FINGERPRINT_PREFIX}${hash.digest('hex')}`;
}

function dirtyPathsIntersectSeries(seriesDir, dirtyPaths) {
  return dirtyPaths.some((dirtyPath) => {
    return isPathInside(seriesDir, dirtyPath) || isPathInside(dirtyPath, seriesDir);
  });
}

async function scanSeriesFlat(
  seriesDir,
  libraryRoot,
  settings,
  overrides,
  previousSeries = null,
  scanContext = null,
  dirtyPaths = [],
) {
  const folderName = path.basename(seriesDir);
  const seriesSourceKey = buildSeriesSourceKey(seriesDir, libraryRoot);

  const dirMtime = await getDirMtime(seriesDir, scanContext);
  const canReuseFlatSeries =
    previousSeries &&
    previousSeries.scanFingerprint?.startsWith(SCAN_FINGERPRINT_PREFIX) &&
    previousSeries.counts?.volumes === 0 &&
    previousSeries.volumes?.length === 1 &&
    previousSeries.volumes[0]?.synthetic === true;

  // watcher 指明其它路径变化时，本作品无需重新枚举或 stat。
  if (canReuseFlatSeries && dirtyPaths.length > 0 && !dirtyPathsIntersectSeries(seriesDir, dirtyPaths)) {
    const { title, author, autoCategories } = parseFlatFolderMetadata(folderName);
    const folderCategories = resolveFolderCategories(seriesDir, seriesSourceKey, settings, libraryRoot);
    const manualCategories = normalizeArray(overrides.seriesCategories[seriesSourceKey]);
    return {
      ...previousSeries,
      title,
      author,
      categories: {
        auto: autoCategories,
        folder: folderCategories,
        manual: manualCategories,
        effective: normalizeArray([...autoCategories, ...folderCategories, ...manualCategories]),
      },
      counts: {
        ...previousSeries.counts,
        volumes: 0,
      },
      dirMtime,
      _reused: true,
    };
  }

  const { title, author, autoCategories } = parseFlatFolderMetadata(folderName);
  const folderCategories = resolveFolderCategories(seriesDir, seriesSourceKey, settings, libraryRoot);
  const manualCategories = normalizeArray(overrides.seriesCategories[seriesSourceKey]);

  const images = await listImageFiles(seriesDir, scanContext);
  const archives = await listArchiveFiles(seriesDir, scanContext);
  const childDirs = await listSubdirectories(seriesDir, scanContext);
  const chapterDirEntries = [];

  for (const childDir of childDirs) {
    const childImages = await listImageFiles(childDir, scanContext);
    const childArchives = await listArchiveFiles(childDir, scanContext);
    if (childImages.length > 0 || childArchives.length > 0) {
      chapterDirEntries.push({ dir: childDir, images: childImages, archives: childArchives });
    }
  }

  const shouldGroupChildChapters = shouldGroupChildImageDirsAsChapters(
    seriesDir,
    chapterDirEntries.map((item) => item.dir),
  );

  if (images.length === 0 && archives.length === 0 && !shouldGroupChildChapters) {
    return null;
  }

  const syntheticVolumeTitle = settings.naming.defaultVolumeName;
  const chapters = [];
  const externalCoverPaths = [];
  const contentDirectories = [
    { dir: seriesDir, images, archives },
    ...(shouldGroupChildChapters ? chapterDirEntries : []),
  ];
  const hasArchives = contentDirectories.some((item) => item.archives.length > 0);
  const previousChapters = new Map((previousSeries?.volumes ?? [])
    .flatMap((volume) => volume.chapters).map((chapter) => [chapter.sourcePath, chapter]));

  for (const item of contentDirectories) {
    const isRoot = item.dir === seriesDir;
    const coverImages = selectExternalCoverImages(item.images, item.archives.length > 0 || (isRoot && hasArchives));
    externalCoverPaths.push(...coverImages);
    const coverSet = new Set(coverImages);
    const bodyImages = item.images.filter((imagePath) => !coverSet.has(imagePath));
    const chapterTitle = isRoot
      ? formatPageTemplate(settings.naming.directImageChapterTemplate, bodyImages.length)
      : path.basename(item.dir);

    if (bodyImages.length > 0) {
      chapters.push(
        await buildChapter({
          chapterDir: item.dir,
          chapterTitle,
          volumeTitle: syntheticVolumeTitle,
          imagePaths: bodyImages,
          seriesSourceKey,
          relativeInsideVolume: isRoot ? '@root' : chapterTitle,
          scanContext,
        }),
      );
    }

    for (const archivePath of item.archives) {
      const chapter = await buildArchiveChapter({
        archivePath,
        volumeTitle: syntheticVolumeTitle,
        seriesSourceKey,
        relativePath: path.relative(seriesDir, archivePath),
        scanContext,
        previousChapter: previousChapters.get(archivePath),
      });
      if (chapter) chapters.push(chapter);
    }
  }

  // A broken archive plus a cover must not become a successful one-page comic.
  if (chapters.length === 0) return null;

  const volumes = [
    {
      id: stableId(`volume:${seriesDir}:root`),
      title: syntheticVolumeTitle,
      sourcePath: seriesDir,
      synthetic: true,
      chapters,
    },
  ];

  const firstArchiveChapter = chapters.find((chapter) => chapter.archiveSource || chapter.pages[0]?.archiveEntry);
  const coverChapter = firstArchiveChapter ?? chapters[0];
  const coverPage = coverChapter.archiveSource?.firstPage ?? coverChapter.pages[0];
  const externalCoverPath = externalCoverPaths[0] ?? null;
  const externalCoverStats = externalCoverPath ? await getFileStats(externalCoverPath, scanContext) : null;
  const coverPath = externalCoverPath ?? coverPage.sourcePath ?? resolvePageSourcePath(coverChapter, coverPage);
  const cover = {
    sourcePath: coverPath,
    fileName: externalCoverPath ? path.basename(externalCoverPath) : path.basename(coverPage.relativePath),
    ...(!externalCoverPath && coverPage.archiveEntry ? { archiveEntry: coverPage.archiveEntry } : {}),
  };
  const pageCount = chapters.reduce((total, chapter) => total + chapter.pageCount, 0);
  const totalBytes = chapters.reduce((total, chapter) => total + (chapter.totalBytes ?? 0), 0);
  const scanFingerprint = buildSeriesFingerprint(chapters, {
    ...cover,
    sizeBytes: externalCoverStats?.size ?? coverPage.sizeBytes,
    mtimeMs: externalCoverStats?.mtimeMs ?? coverPage.mtimeMs,
    ctimeMs: externalCoverStats?.ctimeMs ?? null,
  });
  const latestPageMtime = chapters.reduce((latest, chapter) => {
    if (chapter.archiveSource) return Math.max(latest, chapter.archiveSource.latestPageMtime);
    return chapter.pages.reduce((chapterLatest, page) => Math.max(chapterLatest, page.mtimeMs), latest);
  }, externalCoverStats?.mtimeMs ?? 0);

  // 周期扫描没有 dirty path 可依赖时，用文件身份指纹判断复用，避免目录
  // mtime 不变时漏掉原地替换的图片。
  if (canReuseFlatSeries && previousSeries.scanFingerprint === scanFingerprint) {
    return {
      ...previousSeries,
      title,
      author,
      categories: {
        auto: autoCategories,
        folder: folderCategories,
        manual: manualCategories,
        effective: normalizeArray([...autoCategories, ...folderCategories, ...manualCategories]),
      },
      counts: { ...previousSeries.counts, volumes: 0 },
      dirMtime,
      scanFingerprint,
      _reused: true,
    };
  }

  return {
    id: stableId(`series:${seriesSourceKey}`),
    title,
    author,
    sourceFolderName: folderName,
    sourceKey: seriesSourceKey,
    sourcePath: seriesDir,
    dirMtime,
    scanFingerprint,
    updatedAt: latestPageMtime > 0 ? new Date(latestPageMtime).toISOString() : new Date().toISOString(),
    metadata: {},
    tags: [],
    categories: {
      auto: autoCategories,
      folder: folderCategories,
      manual: manualCategories,
      effective: normalizeArray([...autoCategories, ...folderCategories, ...manualCategories]),
    },
    cover,
    counts: {
      volumes: 0,
      chapters: chapters.length,
      pages: pageCount,
    },
    totalBytes,
    volumes,
  };
}

function shouldSkipRootChild(childDir, settings, libraryRoot) {
  const relativePath = toPosixPath(path.relative(libraryRoot, childDir));
  const absolutePath = toPosixPath(path.resolve(childDir));
  const absoluteLibraryRoot = toPosixPath(path.resolve(libraryRoot));

  return (settings.categoryFolders ?? []).some((item) => {
    const folder = String(item.folder ?? '').trim();
    if (!folder) {
      return false;
    }

    if (isAbsoluteConfiguredFolder(folder)) {
      const absoluteFolder = toPosixPath(path.resolve(folder));
      return absoluteFolder === absoluteLibraryRoot || isSameOrChildFolder(absolutePath, absoluteFolder);
    }

    const relativeFolder = normalizeRelativeFolderPath(folder);
    return relativeFolder ? isSameOrChildFolder(relativePath, relativeFolder) : false;
  });
}

async function collectCandidateSeriesDirs(libraryRoot, settings, scanContext = null) {
  const candidates = new Map();

  try {
    const rootChildren = await listSubdirectories(libraryRoot, scanContext);
    for (const childDir of rootChildren) {
      if (shouldSkipRootChild(childDir, settings, libraryRoot)) {
        continue;
      }

      const candidate = path.resolve(childDir);
      candidates.set(candidate, candidate);
    }
  } catch {
    // libraryRoot 不存在或不可读时跳过，继续处理 categoryFolders
  }

  for (const item of settings.categoryFolders ?? []) {
    const categoryRoot = resolveConfiguredFolderPath(item.folder, libraryRoot);
    if (!categoryRoot) {
      continue;
    }

    try {
      const stats = await (scanContext?.filesystem ?? fs).stat(categoryRoot);
      if (!stats.isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    const categoryChildren = await listSubdirectories(categoryRoot, scanContext);
    for (const childDir of categoryChildren) {
      const candidate = path.resolve(childDir);
      candidates.set(candidate, candidate);
    }
  }

  return [...candidates.values()].sort((left, right) => {
    return naturalCompare(buildSeriesSourceKey(left, libraryRoot), buildSeriesSourceKey(right, libraryRoot));
  });
}

/**
 * Flat 模式：递归查找系列目录
 * - 目录直接包含图片 → 当前目录作为系列候选
 * - 目录的直接子目录里如果出现“章节样式”的图片目录 → 当前目录作为系列候选
 * - 其它情况继续递归子目录
 * - 同时扫描 libraryRoot 和所有 categoryFolders 绑定的目录
 */
async function collectFlatCandidateSeriesDirs(
  libraryRoot,
  settings,
  scanContext = null,
  traversalRoots = null,
) {
  const seen = new Set();
  const candidates = [];

  async function walk(dirPath) {
    let facts;
    try {
      facts = await readDirectoryFacts(dirPath, scanContext);
    } catch {
      return;
    }

    const imageFiles = facts.imageNames;
    const childDirs = facts.directoryNames.map((name) => path.join(dirPath, name));

    const childImageDirs = [];
    for (const childDir of childDirs) {
      const childImages = await listImageFiles(childDir, scanContext);
      const childArchives = await listArchiveFiles(childDir, scanContext);
      if (childImages.length > 0 || childArchives.length > 0) {
        childImageDirs.push(childDir);
      }
    }

    const shouldGroupChildChapters = shouldGroupChildImageDirsAsChapters(dirPath, childImageDirs);

    if (imageFiles.length > 0 || facts.archiveNames.length > 0 || shouldGroupChildChapters) {
      const resolved = path.resolve(dirPath);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        candidates.push(resolved);
      }
      if (shouldGroupChildChapters) {
        return;
      }
    }

    for (const childDir of childDirs) {
      await walk(childDir);
    }
  }

  // watcher 增量扫描只进入脏路径对应的作品/顶层分支，避免重新枚举整个图库。
  if (traversalRoots) {
    for (const traversalRoot of traversalRoots) {
      await walk(traversalRoot);
    }
    return candidates.sort((left, right) => {
      return naturalCompare(
        buildSeriesSourceKey(left, libraryRoot),
        buildSeriesSourceKey(right, libraryRoot),
      );
    });
  }

  // 全量/周期扫描仍从所有配置根目录执行单次 DFS。
  await walk(libraryRoot);

  // 扫描 categoryFolders 绑定的目录
  for (const item of settings.categoryFolders ?? []) {
    const categoryRoot = resolveConfiguredFolderPath(item.folder, libraryRoot);
    if (!categoryRoot) {
      continue;
    }

    try {
      const stats = await (scanContext?.filesystem ?? fs).stat(categoryRoot);
      if (!stats.isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    await walk(categoryRoot);
  }

  return candidates.sort((left, right) => {
    return naturalCompare(
      buildSeriesSourceKey(left, libraryRoot),
      buildSeriesSourceKey(right, libraryRoot),
    );
  });
}

function collectConfiguredScanRoots(libraryRoot, settings) {
  const roots = new Set([path.resolve(libraryRoot)]);
  for (const item of settings.categoryFolders ?? []) {
    const categoryRoot = resolveConfiguredFolderPath(item.folder, libraryRoot);
    if (categoryRoot) roots.add(path.resolve(categoryRoot));
  }
  return [...roots];
}

function buildDirtyTraversalScope(libraryRoot, settings, previousSeries, dirtyPaths) {
  const configuredRoots = collectConfiguredScanRoots(libraryRoot, settings);
  const knownSeriesDirs = previousSeries
    .map((seriesItem) => seriesItem.sourcePath && path.resolve(seriesItem.sourcePath))
    .filter(Boolean);
  const traversalRoots = new Set();
  const affectedKnownSeries = new Set();

  for (const dirtyPath of dirtyPaths) {
    let matchedKnownSeries = false;
    for (const seriesDir of knownSeriesDirs) {
      if (dirtyPathsIntersectSeries(seriesDir, [dirtyPath])) {
        traversalRoots.add(seriesDir);
        affectedKnownSeries.add(seriesDir);
        matchedKnownSeries = true;
      }
    }
    if (matchedKnownSeries) continue;

    // 新作品尚不在上次快照中。从所属扫描根的第一个子目录开始发现，
    // 既能识别父作品 + 章节结构，也不会触碰其它顶层分支。
    const configuredRoot = configuredRoots
      .filter((root) => isPathInside(root, dirtyPath))
      .sort((left, right) => right.length - left.length)[0];
    if (!configuredRoot) continue;

    const relativePath = path.relative(configuredRoot, dirtyPath);
    const segments = relativePath.split(path.sep).filter(Boolean);
    if (segments.length === 0) {
      traversalRoots.add(configuredRoot);
    } else if (
      segments.length === 1 &&
      (IMAGE_EXTENSIONS.has(path.extname(segments[0]).toLowerCase()) ||
        ARCHIVE_EXTENSIONS.has(path.extname(segments[0]).toLowerCase()))
    ) {
      traversalRoots.add(configuredRoot);
    } else {
      traversalRoots.add(path.join(configuredRoot, segments[0]));
    }
  }

  return {
    traversalRoots: [...traversalRoots],
    affectedKnownSeries,
  };
}

/**
 * 受控并发 Promise 池
 * @param {Array} items - 待处理项
 * @param {Function} fn - 异步处理函数 (item, index) => result
 * @param {number} concurrency - 最大并发数
 */
async function runPool(items, fn, concurrency = 8) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * 扫描图库
 * @param {object} settings - 扫描设置
 * @param {object} overrides - 用户覆盖（手动分类等）
 * @param {object} [options] - 可选参数
 * @param {ProgressCallback} [options.onProgress] - 进度回调
 * @param {object|null} [options.previousLibrary] - 上次扫描结果（用于增量扫描）
 */
export async function scanLibrary(settings, overrides, options = {}) {
  const { onProgress, previousLibrary } = options;
  const libraryRoot = path.resolve(settings.libraryRoot);
  const issues = [];
  const scanContext = createScanContext(options);
  const dirtyPaths = normalizeArray(options.dirtyPaths).map((item) => path.resolve(item));

  let rootExists = false;
  try {
    const stats = await scanContext.filesystem.stat(libraryRoot);
    if (stats.isDirectory()) {
      rootExists = true;
    } else {
      issues.push(`扫描目录不是文件夹: ${libraryRoot}`);
    }
  } catch {
    issues.push(`扫描目录不存在: ${libraryRoot}`);
  }

  // 即使 libraryRoot 不存在，如果有 categoryFolders 配置了有效的绝对路径，仍继续扫描
  const hasCategoryFolders = (settings.categoryFolders ?? []).some((item) => {
    const folder = String(item?.folder ?? '').trim();
    return folder && (folder.startsWith('/') || path.isAbsolute(folder));
  });

  if (!rootExists && !hasCategoryFolders) {
    return buildEmptySnapshot(libraryRoot, issues[0] ?? null);
  }

  // 构建上次扫描的 sourceKey → series 映射（用于增量扫描）
  const previousSeriesMap = new Map();
  if (previousLibrary?.series) {
    for (const s of previousLibrary.series) {
      if (s.sourceKey) {
        previousSeriesMap.set(s.sourceKey, s);
      }
    }
  }

  if (onProgress) {
    onProgress({ current: 0, total: 0, currentDir: null, phase: 'collecting' });
  }

  // Old image-only snapshots must receive a complete discovery pass on upgrade;
  // otherwise untouched cover-only series could remain unreadable indefinitely.
  const canUseDirtyScope = dirtyPaths.length > 0 && previousSeriesMap.size > 0 &&
    [...previousSeriesMap.values()].every((series) => series.scanFingerprint?.startsWith(SCAN_FINGERPRINT_PREFIX));
  const dirtyScope = canUseDirtyScope
    ? buildDirtyTraversalScope(libraryRoot, settings, previousLibrary.series, dirtyPaths)
    : null;
  if (dirtyScope) {
    // Issues live in the persisted snapshot, not page summaries. Keep failures
    // outside this scan's scope until their own directory is actually rescanned.
    for (const issue of previousLibrary.issues ?? []) {
      if (!issue.startsWith(ARCHIVE_ISSUE_PREFIX)) continue;
      const wasRescanned = dirtyScope.traversalRoots.some((root) => {
        const prefix = `${ARCHIVE_ISSUE_PREFIX}${toPosixPath(path.resolve(root)).replace(/\/$/, '')}/`;
        return issue.startsWith(prefix);
      });
      if (!wasRescanned) issues.push(issue);
    }
  }
  const seriesDirs = await collectFlatCandidateSeriesDirs(
    libraryRoot,
    settings,
    scanContext,
    dirtyScope?.traversalRoots ?? null,
  );
  const candidatePaths = new Set(seriesDirs.map((seriesDir) => path.resolve(seriesDir)));
  const untouchedSeries = canUseDirtyScope
    ? previousLibrary.series
      .filter((seriesItem) => {
        const sourcePath = seriesItem.sourcePath && path.resolve(seriesItem.sourcePath);
        return sourcePath &&
          !candidatePaths.has(sourcePath) &&
          !dirtyScope.affectedKnownSeries.has(sourcePath);
      })
      .map((seriesItem) => ({ ...seriesItem, _reused: true }))
    : [];
  let completedCount = 0;
  let reusedCount = 0;

  const scanFn = scanSeriesFlat;
  await scanContext.prepareDirectoryConsumers(seriesDirs);

  const scanResults = await runPool(
    seriesDirs,
    async (seriesDir, i) => {
      if (onProgress) {
        onProgress({
          current: completedCount,
          total: seriesDirs.length,
          currentDir: path.basename(seriesDir),
          phase: 'scanning',
        });
      }

      const sourceKey = buildSeriesSourceKey(seriesDir, libraryRoot);
      const prevSeries = previousSeriesMap.get(sourceKey) ?? null;
      let item;
      try {
        item = await scanFn(
          seriesDir,
          libraryRoot,
          settings,
          overrides,
          prevSeries,
          scanContext,
          dirtyPaths,
        );
      } finally {
        // 候选发现与作品解析共享一次 readdir；作品完成后即可释放其目录树缓存。
        await scanContext.releaseDirectoryTree(seriesDir);
      }

      completedCount++;
      // Virtual/fast filesystems can otherwise keep the microtask queue occupied
      // for an entire scan. Cooperate with HTTP, progress timers and idle GC.
      if (completedCount % 32 === 0) await yieldToEventLoop();
      return item;
    },
    Math.max(1, Math.trunc(options.seriesConcurrency ?? 8)),
  );

  const series = [];
  for (const item of [...untouchedSeries, ...scanResults]) {
    if (item) {
      if (item._reused) reusedCount++;
      series.push(item);
    }
  }
  series.sort((left, right) => naturalCompare(left.sourceKey, right.sourceKey));

  if (onProgress) {
    onProgress({
      current: seriesDirs.length,
      total: seriesDirs.length,
      currentDir: null,
      phase: 'finalizing',
    });
  }

  const categories = normalizeArray([
    ...(settings.categoryFolders ?? []).map((item) => item.name),
    ...series.flatMap((seriesItem) => seriesItem.categories.effective),
  ]).sort(naturalCompare);

  const volumeCount = series.reduce((total, seriesItem) => total + seriesItem.counts.volumes, 0);
  const chapterCount = series.reduce((total, seriesItem) => total + seriesItem.counts.chapters, 0);
  const pageCount = series.reduce((total, seriesItem) => total + seriesItem.counts.pages, 0);
  const totalBytes = series.reduce((total, seriesItem) => total + (seriesItem.totalBytes ?? 0), 0);

  return {
    lastScanAt: new Date().toISOString(),
    scanRoot: libraryRoot,
    stats: {
      seriesCount: series.length,
      volumeCount,
      chapterCount,
      pageCount,
      totalBytes,
      categories,
    },
    series,
    issues: normalizeArray([...issues, ...scanContext.archiveIssues.sort(naturalCompare)]),
    exportInfo: null,
    scanMeta: {
      reusedCount,
      scannedCount: series.length - reusedCount,
      totalCandidates: series.length,
    },
  };
}
