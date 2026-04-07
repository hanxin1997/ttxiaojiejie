import fs from 'node:fs/promises';
import path from 'node:path';

import {
  IMAGE_EXTENSIONS,
  formatPageTemplate,
  naturalCompare,
  normalizeArray,
  normalizeRelativeFolderPath,
  stableId,
  toPosixPath,
} from './utils.mjs';

async function readDirectoryEntries(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries.sort((left, right) => naturalCompare(left.name, right.name));
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

function buildPageRecords(imagePaths, chapterId) {
  return imagePaths.map((imagePath, index) => {
    return {
      id: stableId(`${chapterId}:${imagePath}`),
      index: index + 1,
      fileName: path.basename(imagePath),
      sourcePath: imagePath,
    };
  });
}

async function listSubdirectories(dirPath) {
  const entries = await readDirectoryEntries(dirPath);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(dirPath, entry.name));
}

async function listImageFiles(dirPath) {
  const entries = await readDirectoryEntries(dirPath);
  return entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dirPath, entry.name));
}

function parseFolderMetadata(folderName, folderPattern) {
  if (!folderPattern.enabled) {
    return { title: folderName, autoCategories: [] };
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

  return {
    title: title.trim() || folderName,
    autoCategories: normalizeArray(autoCategories),
  };
}

function isSameOrChildFolder(parentFolder, childFolder) {
  if (!parentFolder) {
    return false;
  }

  return childFolder === parentFolder || childFolder.startsWith(`${parentFolder}/`);
}

function resolveFolderCategories(seriesSourceKey, settings) {
  return normalizeArray(
    (settings.categoryFolders ?? [])
      .filter((item) => item.folder && isSameOrChildFolder(item.folder, seriesSourceKey))
      .map((item) => item.name),
  );
}

function buildChapter({
  chapterDir,
  chapterTitle,
  volumeTitle,
  imagePaths,
  seriesSourceKey,
  relativeInsideVolume,
}) {
  const chapterSourceKey = toPosixPath(
    path.join(seriesSourceKey, volumeTitle, relativeInsideVolume || '@root'),
  );
  const chapterId = stableId(`chapter:${chapterDir}`);
  const pages = buildPageRecords(imagePaths, chapterId);

  return {
    id: chapterId,
    title: chapterTitle,
    sourcePath: chapterDir,
    sourceKey: chapterSourceKey,
    volumeTitle,
    pageCount: pages.length,
    pages,
  };
}

async function collectVolumeChapters(volumeDir, volumeTitle, settings, seriesSourceKey) {
  const chapters = [];
  const directImages = await listImageFiles(volumeDir);

  if (directImages.length > 0) {
    chapters.push(
      buildChapter({
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
    const childDirs = await listSubdirectories(nodeDir);

    for (const childDir of childDirs) {
      const childImages = await listImageFiles(childDir);
      if (childImages.length > 0) {
        chapters.push(
          buildChapter({
            chapterDir: childDir,
            chapterTitle: toPosixPath(path.relative(volumeDir, childDir)),
            volumeTitle,
            imagePaths: childImages,
            seriesSourceKey,
            relativeInsideVolume: toPosixPath(path.relative(volumeDir, childDir)),
          }),
        );
      }

      await walk(childDir);
    }
  }

  await walk(volumeDir);
  return chapters;
}

async function scanSeries(seriesDir, libraryRoot, settings, overrides) {
  const folderName = path.basename(seriesDir);
  const seriesSourceKey = toPosixPath(path.relative(libraryRoot, seriesDir));
  const { title, autoCategories } = parseFolderMetadata(folderName, settings.folderPattern);
  const folderCategories = resolveFolderCategories(seriesSourceKey, settings);
  const manualCategories = normalizeArray(overrides.seriesCategories[seriesSourceKey]);
  const volumes = [];

  const rootImages = await listImageFiles(seriesDir);
  if (rootImages.length > 0) {
    const syntheticVolumeTitle = settings.naming.defaultVolumeName;
    volumes.push({
      id: stableId(`volume:${seriesDir}:root`),
      title: syntheticVolumeTitle,
      sourcePath: seriesDir,
      synthetic: true,
      chapters: [
        buildChapter({
          chapterDir: seriesDir,
          chapterTitle: formatPageTemplate(settings.naming.directImageChapterTemplate, rootImages.length),
          volumeTitle: syntheticVolumeTitle,
          imagePaths: rootImages,
          seriesSourceKey,
          relativeInsideVolume: '@root',
        }),
      ],
    });
  }

  const volumeDirs = await listSubdirectories(seriesDir);
  for (const volumeDir of volumeDirs) {
    const chapters = await collectVolumeChapters(
      volumeDir,
      path.basename(volumeDir),
      settings,
      seriesSourceKey,
    );

    if (chapters.length === 0) {
      continue;
    }

    volumes.push({
      id: stableId(`volume:${volumeDir}`),
      title: path.basename(volumeDir),
      sourcePath: volumeDir,
      synthetic: false,
      chapters,
    });
  }

  if (volumes.length === 0) {
    return null;
  }

  const coverPath = volumes[0]?.chapters[0]?.pages[0]?.sourcePath ?? null;
  const chapterCount = volumes.reduce((total, volume) => total + volume.chapters.length, 0);
  const pageCount = volumes.reduce((total, volume) => {
    return total + volume.chapters.reduce((chapterTotal, chapter) => chapterTotal + chapter.pageCount, 0);
  }, 0);

  return {
    id: stableId(`series:${seriesSourceKey}`),
    title,
    sourceFolderName: folderName,
    sourceKey: seriesSourceKey,
    sourcePath: seriesDir,
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
    volumes,
  };
}

function shouldSkipRootChild(relativePath, settings) {
  return (settings.categoryFolders ?? []).some((item) => {
    const folder = normalizeRelativeFolderPath(item.folder);
    if (!folder) {
      return false;
    }

    return isSameOrChildFolder(relativePath, folder);
  });
}

async function collectCandidateSeriesDirs(libraryRoot, settings) {
  const candidates = new Map();
  const rootChildren = await listSubdirectories(libraryRoot);

  for (const childDir of rootChildren) {
    const relativePath = toPosixPath(path.relative(libraryRoot, childDir));
    if (!shouldSkipRootChild(relativePath, settings)) {
      candidates.set(path.resolve(childDir), path.resolve(childDir));
    }
  }

  for (const item of settings.categoryFolders ?? []) {
    const relativeFolder = normalizeRelativeFolderPath(item.folder);
    const categoryRoot = path.resolve(libraryRoot, relativeFolder);

    try {
      const stats = await fs.stat(categoryRoot);
      if (!stats.isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    const childDirs = await listSubdirectories(categoryRoot);
    for (const childDir of childDirs) {
      candidates.set(path.resolve(childDir), path.resolve(childDir));
    }
  }

  return [...candidates.values()].sort((left, right) => {
    return naturalCompare(
      toPosixPath(path.relative(libraryRoot, left)),
      toPosixPath(path.relative(libraryRoot, right)),
    );
  });
}

export async function scanLibrary(settings, overrides) {
  const libraryRoot = path.resolve(settings.libraryRoot);

  try {
    const stats = await fs.stat(libraryRoot);
    if (!stats.isDirectory()) {
      return buildEmptySnapshot(libraryRoot, `扫描目录不是文件夹: ${libraryRoot}`);
    }
  } catch {
    return buildEmptySnapshot(libraryRoot, `扫描目录不存在: ${libraryRoot}`);
  }

  const seriesDirs = await collectCandidateSeriesDirs(libraryRoot, settings);
  const series = [];

  for (const seriesDir of seriesDirs) {
    const item = await scanSeries(seriesDir, libraryRoot, settings, overrides);
    if (item) {
      series.push(item);
    }
  }

  const categories = normalizeArray([
    ...(settings.categoryFolders ?? []).map((item) => item.name),
    ...series.flatMap((seriesItem) => seriesItem.categories.effective),
  ]).sort(naturalCompare);

  const volumeCount = series.reduce((total, seriesItem) => total + seriesItem.counts.volumes, 0);
  const chapterCount = series.reduce((total, seriesItem) => total + seriesItem.counts.chapters, 0);
  const pageCount = series.reduce((total, seriesItem) => total + seriesItem.counts.pages, 0);

  return {
    lastScanAt: new Date().toISOString(),
    scanRoot: libraryRoot,
    stats: {
      seriesCount: series.length,
      volumeCount,
      chapterCount,
      pageCount,
      categories,
    },
    series,
    issues: [],
    exportInfo: null,
  };
}
