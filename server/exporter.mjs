import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureDir, pathExists, sanitizeFileName } from './utils.mjs';

function assertExportRoot(exportRoot) {
  const resolved = path.resolve(exportRoot);
  const root = path.parse(resolved).root;

  if (resolved === root) {
    throw new Error('MIHON_EXPORT_ROOT 不能指向磁盘根目录');
  }

  if (resolved.length < 5) {
    throw new Error('MIHON_EXPORT_ROOT 路径过短，不安全');
  }

  return resolved;
}

async function linkOrCopy(sourcePath, targetPath) {
  try {
    await fs.link(sourcePath, targetPath);
  } catch (error) {
    if (!['EXDEV', 'EPERM', 'EEXIST'].includes(error.code)) {
      throw error;
    }

    await fs.copyFile(sourcePath, targetPath);
  }
}

async function writeCover(series, seriesDir) {
  if (!series.cover?.sourcePath || !(await pathExists(series.cover.sourcePath))) {
    return false;
  }

  const sourceExt = path.extname(series.cover.sourcePath).toLowerCase();
  const coverJpgPath = path.join(seriesDir, 'cover.jpg');
  await fs.copyFile(series.cover.sourcePath, coverJpgPath);

  if (!['.jpg', '.jpeg'].includes(sourceExt)) {
    const originalCoverPath = path.join(seriesDir, `cover${sourceExt || '.img'}`);
    await fs.copyFile(series.cover.sourcePath, originalCoverPath);
  }

  return true;
}

async function createUniqueDir(parentDir, preferredName) {
  const baseName = sanitizeFileName(preferredName) || 'untitled';

  for (let index = 0; index < 10000; index += 1) {
    const suffix = index === 0 ? '' : ` (${index + 1})`;
    const candidate = path.join(parentDir, `${baseName}${suffix}`);

    if (!(await pathExists(candidate))) {
      await ensureDir(candidate);
      return candidate;
    }
  }

  throw new Error(`无法创建唯一目录: ${preferredName}`);
}

function buildSeriesDetails(series) {
  return {
    title: series.title,
    author: 'Folder Library',
    artist: 'Folder Library',
    description: `源目录: ${series.sourceKey}\n卷数: ${series.counts.volumes}\n章节: ${series.counts.chapters}\n页数: ${series.counts.pages}`,
    genre: series.categories.effective,
    status: '0',
  };
}

export async function syncMihonExport(librarySnapshot, exportRoot) {
  const targetRoot = assertExportRoot(exportRoot);
  await fs.rm(targetRoot, { recursive: true, force: true });
  await ensureDir(targetRoot);
  await fs.writeFile(path.join(targetRoot, '.nomedia'), '', 'utf8');

  let exportedSeriesCount = 0;
  let exportedChapterCount = 0;

  for (const series of librarySnapshot.series) {
    const seriesDir = await createUniqueDir(targetRoot, series.title);
    await fs.writeFile(
      path.join(seriesDir, 'details.json'),
      JSON.stringify(buildSeriesDetails(series), null, 2),
      'utf8',
    );
    await writeCover(series, seriesDir);

    let chapterSequence = 1;
    for (const volume of series.volumes) {
      for (const chapter of volume.chapters) {
        const chapterDir = await createUniqueDir(
          seriesDir,
          `${String(chapterSequence).padStart(4, '0')} - ${volume.title} - ${chapter.title}`,
        );

        let pageIndex = 1;
        for (const page of chapter.pages) {
          const ext = path.extname(page.fileName).toLowerCase() || '.jpg';
          const targetPagePath = path.join(chapterDir, `${String(pageIndex).padStart(4, '0')}${ext}`);
          await linkOrCopy(page.sourcePath, targetPagePath);
          pageIndex += 1;
        }

        chapterSequence += 1;
        exportedChapterCount += 1;
      }
    }

    exportedSeriesCount += 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    exportRoot: targetRoot,
    seriesCount: exportedSeriesCount,
    chapterCount: exportedChapterCount,
  };
}
