import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';

import { loadConfig } from './config.mjs';
import { syncMihonExport } from './exporter.mjs';
import { scanLibrary } from './scanner.mjs';
import { AppStore } from './store.mjs';
import {
  ensureDir,
  formatDateTime,
  naturalCompare,
  normalizeArray,
  normalizeRelativeFolderPath,
  toPosixPath,
} from './utils.mjs';

const config = loadConfig();
await ensureDir(config.publicDir);
await ensureDir(config.dataDir);

const store = new AppStore(config);
await store.init();

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function text(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml',
  };

  return mimeMap[ext] ?? 'application/octet-stream';
}

async function parseJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function buildSeriesListItem(series) {
  const latestVolume = series.volumes.at(-1);
  const latestChapter = latestVolume?.chapters.at(-1);
  return {
    id: series.id,
    title: series.title,
    sourceFolderName: series.sourceFolderName,
    sourceKey: series.sourceKey,
    categories: series.categories,
    counts: series.counts,
    coverUrl: series.cover ? `/media/cover/${series.id}` : null,
    latestChapterTitle: latestChapter ? `${latestVolume.title} / ${latestChapter.title}` : '无章节',
  };
}

function buildSeriesDetail(series) {
  return {
    ...buildSeriesListItem(series),
    sourcePath: series.sourcePath,
    volumes: series.volumes.map((volume) => {
      return {
        id: volume.id,
        title: volume.title,
        synthetic: volume.synthetic,
        sourcePath: volume.sourcePath,
        chapters: volume.chapters.map((chapter) => {
          return {
            id: chapter.id,
            title: chapter.title,
            sourcePath: chapter.sourcePath,
            pageCount: chapter.pageCount,
            pageUrls: chapter.pages.map((page) => `/media/chapter/${chapter.id}/${page.index}`),
            firstPageUrl: chapter.pages.length > 0 ? `/media/chapter/${chapter.id}/1` : null,
          };
        }),
      };
    }),
  };
}

function findChapterById(chapterId) {
  for (const series of store.getLibrary().series) {
    for (const volume of series.volumes) {
      for (const chapter of volume.chapters) {
        if (chapter.id === chapterId) {
          return chapter;
        }
      }
    }
  }

  return null;
}

function findSeriesById(seriesId) {
  return store.getSeriesById(seriesId) ?? null;
}

async function serveFile(response, filePath) {
  try {
    const stats = await fsp.stat(filePath);
    if (!stats.isFile()) {
      text(response, 404, 'Not found');
      return;
    }

    response.writeHead(200, {
      'Content-Type': getMimeType(filePath),
      'Content-Length': stats.size,
      'Cache-Control': 'public, max-age=60',
    });

    fs.createReadStream(filePath).pipe(response);
  } catch {
    text(response, 404, 'Not found');
  }
}

async function listRelativeFolders(libraryRoot) {
  const items = [{ path: '', label: '根目录' }];

  async function walk(currentDir) {
    let entries = [];
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((left, right) => naturalCompare(left.name, right.name));

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = normalizeRelativeFolderPath(path.relative(libraryRoot, absolutePath));
      items.push({
        path: relativePath,
        label: relativePath || '根目录',
      });
      await walk(absolutePath);
    }
  }

  await walk(libraryRoot);
  return items;
}

class ScanCoordinator {
  constructor(appStore, runtimeConfig) {
    this.store = appStore;
    this.config = runtimeConfig;
    this.timer = null;
    this.currentTask = null;
    this.status = {
      running: false,
      trigger: null,
      startedAt: null,
      finishedAt: null,
      error: null,
    };
  }

  getStatus() {
    return { ...this.status };
  }

  schedule() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const intervalMinutes = this.store.getSettings().scanIntervalMinutes;
    if (intervalMinutes <= 0) {
      return;
    }

    this.timer = setInterval(() => {
      void this.run('scheduled');
    }, intervalMinutes * 60 * 1000);
  }

  async exportCurrentLibrary() {
    const library = store.getLibrary();
    const exportInfo = await syncMihonExport(library, this.config.mihonExportRoot);
    library.exportInfo = exportInfo;
    await this.store.replaceLibrary(library);
    return exportInfo;
  }

  async run(trigger) {
    if (this.currentTask) {
      return this.currentTask;
    }

    const startedAt = new Date().toISOString();
    this.status = {
      running: true,
      trigger,
      startedAt,
      finishedAt: null,
      error: null,
    };

    this.currentTask = (async () => {
      try {
        const settings = this.store.getSettings();
        const overrides = this.store.getOverrides();
        const library = await scanLibrary(settings, overrides);

        if (settings.autoExportToMihon) {
          library.exportInfo = await syncMihonExport(library, this.config.mihonExportRoot);
        }

        await this.store.replaceLibrary(library);
        this.schedule();
        this.status = {
          running: false,
          trigger,
          startedAt,
          finishedAt: new Date().toISOString(),
          error: null,
        };

        return library;
      } catch (error) {
        this.status = {
          running: false,
          trigger,
          startedAt,
          finishedAt: new Date().toISOString(),
          error: error.message,
        };
        throw error;
      } finally {
        this.currentTask = null;
      }
    })();

    return this.currentTask;
  }
}

const scanner = new ScanCoordinator(store, config);

function buildStatePayload() {
  const library = store.getLibrary();
  const settings = store.getSettings();
  const knownCategories = normalizeArray([
    ...library.stats.categories,
    ...(settings.categoryFolders ?? []).map((item) => item.name),
  ]).sort(naturalCompare);

  return {
    settings,
    scanStatus: scanner.getStatus(),
    summary: library.stats,
    issues: library.issues,
    lastScanAt: library.lastScanAt,
    lastScanLabel: formatDateTime(library.lastScanAt),
    exportInfo: library.exportInfo,
    exportRoot: config.mihonExportRoot,
    knownCategories,
  };
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
  const { pathname } = requestUrl;

  try {
    if (request.method === 'GET' && pathname === '/api/health') {
      json(response, 200, { ok: true, now: new Date().toISOString() });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/state') {
      json(response, 200, buildStatePayload());
      return;
    }

    if (request.method === 'GET' && pathname === '/api/folders') {
      const items = await listRelativeFolders(path.resolve(store.getSettings().libraryRoot));
      json(response, 200, { items });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/categories') {
      json(response, 200, { items: store.getSettings().categoryFolders ?? [] });
      return;
    }

    if (request.method === 'PUT' && pathname === '/api/categories') {
      const body = await parseJsonBody(request);
      const settings = await store.replaceCategoryFolders(body.items ?? []);
      scanner.schedule();
      json(response, 200, { items: settings.categoryFolders });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/series') {
      const library = store.getLibrary();
      const search = requestUrl.searchParams.get('search')?.trim().toLowerCase() ?? '';
      const category = requestUrl.searchParams.get('category')?.trim().toLowerCase() ?? '';
      const items = library.series
        .filter((series) => {
          const matchesSearch =
            search.length === 0 ||
            series.title.toLowerCase().includes(search) ||
            series.sourceFolderName.toLowerCase().includes(search) ||
            series.sourceKey.toLowerCase().includes(search);
          const matchesCategory =
            category.length === 0 ||
            series.categories.effective.some((item) => item.toLowerCase() === category);
          return matchesSearch && matchesCategory;
        })
        .map(buildSeriesListItem);

      json(response, 200, { items, total: items.length });
      return;
    }

    const seriesMatch = pathname.match(/^\/api\/series\/([^/]+)$/);
    if (request.method === 'GET' && seriesMatch) {
      const series = findSeriesById(seriesMatch[1]);
      if (!series) {
        json(response, 404, { error: '未找到漫画' });
        return;
      }

      json(response, 200, buildSeriesDetail(series));
      return;
    }

    const seriesCategoryMatch = pathname.match(/^\/api\/series\/([^/]+)\/categories$/);
    if (request.method === 'PUT' && seriesCategoryMatch) {
      const series = findSeriesById(seriesCategoryMatch[1]);
      if (!series) {
        json(response, 404, { error: '未找到漫画' });
        return;
      }

      const body = await parseJsonBody(request);
      await store.setSeriesCategories(series.sourceKey, body.categories ?? []);
      await scanner.run('category-update');
      json(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && pathname === '/api/settings') {
      json(response, 200, store.getSettings());
      return;
    }

    if (request.method === 'PUT' && pathname === '/api/settings') {
      const body = await parseJsonBody(request);
      const settings = await store.replaceSettings(body);
      scanner.schedule();
      json(response, 200, settings);
      return;
    }

    if (request.method === 'POST' && pathname === '/api/scan') {
      await scanner.run('manual');
      json(response, 200, { ok: true, state: buildStatePayload() });
      return;
    }

    if (request.method === 'POST' && pathname === '/api/export') {
      const exportInfo = await scanner.exportCurrentLibrary();
      json(response, 200, { ok: true, exportInfo });
      return;
    }

    const coverMatch = pathname.match(/^\/media\/cover\/([^/]+)$/);
    if (request.method === 'GET' && coverMatch) {
      const series = findSeriesById(coverMatch[1]);
      if (!series?.cover?.sourcePath) {
        text(response, 404, 'Not found');
        return;
      }

      await serveFile(response, series.cover.sourcePath);
      return;
    }

    const chapterMediaMatch = pathname.match(/^\/media\/chapter\/([^/]+)\/(\d+)$/);
    if (request.method === 'GET' && chapterMediaMatch) {
      const chapter = findChapterById(chapterMediaMatch[1]);
      const pageIndex = Number.parseInt(chapterMediaMatch[2], 10) - 1;
      const page = chapter?.pages?.[pageIndex];

      if (!page?.sourcePath) {
        text(response, 404, 'Not found');
        return;
      }

      await serveFile(response, page.sourcePath);
      return;
    }

    const publicFilePath = path.join(
      config.publicDir,
      pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''),
    );

    try {
      const stats = await fsp.stat(publicFilePath);
      if (stats.isFile()) {
        await serveFile(response, publicFilePath);
        return;
      }
    } catch {
      // fall through
    }

    await serveFile(response, path.join(config.publicDir, 'index.html'));
  } catch (error) {
    json(response, 500, { error: error.message });
  }
});

server.listen(config.port, async () => {
  scanner.schedule();
  await scanner.run('startup');
  console.log(`Folder library listening on http://0.0.0.0:${config.port}`);
});
