import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import { DatabaseQueryWorker } from './database-query-worker.mjs';
import { DatabaseWriteWorker } from './database-write-worker.mjs';
import { createFtsWriter } from './store-fts.mjs';
import { initializeStoreSchema } from './store-schema.mjs';
import {
  deepClone,
  ensureDir,
  naturalCompare,
  normalizeArray,
  normalizeRelativeFolderPath,
} from './utils.mjs';

function parseJson(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeFolderPattern(value, defaults) {
  const source = value ?? {};
  return {
    enabled: Boolean(source.enabled ?? defaults.enabled),
    separator: String(source.separator ?? defaults.separator ?? '-'),
    authorSegmentIndex: Number.isInteger(source.authorSegmentIndex)
      ? source.authorSegmentIndex
      : (defaults.authorSegmentIndex ?? null),
    titleSegmentIndex: Number.isInteger(source.titleSegmentIndex)
      ? source.titleSegmentIndex
      : defaults.titleSegmentIndex,
    categorySegmentIndex: Number.isInteger(source.categorySegmentIndex)
      ? source.categorySegmentIndex
      : defaults.categorySegmentIndex,
    stripTokens: normalizeArray(source.stripTokens ?? defaults.stripTokens),
  };
}

function normalizeNaming(value, defaults) {
  const source = value ?? {};
  return {
    defaultVolumeName:
      String(source.defaultVolumeName ?? defaults.defaultVolumeName).trim() || defaults.defaultVolumeName,
    directImageChapterTemplate:
      String(source.directImageChapterTemplate ?? defaults.directImageChapterTemplate).trim() ||
      defaults.directImageChapterTemplate,
  };
}

function normalizeCategoryFolders(values) {
  const entries = new Map();
  for (const item of values ?? []) {
    const name = String(item?.name ?? '').trim();
    const rawFolder = String(item?.folder ?? '').trim();
    if (!name) continue;
    const folder = rawFolder.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawFolder)
      ? rawFolder.replaceAll('\\', '/').replace(/\/+$/, '')
      : normalizeRelativeFolderPath(rawFolder);
    const key = name.toLocaleLowerCase();
    if (!entries.has(key)) entries.set(key, { name, folder });
  }
  return [...entries.values()].sort((left, right) => naturalCompare(left.name, right.name));
}

function normalizeSettings(value, defaults) {
  const source = value ?? {};
  const scanInterval = Number.parseInt(
    String(source.scanIntervalMinutes ?? defaults.scanIntervalMinutes),
    10,
  );
  return {
    libraryRoot: String(source.libraryRoot ?? defaults.libraryRoot).trim() || defaults.libraryRoot,
    scanIntervalMinutes: Number.isFinite(scanInterval) ? Math.max(0, scanInterval) : defaults.scanIntervalMinutes,
    autoExportToMihon: false,
    scanMode: 'flat',
    folderPattern: normalizeFolderPattern(source.folderPattern, defaults.folderPattern),
    naming: normalizeNaming(source.naming, defaults.naming),
    categoryFolders: normalizeCategoryFolders(source.categoryFolders ?? defaults.categoryFolders),
  };
}

function mergeSettings(current, next) {
  return {
    ...current,
    ...next,
    folderPattern: { ...current.folderPattern, ...(next?.folderPattern ?? {}) },
    naming: { ...current.naming, ...(next?.naming ?? {}) },
    categoryFolders: next?.categoryFolders ?? current.categoryFolders,
  };
}

function createEmptyLibrary() {
  return {
    lastScanAt: null,
    scanRoot: null,
    stats: {
      seriesCount: 0,
      volumeCount: 0,
      chapterCount: 0,
      pageCount: 0,
      totalBytes: 0,
      categories: [],
    },
    series: [],
    issues: [],
    exportInfo: null,
    scanMeta: null,
  };
}

function normalizeLibrary(value) {
  if (!value || typeof value !== 'object') return createEmptyLibrary();
  const stats = value.stats ?? {};
  return {
    lastScanAt: value.lastScanAt ?? null,
    scanRoot: value.scanRoot ?? null,
    stats: {
      seriesCount: Number(stats.seriesCount) || 0,
      volumeCount: Number(stats.volumeCount) || 0,
      chapterCount: Number(stats.chapterCount) || 0,
      pageCount: Number(stats.pageCount) || 0,
      totalBytes: Number(stats.totalBytes) || 0,
      categories: normalizeArray(stats.categories),
    },
    series: Array.isArray(value.series) ? value.series : [],
    issues: normalizeArray(value.issues),
    exportInfo: null,
    scanMeta: value.scanMeta ?? null,
  };
}

async function createRuntimeLibrary(library, overrides) {
  const runtime = { ...library, series: [] };
  const seriesIndex = new Map();
  const seriesBySourceKey = new Map();
  const chapterIndex = new Map();
  const chapterOwners = new Map();
  let work = 0;
  for (const series of library.series) {
    const { _reused, volumes = [], ...summary } = series;
    const manual = [...(overrides.seriesCategories[series.sourceKey] ?? [])];
    const item = { ...summary, categories: { ...series.categories, manual,
      effective: normalizeArray([...(series.categories?.auto ?? []), ...(series.categories?.folder ?? []), ...manual]) }, volumes: [] };
    runtime.series.push(item);
    seriesIndex.set(item.id, item);
    seriesBySourceKey.set(item.sourceKey, item);
    for (const volume of volumes) {
      const runtimeVolume = { ...volume, chapters: [] };
      item.volumes.push(runtimeVolume);
      for (const chapter of volume.chapters ?? []) {
        const { _reused: _chapterReused, pages: _pages, ...chapterSummary } = chapter;
        // Keep archive identity for the next scan, but retain no page arrays in the HTTP process.
        const runtimeChapter = { ...chapterSummary, pages: [] };
        runtimeVolume.chapters.push(runtimeChapter);
        chapterIndex.set(chapter.id, runtimeChapter);
        chapterOwners.set(chapter.id, series.sourceKey);
        if (++work % 256 === 0) await yieldToEventLoop();
      }
    }
    if (++work % 256 === 0) await yieldToEventLoop();
  }
  return { library: runtime, seriesIndex, seriesBySourceKey, chapterIndex, chapterOwners };
}

function createEmptyOverrides() {
  return {
    seriesCategories: {},
    favorites: [],
    customCovers: {},
    metadata: {},
    tags: {},
    readProgress: {},
  };
}

function normalizeMetadata(value) {
  const entry = {};
  if (typeof value?.title === 'string' && value.title.trim()) entry.title = value.title.trim();
  if (typeof value?.author === 'string' && value.author.trim()) entry.author = value.author.trim();
  if (typeof value?.description === 'string') entry.description = value.description.trim();
  return entry;
}

export class AppStore {
  constructor(config) {
    this.config = config;
    this.db = null;
    this.settings = normalizeSettings(null, config.defaultSettings);
    this.library = createEmptyLibrary();
    this.overrides = createEmptyOverrides();
    this.chapterIndex = new Map();
    this.chapterOwners = new Map();
    this.seriesIndex = new Map();
    this.seriesBySourceKey = new Map();
    this.writePromise = Promise.resolve();
    this.queryWorker = null;
    this.writeWorker = null;
    this.ftsWriter = null;
    this.closing = false;
    this.closePromise = null;
    this.revision = 0;
  }

  getDatabase() {
    if (!this.db) throw new Error('Store not initialized');
    return this.db;
  }

  async init() {
    await ensureDir(this.config.dataDir);
    this.db = new DatabaseSync(this.config.databaseFile);
    initializeStoreSchema(this.db);
    this.ftsWriter = createFtsWriter(this.db);
    this.revision = this.#readRevisionSync();
    this.overrides = this.#loadOverrides();
    this.settings = this.#loadSettings();
    this.library = this.#loadLibrary();
    this.#rebuildChapterIndex();
    this.queryWorker = new DatabaseQueryWorker(this.config.databaseFile, {
      maxQueue: this.config.resourceProfile?.databaseQueueLimit ?? 64,
    });
    this.writeWorker = new DatabaseWriteWorker(this.config.databaseFile);
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      // All accepted writes finish before their connections disappear; later callers are rejected.
      await this.writePromise;
      await this.writeWorker?.close();
      await this.queryWorker?.close();
      this.writeWorker = null;
      this.queryWorker = null;
      this.db?.close();
      this.db = null;
    })();
    return this.closePromise;
  }

  #loadSettings() {
    const rows = this.getDatabase().prepare('SELECT key, value_json FROM settings').all();
    if (rows.length === 0) {
      const settings = normalizeSettings(null, this.config.defaultSettings);
      this.#writeSettingsSync(settings);
      return settings;
    }
    const raw = Object.fromEntries(rows.map((row) => [row.key, parseJson(row.value_json, null)]));
    return normalizeSettings(raw, this.config.defaultSettings);
  }

  #writeSettingsSync(settings, bumpRevision = false) {
    const db = this.getDatabase();
    const insert = db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM settings');
      for (const [key, value] of Object.entries(settings)) insert.run(key, JSON.stringify(value));
      const revision = bumpRevision ? this.#bumpRevisionSync(db) : this.revision;
      db.exec('COMMIT');
      return revision;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  #loadOverrides() {
    const db = this.getDatabase();
    const overrides = createEmptyOverrides();
    for (const row of db.prepare('SELECT source_key, value FROM series_category_overrides ORDER BY source_key, position').all()) {
      (overrides.seriesCategories[row.source_key] ??= []).push(row.value);
    }
    overrides.favorites = db.prepare('SELECT source_key FROM favorites ORDER BY source_key').all().map((row) => row.source_key);
    for (const row of db.prepare('SELECT source_key, chapter_id, page_index FROM custom_covers').all()) {
      overrides.customCovers[row.source_key] = { chapterId: row.chapter_id, pageIndex: row.page_index };
    }
    for (const row of db.prepare('SELECT source_key, title, author, description FROM series_metadata').all()) {
      overrides.metadata[row.source_key] = Object.fromEntries(
        Object.entries({ title: row.title, author: row.author, description: row.description }).filter(([, item]) => item !== null),
      );
    }
    for (const row of db.prepare('SELECT source_key, value FROM series_tags ORDER BY source_key, value COLLATE NOCASE').all()) {
      (overrides.tags[row.source_key] ??= []).push(row.value);
    }
    for (const row of db.prepare('SELECT source_key, chapter_id, page_index, total_pages, updated_at FROM read_progress').all()) {
      overrides.readProgress[row.source_key] = {
        chapterId: row.chapter_id,
        pageIndex: row.page_index,
        totalPages: row.total_pages,
        updatedAt: row.updated_at,
      };
    }
    return overrides;
  }

  #loadLibrary() {
    const db = this.getDatabase();
    const state = db.prepare('SELECT * FROM library_state WHERE id = 1').get();
    if (!state) return createEmptyLibrary();

    const seriesRows = db.prepare('SELECT * FROM series ORDER BY position').all();
    const seriesById = new Map();
    const volumeById = new Map();
    const chapterById = new Map();
    const series = seriesRows.map((row) => {
      const manual = [...(this.overrides.seriesCategories[row.source_key] ?? [])];
      const item = {
        id: row.id,
        sourceKey: row.source_key,
        sourcePath: row.source_path,
        sourceFolderName: row.source_folder_name,
        title: row.title,
        author: row.author,
        dirMtime: row.dir_mtime,
        scanFingerprint: row.scan_fingerprint,
        updatedAt: row.updated_at,
        metadata: parseJson(row.metadata_json, {}),
        tags: parseJson(row.tags_json, []),
        categories: { auto: [], folder: [], manual, effective: [...manual] },
        cover: row.cover_source_path
          ? {
              sourcePath: row.cover_source_path,
              fileName: row.cover_file_name,
              archiveEntry: parseJson(row.cover_archive_entry_json, null),
            }
          : null,
        counts: {
          volumes: row.volume_count,
          chapters: row.chapter_count,
          pages: row.page_count,
        },
        totalBytes: row.total_bytes,
        volumes: [],
      };
      seriesById.set(item.id, item);
      return item;
    });

    for (const row of db.prepare('SELECT series_id, kind, value FROM series_categories ORDER BY series_id, kind, position').all()) {
      const item = seriesById.get(row.series_id);
      if (item) item.categories[row.kind].push(row.value);
    }
    for (const item of series) {
      item.categories.effective = normalizeArray([
        ...item.categories.auto,
        ...item.categories.folder,
        ...item.categories.manual,
      ]);
    }
    for (const row of db.prepare('SELECT * FROM volumes ORDER BY series_id, position').all()) {
      const volume = {
        id: row.id,
        title: row.title,
        sourcePath: row.source_path,
        synthetic: Boolean(row.synthetic),
        chapters: [],
      };
      volumeById.set(row.id, volume);
      seriesById.get(row.series_id)?.volumes.push(volume);
    }
    for (const row of db.prepare('SELECT * FROM chapters ORDER BY volume_id, position').all()) {
      const chapter = {
        id: row.id,
        title: row.title,
        sourceKey: row.source_key,
        sourcePath: row.source_path,
        volumeTitle: row.volume_title,
        pageCount: row.page_count,
        totalBytes: row.total_bytes,
        archiveSource: parseJson(row.archive_source_json, null),
        scanFingerprint: row.scan_fingerprint ?? null,
        pages: [],
      };
      chapterById.set(row.id, chapter);
      volumeById.get(row.volume_id)?.chapters.push(chapter);
    }
    return {
      lastScanAt: state.last_scan_at,
      scanRoot: state.scan_root,
      stats: {
        seriesCount: state.series_count,
        volumeCount: state.volume_count,
        chapterCount: state.chapter_count,
        pageCount: state.page_count,
        totalBytes: state.total_bytes,
        categories: parseJson(state.categories_json, []),
      },
      series,
      issues: db.prepare('SELECT message FROM scan_issues ORDER BY position').all().map((row) => row.message),
      exportInfo: null,
      scanMeta: parseJson(state.scan_meta_json, null),
    };
  }

  #queueWrite(operation) {
    if (this.closing) return Promise.reject(new Error('Store is closing'));
    const task = this.writePromise.then(operation);
    this.writePromise = task.catch(() => {});
    return task;
  }

  #readRevisionSync() {
    const value = this.getDatabase().prepare("SELECT value FROM app_meta WHERE key = 'revision'").get()?.value;
    return Math.max(0, Number.parseInt(value ?? '0', 10) || 0);
  }

  #bumpRevisionSync(db) {
    db.prepare(`
      UPDATE app_meta
      SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
      WHERE key = 'revision'
    `).run();
    return Math.max(0, Number.parseInt(
      db.prepare("SELECT value FROM app_meta WHERE key = 'revision'").get()?.value ?? '0',
      10,
    ) || 0);
  }

  #queueVisibleWrite(operation, publish = () => {}, { catalogChanged = true } = {}) {
    return this.#queueWrite(() => {
      const change = this.#transaction((db) => {
        const result = operation(db);
        // Metadata, tags and categories feed cached catalog ordering/recommendation features.
        // Reading progress, favorites and covers are projected live and do not invalidate them.
        if (catalogChanged) db.prepare(`
          UPDATE app_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
          WHERE key = 'catalog_revision'
        `).run();
        return { result, revision: this.#bumpRevisionSync(db) };
      });
      // Publish before releasing the queue: the next mutation must see the committed overrides.
      this.revision = change.revision;
      publish(change.result);
      return change.result;
    });
  }

  #transaction(operation) {
    const db = this.getDatabase();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  querySeriesPage(query, { page, pageSize }) {
    const db = this.getDatabase();
    const conditions = [];
    const parameters = [];
    const search = String(query.search ?? '').trim();
    const category = String(query.category ?? '').trim();
    const requestedTags = String(query.tags ?? '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);

    if (search) {
      conditions.push(`s.id IN (
        SELECT series_id FROM series_fts
        WHERE series_fts MATCH ?
      )`);
      parameters.push(`"${search.replaceAll('"', '""')}"`);
    }
    if (category) {
      conditions.push(`(
        EXISTS (
          SELECT 1 FROM series_categories sc
          WHERE sc.series_id = s.id AND sc.value = ? COLLATE NOCASE
        ) OR EXISTS (
          SELECT 1 FROM series_category_overrides sco
          WHERE sco.source_key = s.source_key AND sco.value = ? COLLATE NOCASE
        )
      )`);
      parameters.push(category, category);
    }
    if (query.favorites === 'true') {
      conditions.push('EXISTS (SELECT 1 FROM favorites f WHERE f.source_key = s.source_key)');
    }
    if (requestedTags.length > 0) {
      const tagChecks = requestedTags.map(() => `EXISTS (
        SELECT 1 FROM series_tags st WHERE st.source_key = s.source_key AND st.value = ? COLLATE NOCASE
      )`);
      conditions.push(`(${tagChecks.join(query.tagMode === 'or' ? ' OR ' : ' AND ')})`);
      parameters.push(...requestedTags);
    }

    const numberFilters = [
      ['minPages', 's.page_count >= ?'],
      ['maxPages', 's.page_count <= ?'],
      ['minSize', 's.total_bytes >= ?'],
      ['maxSize', 's.total_bytes <= ?'],
    ];
    for (const [key, sql] of numberFilters) {
      if (query[key] === undefined || query[key] === '') continue;
      const value = Number.parseInt(query[key], 10);
      if (Number.isFinite(value)) {
        conditions.push(sql);
        parameters.push(value);
      }
    }

    const readStatus = String(query.readStatus ?? '').trim();
    if (readStatus === 'unread') conditions.push('rp.source_key IS NULL');
    else if (readStatus === 'completed') conditions.push('rp.page_index >= progress_chapter.page_count');
    else if (readStatus === 'reading') conditions.push('rp.page_index < progress_chapter.page_count');

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sortExpressions = {
      title: 's.title COLLATE NOCASE',
      pages: 's.page_count',
      chapters: 's.chapter_count',
      volumes: 's.volume_count',
      size: 's.total_bytes',
      updatedAt: 's.updated_at',
    };
    const sortExpression = sortExpressions[query.sort] ?? sortExpressions.title;
    const sortOrder = query.order === 'desc' ? 'DESC' : 'ASC';
    const joins = `
      LEFT JOIN series_metadata sm ON sm.source_key = s.source_key
      LEFT JOIN read_progress rp ON rp.source_key = s.source_key AND EXISTS (
        SELECT 1 FROM chapters c WHERE c.id = rp.chapter_id AND c.series_id = s.id
          AND rp.page_index BETWEEN 1 AND c.page_count
      )
      LEFT JOIN chapters progress_chapter ON progress_chapter.id = rp.chapter_id
    `;

    const total = db.prepare(`SELECT count(*) AS count FROM series s ${joins} ${whereSql}`).get(...parameters).count;
    const rows = db.prepare(`
      SELECT
        s.*,
        sm.title AS override_title,
        sm.author AS override_author,
        sm.description AS override_description,
        rp.chapter_id AS progress_chapter_id,
        rp.page_index AS progress_page_index,
        progress_chapter.page_count AS progress_total_pages,
        rp.updated_at AS progress_updated_at,
        EXISTS(SELECT 1 FROM favorites f WHERE f.source_key = s.source_key) AS favorite,
        (
          SELECT CASE WHEN v.synthetic = 1 OR v.title = '' THEN c.title ELSE v.title || ' / ' || c.title END
          FROM chapters c
          JOIN volumes v ON v.id = c.volume_id
          WHERE c.series_id = s.id
          ORDER BY v.position DESC, c.position DESC
          LIMIT 1
        ) AS latest_chapter_title
      FROM series s
      ${joins}
      ${whereSql}
      ORDER BY ${sortExpression} ${sortOrder}, s.id ASC
      LIMIT ? OFFSET ?
    `).all(...parameters, pageSize, (page - 1) * pageSize);

    const baseCategoryStatement = db.prepare(`
      SELECT kind, value FROM series_categories WHERE series_id = ? ORDER BY kind, position
    `);
    const items = rows.map((row) => {
      const auto = [];
      const folder = [];
      for (const categoryRow of baseCategoryStatement.all(row.id)) {
        if (categoryRow.kind === 'auto') auto.push(categoryRow.value);
        else folder.push(categoryRow.value);
      }
      const manual = [...(this.overrides.seriesCategories[row.source_key] ?? [])];
      const customCover = this.getCustomCover(row.source_key);
      let coverUrl = row.cover_source_path ? `/media/cover/${row.id}` : null;
      if (customCover) coverUrl = `/media/chapter/${customCover.chapterId}/${customCover.pageIndex}`;
      const progress = row.progress_chapter_id
        ? {
            chapterId: row.progress_chapter_id,
            pageIndex: row.progress_page_index,
            totalPages: row.progress_total_pages,
            updatedAt: row.progress_updated_at,
          }
        : null;
      const readStatus = progress
        ? progress.totalPages > 0 && progress.pageIndex >= progress.totalPages
          ? 'completed'
          : 'reading'
        : 'unread';
      return {
        id: row.id,
        title: row.override_title ?? row.title,
        author: row.override_author ?? row.author,
        description: row.override_description,
        sourceFolderName: row.source_folder_name,
        sourceKey: row.source_key,
        categories: { auto, folder, manual, effective: normalizeArray([...auto, ...folder, ...manual]) },
        tags: [...(this.overrides.tags[row.source_key] ?? [])],
        metadata: parseJson(row.metadata_json, {}),
        counts: { volumes: row.volume_count, chapters: row.chapter_count, pages: row.page_count },
        totalBytes: row.total_bytes,
        coverUrl,
        thumbCoverUrl: coverUrl ? `${coverUrl}?variant=cover` : null,
        latestChapterTitle: row.latest_chapter_title ?? 'No chapters',
        favorite: Boolean(row.favorite),
        readProgress: progress,
        readStatus,
      };
    });

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      revision: this.revision,
    };
  }

  querySeriesPageAsync(query, { page, pageSize }) {
    return this.queryWorker.call('series-page', {
      query: { ...query },
      pagination: { page, pageSize },
    });
  }

  querySeriesDetailAsync(seriesId) {
    return this.queryWorker.call('series-detail', { seriesId });
  }

  queryChapterPagesAsync(chapterId) {
    return this.queryWorker.call('chapter-pages', { chapterId });
  }

  queryCoverPathAsync(seriesId) {
    return this.queryWorker.call('cover-path', { seriesId });
  }

  queryChapterPageAsync(chapterId, pageIndex) {
    return this.queryWorker.call('chapter-page', { chapterId, pageIndex });
  }

  queryCatalogOperationAsync(operation, payload) {
    return this.queryWorker.call(operation, payload);
  }

  getDatabaseWriteWorkerMetrics() {
    return this.writeWorker?.getMetrics() ?? { pending: 0, active: false, completed: 0, failed: 0 };
  }

  getDatabaseWorkerMetrics() {
    return this.queryWorker?.getMetrics() ?? {
      submitted: 0,
      completed: 0,
      failed: 0,
      rejected: 0,
      peakPending: 0,
      pending: 0,
      limit: 0,
    };
  }

  async checkReady() {
    if (!this.queryWorker) throw new Error('Store not initialized');
    await Promise.all([this.queryWorker.call('ping', {}), this.writeWorker.call('ping', {})]);
    return { ok: true };
  }

  getSettings() {
    return deepClone(this.settings);
  }

  getLibrary() {
    return deepClone(this.library);
  }

  getLibraryRef() {
    return this.library;
  }

  getLibrarySummary() {
    return deepClone({
      revision: this.revision,
      lastScanAt: this.library.lastScanAt,
      scanRoot: this.library.scanRoot,
      stats: this.library.stats,
      issues: this.library.issues,
      scanMeta: this.library.scanMeta,
    });
  }

  getOverrides() {
    return deepClone(this.overrides);
  }

  getOverridesRef() {
    return this.overrides;
  }

  getStateSnapshot() {
    return { settings: this.getSettings(), library: this.getLibrary(), overrides: this.getOverrides() };
  }

  getSeriesById(seriesId) {
    return this.seriesIndex.get(seriesId) ?? null;
  }

  findChapterById(chapterId) {
    return this.chapterIndex.get(chapterId) ?? null;
  }

  getChapterPage(chapterId, pageIndex) {
    const chapter = this.findChapterById(chapterId);
    return chapter?.pages?.[pageIndex - 1] ?? null;
  }

  async replaceSettings(nextSettings) {
    return this.#queueWrite(() => {
      const normalized = normalizeSettings(mergeSettings(this.settings, nextSettings), this.config.defaultSettings);
      this.revision = this.#writeSettingsSync(normalized, true);
      this.settings = normalized;
      return this.getSettings();
    });
  }

  async replaceCategoryFolders(categoryFolders) {
    return this.replaceSettings({ categoryFolders });
  }

  async replaceLibrary(nextLibrary) {
    const library = normalizeLibrary(nextLibrary);
    return this.#queueWrite(async () => {
      // Build the next lightweight snapshot cooperatively, then atomically publish after COMMIT.
      const runtime = await createRuntimeLibrary(library, this.overrides);
      const result = await this.writeWorker.replaceLibrary(library);
      Object.assign(this, runtime);
      this.revision = result.revision;
      return this.getLibrarySummary();
    });
  }

  #rebuildChapterIndex() {
    this.chapterIndex = new Map();
    this.chapterOwners = new Map();
    this.seriesIndex = new Map();
    this.seriesBySourceKey = new Map();
    for (const series of this.library.series) {
      this.seriesIndex.set(series.id, series);
      this.seriesBySourceKey.set(series.sourceKey, series);
      for (const volume of series.volumes ?? []) {
        for (const chapter of volume.chapters ?? []) {
          this.chapterIndex.set(chapter.id, chapter);
          this.chapterOwners.set(chapter.id, series.sourceKey);
        }
      }
    }
  }

  #applyManualCategories(sourceKey) {
    const series = this.seriesBySourceKey.get(sourceKey);
    if (!series) return;
    series.categories.manual = [...(this.overrides.seriesCategories[sourceKey] ?? [])];
    series.categories.effective = normalizeArray([
      ...series.categories.auto,
      ...series.categories.folder,
      ...series.categories.manual,
    ]);
  }

  async setSeriesCategories(sourceKey, categories) {
    const normalized = normalizeArray(categories);
    await this.#queueVisibleWrite((db) => {
      db.prepare('DELETE FROM series_category_overrides WHERE source_key = ?').run(sourceKey);
      const insert = db.prepare('INSERT INTO series_category_overrides (source_key, value, position) VALUES (?, ?, ?)');
      normalized.forEach((category, index) => insert.run(sourceKey, category, index));
    }, () => {
      if (normalized.length > 0) this.overrides.seriesCategories[sourceKey] = normalized;
      else delete this.overrides.seriesCategories[sourceKey];
      this.#applyManualCategories(sourceKey);
    });
    return this.getOverrides();
  }

  async batchSetCategories(sourceKeys, categories) {
    // Filesystem identities are case-sensitive on Linux, unlike display labels/tags.
    const normalizedKeys = [...new Set(sourceKeys)];
    const normalizedCategories = normalizeArray(categories);
    await this.#queueVisibleWrite((db) => {
      const remove = db.prepare('DELETE FROM series_category_overrides WHERE source_key = ?');
      const insert = db.prepare('INSERT INTO series_category_overrides (source_key, value, position) VALUES (?, ?, ?)');
      for (const sourceKey of normalizedKeys) {
        remove.run(sourceKey);
        normalizedCategories.forEach((category, index) => insert.run(sourceKey, category, index));
      }
    }, () => {
      for (const sourceKey of normalizedKeys) {
        if (normalizedCategories.length > 0) this.overrides.seriesCategories[sourceKey] = [...normalizedCategories];
        else delete this.overrides.seriesCategories[sourceKey];
        this.#applyManualCategories(sourceKey);
      }
    });
    return this.getOverrides();
  }

  async toggleFavorite(sourceKey) {
    let favorited;
    await this.#queueVisibleWrite((db) => {
      favorited = !this.isFavorite(sourceKey);
      if (favorited) db.prepare('INSERT OR IGNORE INTO favorites (source_key) VALUES (?)').run(sourceKey);
      else db.prepare('DELETE FROM favorites WHERE source_key = ?').run(sourceKey);
    }, () => {
      this.overrides.favorites = favorited
        ? normalizeArray([...this.overrides.favorites, sourceKey])
        : this.overrides.favorites.filter((item) => item !== sourceKey);
    }, { catalogChanged: false });
    return { favorited };
  }

  isFavorite(sourceKey) {
    return this.overrides.favorites.includes(sourceKey);
  }

  async setCustomCover(sourceKey, chapterId, pageIndex) {
    const cover = { chapterId: String(chapterId), pageIndex: Number(pageIndex) };
    await this.#queueVisibleWrite((db) => db.prepare(`
      INSERT INTO custom_covers (source_key, chapter_id, page_index) VALUES (?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET chapter_id = excluded.chapter_id, page_index = excluded.page_index
    `).run(sourceKey, cover.chapterId, cover.pageIndex), () => {
      this.overrides.customCovers[sourceKey] = cover;
    }, { catalogChanged: false });
    return this.getOverrides();
  }

  async removeCustomCover(sourceKey) {
    await this.#queueVisibleWrite((db) => db.prepare('DELETE FROM custom_covers WHERE source_key = ?').run(sourceKey), () => {
      delete this.overrides.customCovers[sourceKey];
    }, { catalogChanged: false });
    return this.getOverrides();
  }

  getCustomCover(sourceKey) {
    const cover = this.overrides.customCovers[sourceKey];
    return this.#isValidPageReference(sourceKey, cover) ? cover : null;
  }

  #isValidPageReference(sourceKey, reference) {
    const chapter = this.chapterIndex.get(reference?.chapterId);
    // 重新扫描可能移除旧的封面章节；保留覆盖数据，但不要返回失效 URL。
    return chapter && this.chapterOwners.get(chapter.id) === sourceKey &&
      Number.isInteger(reference.pageIndex) && reference.pageIndex >= 1 &&
      reference.pageIndex <= chapter.pageCount;
  }

  getMetadata(sourceKey) {
    return this.overrides.metadata[sourceKey] ?? null;
  }

  async setMetadata(sourceKey, value) {
    const metadata = normalizeMetadata(value);
    await this.#queueVisibleWrite((db) => {
      if (Object.keys(metadata).length === 0) {
        db.prepare('DELETE FROM series_metadata WHERE source_key = ?').run(sourceKey);
      } else {
        db.prepare(`
          INSERT INTO series_metadata (source_key, title, author, description) VALUES (?, ?, ?, ?)
          ON CONFLICT(source_key) DO UPDATE SET
            title = excluded.title, author = excluded.author, description = excluded.description
        `).run(sourceKey, metadata.title ?? null, metadata.author ?? null, metadata.description ?? null);
      }
      this.#refreshFts(db, sourceKey, metadata, this.overrides.tags[sourceKey] ?? []);
    }, () => {
      if (Object.keys(metadata).length > 0) this.overrides.metadata[sourceKey] = metadata;
      else delete this.overrides.metadata[sourceKey];
    });
    return metadata;
  }

  getTags(sourceKey) {
    return this.overrides.tags[sourceKey] ?? [];
  }

  async setTags(sourceKey, values) {
    const tags = normalizeArray(values);
    await this.#queueVisibleWrite((db) => {
      db.prepare('DELETE FROM series_tags WHERE source_key = ?').run(sourceKey);
      const insert = db.prepare('INSERT INTO series_tags (source_key, value) VALUES (?, ?)');
      for (const tag of tags) insert.run(sourceKey, tag);
      this.#refreshFts(db, sourceKey, this.overrides.metadata[sourceKey] ?? {}, tags);
    }, () => {
      if (tags.length > 0) this.overrides.tags[sourceKey] = tags;
      else delete this.overrides.tags[sourceKey];
    });
    return tags;
  }

  async batchSetTags(sourceKeys, values, { mode = 'merge' } = {}) {
    const keys = [...new Set(sourceKeys)];
    const requested = normalizeArray(values);
    const changed = [];
    await this.#queueVisibleWrite((db) => {
      const existing = db.prepare('SELECT value FROM series_tags WHERE source_key = ? ORDER BY value COLLATE NOCASE');
      const remove = db.prepare('DELETE FROM series_tags WHERE source_key = ?');
      const insert = db.prepare('INSERT INTO series_tags (source_key, value) VALUES (?, ?)');
      const metadata = db.prepare('SELECT title, author, description FROM series_metadata WHERE source_key = ?');
      for (const sourceKey of keys) {
        const tags = mode === 'replace' ? [...requested]
          : normalizeArray([...existing.all(sourceKey).map((row) => row.value), ...requested]);
        remove.run(sourceKey);
        for (const tag of tags) insert.run(sourceKey, tag);
        this.#refreshFts(db, sourceKey, metadata.get(sourceKey) ?? {}, tags);
        changed.push([sourceKey, tags]);
      }
    }, () => {
      for (const [sourceKey, tags] of changed) {
        if (tags.length) this.overrides.tags[sourceKey] = tags;
        else delete this.overrides.tags[sourceKey];
      }
    });
    return { updated: changed.length };
  }

  #refreshFts(db, sourceKey, metadata, tags) {
    const series = db.prepare('SELECT id, title, author FROM series WHERE source_key = ?').get(sourceKey);
    if (!series) return;
    this.ftsWriter.refresh(series.id, metadata.title ?? series.title, metadata.author ?? series.author,
      metadata.description ?? '', [...tags].sort().join(' '));
  }

  getAllTags() {
    return normalizeArray(Object.values(this.overrides.tags).flat()).sort(naturalCompare);
  }

  getAllCategories() {
    return normalizeArray([
      ...(this.library.stats.categories ?? []),
      ...Object.values(this.overrides.seriesCategories).flat(),
    ]).sort(naturalCompare);
  }

  getReadProgress(sourceKey) {
    const progress = this.overrides.readProgress[sourceKey];
    return this.#isValidPageReference(sourceKey, progress)
      ? { ...progress, totalPages: this.chapterIndex.get(progress.chapterId).pageCount }
      : null;
  }

  async setReadProgress(sourceKey, value) {
    const progress = {
      chapterId: String(value.chapterId),
      pageIndex: Number.isInteger(value.pageIndex) ? value.pageIndex : 1,
      totalPages: Number.isInteger(value.totalPages) ? value.totalPages : 0,
      updatedAt: new Date().toISOString(),
    };
    await this.#queueVisibleWrite((db) => db.prepare(`
      INSERT INTO read_progress (source_key, chapter_id, page_index, total_pages, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        chapter_id = excluded.chapter_id,
        page_index = excluded.page_index,
        total_pages = excluded.total_pages,
        updated_at = excluded.updated_at
    `).run(sourceKey, progress.chapterId, progress.pageIndex, progress.totalPages, progress.updatedAt), () => {
      this.overrides.readProgress[sourceKey] = progress;
    }, { catalogChanged: false });
    return deepClone(progress);
  }

  async clearReadProgress(sourceKey) {
    await this.#queueVisibleWrite((db) => db.prepare('DELETE FROM read_progress WHERE source_key = ?').run(sourceKey), () => {
      delete this.overrides.readProgress[sourceKey];
    }, { catalogChanged: false });
  }

  async setMetadataAndTags(sourceKey, metadataValue, tagValues) {
    const metadata = normalizeMetadata(metadataValue);
    const tags = normalizeArray(tagValues);
    await this.#queueVisibleWrite((db) => {
      if (Object.keys(metadata).length === 0) {
        db.prepare('DELETE FROM series_metadata WHERE source_key = ?').run(sourceKey);
      } else {
        db.prepare(`
          INSERT INTO series_metadata (source_key, title, author, description) VALUES (?, ?, ?, ?)
          ON CONFLICT(source_key) DO UPDATE SET
            title = excluded.title, author = excluded.author, description = excluded.description
        `).run(sourceKey, metadata.title ?? null, metadata.author ?? null, metadata.description ?? null);
      }
      db.prepare('DELETE FROM series_tags WHERE source_key = ?').run(sourceKey);
      const insertTag = db.prepare('INSERT INTO series_tags (source_key, value) VALUES (?, ?)');
      for (const tag of tags) insertTag.run(sourceKey, tag);
      this.#refreshFts(db, sourceKey, metadata, tags);
    }, () => {
      if (Object.keys(metadata).length > 0) this.overrides.metadata[sourceKey] = metadata;
      else delete this.overrides.metadata[sourceKey];
      if (tags.length > 0) this.overrides.tags[sourceKey] = tags;
      else delete this.overrides.tags[sourceKey];
    });
    return { metadata: deepClone(metadata), tags: [...tags] };
  }

  async createMetadataJob({ id, provider, apply, overwrite, series }) {
    const createdAt = new Date().toISOString();
    await this.#queueWrite(() => this.#transaction((db) => {
      db.prepare(`
        INSERT INTO metadata_jobs (
          id, provider, status, apply_changes, overwrite_existing, created_at, total_count
        ) VALUES (?, ?, 'queued', ?, ?, ?, ?)
      `).run(id, provider, apply ? 1 : 0, overwrite ? 1 : 0, createdAt, series.length);
      const insert = db.prepare(`
        INSERT INTO metadata_job_items (
          job_id, position, series_id, source_key, status
        ) VALUES (?, ?, ?, ?, 'queued')
      `);
      series.forEach((item, index) => insert.run(id, index, item.id, item.sourceKey));
    }));
    return this.getMetadataJob(id);
  }

  getMetadataJob(jobId, options = {}) {
    const db = this.getDatabase();
    const row = db.prepare('SELECT * FROM metadata_jobs WHERE id = ?').get(jobId);
    if (!row) return null;
    const page = Math.max(1, Number.parseInt(options.page ?? 1, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, Number.parseInt(options.pageSize ?? 50, 10) || 50));
    const items = db.prepare(`
      SELECT position, series_id, source_key, status, attempts, result_json, error
      FROM metadata_job_items
      WHERE job_id = ?
      ORDER BY position
      LIMIT ? OFFSET ?
    `).all(jobId, pageSize, (page - 1) * pageSize).map((item) => ({
      position: item.position,
      seriesId: item.series_id,
      sourceKey: item.source_key,
      status: item.status,
      attempts: item.attempts,
      result: parseJson(item.result_json, null),
      error: item.error,
    }));
    return {
      jobId: row.id,
      provider: row.provider,
      status: row.status,
      apply: Boolean(row.apply_changes),
      overwrite: Boolean(row.overwrite_existing),
      cancelRequested: Boolean(row.cancel_requested),
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      total: row.total_count,
      completedCount: row.completed_count,
      successCount: row.success_count,
      failureCount: row.failure_count,
      items,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(row.total_count / pageSize)),
    };
  }

  getMetadataJobItems(jobId) {
    return this.getDatabase().prepare(`
      SELECT position, series_id AS seriesId, source_key AS sourceKey, status
      FROM metadata_job_items WHERE job_id = ? ORDER BY position
    `).all(jobId);
  }

  async markMetadataJobRunning(jobId) {
    const startedAt = new Date().toISOString();
    await this.#queueWrite(() => this.getDatabase().prepare(`
      UPDATE metadata_jobs SET status = 'running', started_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(startedAt, jobId));
  }

  async markMetadataJobItemRunning(jobId, position) {
    await this.#queueWrite(() => this.getDatabase().prepare(`
      UPDATE metadata_job_items SET status = 'running', attempts = attempts + 1
      WHERE job_id = ? AND position = ? AND status = 'queued'
    `).run(jobId, position));
  }

  async finishMetadataJobItem(jobId, position, { ok, result = null, error = null }) {
    await this.#queueWrite(() => this.#transaction((db) => {
      db.prepare(`
        UPDATE metadata_job_items SET status = ?, result_json = ?, error = ?
        WHERE job_id = ? AND position = ?
      `).run(ok ? 'succeeded' : 'failed', result ? JSON.stringify(result) : null, error, jobId, position);
      db.prepare(`
        UPDATE metadata_jobs SET
          completed_count = (SELECT count(*) FROM metadata_job_items WHERE job_id = ? AND status IN ('succeeded', 'failed')),
          success_count = (SELECT count(*) FROM metadata_job_items WHERE job_id = ? AND status = 'succeeded'),
          failure_count = (SELECT count(*) FROM metadata_job_items WHERE job_id = ? AND status = 'failed')
        WHERE id = ?
      `).run(jobId, jobId, jobId, jobId);
    }));
  }

  async requestMetadataJobCancel(jobId) {
    const result = await this.#queueWrite(() => this.getDatabase().prepare(`
      UPDATE metadata_jobs SET cancel_requested = 1
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(jobId));
    return result.changes > 0;
  }

  isMetadataJobCancelRequested(jobId) {
    const row = this.getDatabase().prepare('SELECT cancel_requested FROM metadata_jobs WHERE id = ?').get(jobId);
    return Boolean(row?.cancel_requested);
  }

  async finishMetadataJob(jobId, status) {
    const finishedAt = new Date().toISOString();
    await this.#queueWrite(() => this.#transaction((db) => {
      if (status === 'cancelled') {
        db.prepare(`
          UPDATE metadata_job_items SET status = 'cancelled'
          WHERE job_id = ? AND status = 'queued'
        `).run(jobId);
      }
      db.prepare(`
        UPDATE metadata_jobs SET status = ?, finished_at = ? WHERE id = ?
      `).run(status, finishedAt, jobId);
    }));
  }

}
