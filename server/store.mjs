import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

import { DatabaseQueryWorker } from './database-query-worker.mjs';
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

function createRuntimeLibrary(library) {
  return {
    ...library,
    series: library.series.map((series) => {
      const { _reused, ...runtimeSeries } = series;
      return {
        ...runtimeSeries,
        volumes: (series.volumes ?? []).map((volume) => ({
          ...volume,
          chapters: (volume.chapters ?? []).map((chapter) => ({
            ...chapter,
            // 页面路径和文件身份只保存在 SQLite；媒体请求通过查询 worker 按需读取。
            pages: [],
          })),
        })),
      };
    }),
  };
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
    this.writePromise = Promise.resolve();
    this.queryWorker = null;
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
    this.revision = this.#readRevisionSync();
    this.overrides = this.#loadOverrides();
    this.settings = this.#loadSettings();
    this.library = this.#loadLibrary();
    this.#rebuildChapterIndex();
    this.queryWorker = new DatabaseQueryWorker(this.config.databaseFile, {
      maxQueue: this.config.resourceProfile?.databaseQueueLimit ?? 64,
    });
  }

  async close() {
    await this.queryWorker?.close();
    this.queryWorker = null;
    this.db?.close();
    this.db = null;
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
          ? { sourcePath: row.cover_source_path, fileName: row.cover_file_name }
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

  async #queueVisibleWrite(operation) {
    const change = await this.#queueWrite(() => this.#transaction((db) => {
      const result = operation(db);
      return { result, revision: this.#bumpRevisionSync(db) };
    }));
    this.revision = change.revision;
    return change.result;
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
    else if (readStatus === 'completed') conditions.push('rp.total_pages > 0 AND rp.page_index >= rp.total_pages');
    else if (readStatus === 'reading') conditions.push('rp.source_key IS NOT NULL AND (rp.total_pages <= 0 OR rp.page_index < rp.total_pages)');

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
      LEFT JOIN read_progress rp ON rp.source_key = s.source_key
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
        rp.total_pages AS progress_total_pages,
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
      const customCover = this.overrides.customCovers[row.source_key] ?? null;
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
    return this.queryWorker.call('ping', {});
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
    return this.library.series.find((series) => series.id === seriesId) ?? null;
  }

  findChapterById(chapterId) {
    return this.chapterIndex.get(chapterId) ?? null;
  }

  getChapterPage(chapterId, pageIndex) {
    const chapter = this.findChapterById(chapterId);
    return chapter?.pages?.[pageIndex - 1] ?? null;
  }

  async replaceSettings(nextSettings) {
    const normalized = normalizeSettings(mergeSettings(this.settings, nextSettings), this.config.defaultSettings);
    this.revision = await this.#queueWrite(() => this.#writeSettingsSync(normalized, true));
    this.settings = normalized;
    return this.getSettings();
  }

  async replaceCategoryFolders(categoryFolders) {
    return this.replaceSettings({ categoryFolders });
  }

  async replaceLibrary(nextLibrary) {
    const library = normalizeLibrary(nextLibrary);
    this.revision = await this.#queueWrite(() => this.#replaceLibrarySync(library));
    this.library = createRuntimeLibrary(library);
    this.#applyAllManualCategories();
    this.#rebuildChapterIndex();
    return this.getLibrarySummary();
  }

  #replaceLibrarySync(library) {
    return this.#transaction((db) => {
      db.exec(`
        DELETE FROM scan_issues;
        DELETE FROM library_state;
        DROP TABLE IF EXISTS temp.next_series_ids;
        CREATE TEMP TABLE next_series_ids (id TEXT PRIMARY KEY) WITHOUT ROWID;
      `);
      const nextSeriesIdStatement = db.prepare('INSERT INTO next_series_ids (id) VALUES (?)');
      for (const series of library.series) nextSeriesIdStatement.run(series.id);
      db.exec(`
        DELETE FROM series_fts WHERE series_id NOT IN (SELECT id FROM next_series_ids);
        DELETE FROM series WHERE id NOT IN (SELECT id FROM next_series_ids);
        DROP TABLE next_series_ids;
      `);
      db.prepare(`
        INSERT INTO library_state (
          id, last_scan_at, scan_root, series_count, volume_count, chapter_count,
          page_count, total_bytes, categories_json, scan_meta_json
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        library.lastScanAt,
        library.scanRoot,
        library.stats.seriesCount,
        library.stats.volumeCount,
        library.stats.chapterCount,
        library.stats.pageCount,
        library.stats.totalBytes,
        JSON.stringify(library.stats.categories),
        library.scanMeta ? JSON.stringify(library.scanMeta) : null,
      );

      const issueStatement = db.prepare('INSERT INTO scan_issues (position, message) VALUES (?, ?)');
      library.issues.forEach((issue, index) => issueStatement.run(index, issue));

      const seriesStatement = db.prepare(`
        INSERT INTO series (
          id, position, source_key, source_path, source_folder_name, title, author,
          dir_mtime, scan_fingerprint, updated_at, metadata_json, tags_json,
          cover_source_path, cover_file_name, volume_count, chapter_count, page_count, total_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const volumeStatement = db.prepare(`
        INSERT INTO volumes (id, series_id, position, title, source_path, synthetic)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const chapterStatement = db.prepare(`
        INSERT INTO chapters (
          id, series_id, volume_id, position, title, source_key, source_path,
          volume_title, page_count, total_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const pageStatement = db.prepare(`
        INSERT INTO pages (chapter_id, position, source_path, size_bytes, mtime_ms)
        VALUES (?, ?, ?, ?, ?)
      `);
      const categoryStatement = db.prepare(`
        INSERT INTO series_categories (series_id, kind, value, position) VALUES (?, ?, ?, ?)
      `);
      const ftsStatement = db.prepare(`
        INSERT INTO series_fts (series_id, title, author, description, tags) VALUES (?, ?, ?, ?, ?)
      `);
      const existingSeriesStatement = db.prepare('SELECT id FROM series WHERE id = ? AND source_key = ?');
      const updateSeriesStatement = db.prepare(`
        UPDATE series SET
          position = ?, source_path = ?, source_folder_name = ?, title = ?, author = ?,
          dir_mtime = ?, scan_fingerprint = ?, updated_at = ?, metadata_json = ?, tags_json = ?,
          cover_source_path = ?, cover_file_name = ?, volume_count = ?, chapter_count = ?,
          page_count = ?, total_bytes = ?
        WHERE id = ? AND source_key = ?
      `);
      const deleteSeriesStatement = db.prepare('DELETE FROM series WHERE id = ? OR source_key = ?');
      const deleteCategoriesStatement = db.prepare('DELETE FROM series_categories WHERE series_id = ?');
      const deleteFtsStatement = db.prepare('DELETE FROM series_fts WHERE series_id = ?');

      library.series.forEach((series, seriesPosition) => {
        const updatedAt = series.updatedAt ?? library.lastScanAt ?? new Date().toISOString();
        const reused = Boolean(
          series._reused && existingSeriesStatement.get(series.id, series.sourceKey),
        );

        if (reused) {
          updateSeriesStatement.run(
            seriesPosition,
            series.sourcePath,
            series.sourceFolderName ?? '',
            series.title,
            series.author ?? null,
            series.dirMtime ?? null,
            series.scanFingerprint ?? null,
            updatedAt,
            JSON.stringify(series.metadata ?? {}),
            JSON.stringify(series.tags ?? []),
            series.cover?.sourcePath ?? null,
            series.cover?.fileName ?? null,
            series.counts?.volumes ?? 0,
            series.counts?.chapters ?? 0,
            series.counts?.pages ?? 0,
            series.totalBytes ?? 0,
            series.id,
            series.sourceKey,
          );
          deleteCategoriesStatement.run(series.id);
        } else {
          deleteSeriesStatement.run(series.id, series.sourceKey);
          seriesStatement.run(
            series.id,
            seriesPosition,
            series.sourceKey,
            series.sourcePath,
            series.sourceFolderName ?? '',
            series.title,
            series.author ?? null,
            series.dirMtime ?? null,
            series.scanFingerprint ?? null,
            updatedAt,
            JSON.stringify(series.metadata ?? {}),
            JSON.stringify(series.tags ?? []),
            series.cover?.sourcePath ?? null,
            series.cover?.fileName ?? null,
            series.counts?.volumes ?? 0,
            series.counts?.chapters ?? 0,
            series.counts?.pages ?? 0,
            series.totalBytes ?? 0,
          );
        }

        for (const kind of ['auto', 'folder']) {
          normalizeArray(series.categories?.[kind]).forEach((category, index) => {
            categoryStatement.run(series.id, kind, category, index);
          });
        }

        if (!reused) {
          series.volumes.forEach((volume, volumePosition) => {
            volumeStatement.run(
              volume.id,
              series.id,
              volumePosition,
              volume.title,
              volume.sourcePath,
              volume.synthetic ? 1 : 0,
            );
            volume.chapters.forEach((chapter, chapterPosition) => {
              const pages = chapter.pages ?? [];
              chapterStatement.run(
                chapter.id,
                series.id,
                volume.id,
                chapterPosition,
                chapter.title,
                chapter.sourceKey,
                chapter.sourcePath,
                chapter.volumeTitle ?? volume.title,
                chapter.pageCount ?? pages.length,
                chapter.totalBytes ?? 0,
              );
              pages.forEach((page, pagePosition) => {
                pageStatement.run(
                  chapter.id,
                  page.index ?? pagePosition + 1,
                  page.sourcePath ?? path.join(chapter.sourcePath, page.relativePath),
                  page.sizeBytes ?? 0,
                  page.mtimeMs ?? 0,
                );
              });
            });
          });
        }

        deleteFtsStatement.run(series.id);
        const metadata = this.overrides.metadata[series.sourceKey] ?? {};
        const tags = this.overrides.tags[series.sourceKey] ?? series.tags ?? [];
        ftsStatement.run(
          series.id,
          metadata.title ?? series.title,
          metadata.author ?? series.author ?? '',
          metadata.description ?? '',
          tags.join(' '),
        );
      });
      return this.#bumpRevisionSync(db);
    });
  }

  #rebuildChapterIndex() {
    this.chapterIndex = new Map();
    for (const series of this.library.series) {
      for (const volume of series.volumes ?? []) {
        for (const chapter of volume.chapters ?? []) this.chapterIndex.set(chapter.id, chapter);
      }
    }
  }

  #applyManualCategories(sourceKey) {
    const series = this.library.series.find((item) => item.sourceKey === sourceKey);
    if (!series) return;
    series.categories.manual = [...(this.overrides.seriesCategories[sourceKey] ?? [])];
    series.categories.effective = normalizeArray([
      ...series.categories.auto,
      ...series.categories.folder,
      ...series.categories.manual,
    ]);
  }

  #applyAllManualCategories() {
    for (const series of this.library.series) this.#applyManualCategories(series.sourceKey);
  }

  async setSeriesCategories(sourceKey, categories) {
    const normalized = normalizeArray(categories);
    await this.#queueVisibleWrite((db) => {
      db.prepare('DELETE FROM series_category_overrides WHERE source_key = ?').run(sourceKey);
      const insert = db.prepare('INSERT INTO series_category_overrides (source_key, value, position) VALUES (?, ?, ?)');
      normalized.forEach((category, index) => insert.run(sourceKey, category, index));
    });
    if (normalized.length > 0) this.overrides.seriesCategories[sourceKey] = normalized;
    else delete this.overrides.seriesCategories[sourceKey];
    this.#applyManualCategories(sourceKey);
    return this.getOverrides();
  }

  async batchSetCategories(sourceKeys, categories) {
    const normalizedKeys = normalizeArray(sourceKeys);
    const normalizedCategories = normalizeArray(categories);
    await this.#queueVisibleWrite((db) => {
      const remove = db.prepare('DELETE FROM series_category_overrides WHERE source_key = ?');
      const insert = db.prepare('INSERT INTO series_category_overrides (source_key, value, position) VALUES (?, ?, ?)');
      for (const sourceKey of normalizedKeys) {
        remove.run(sourceKey);
        normalizedCategories.forEach((category, index) => insert.run(sourceKey, category, index));
      }
    });
    for (const sourceKey of normalizedKeys) {
      if (normalizedCategories.length > 0) this.overrides.seriesCategories[sourceKey] = [...normalizedCategories];
      else delete this.overrides.seriesCategories[sourceKey];
      this.#applyManualCategories(sourceKey);
    }
    return this.getOverrides();
  }

  async toggleFavorite(sourceKey) {
    const favorited = !this.isFavorite(sourceKey);
    await this.#queueVisibleWrite((db) => {
      if (favorited) db.prepare('INSERT OR IGNORE INTO favorites (source_key) VALUES (?)').run(sourceKey);
      else db.prepare('DELETE FROM favorites WHERE source_key = ?').run(sourceKey);
    });
    this.overrides.favorites = favorited
      ? normalizeArray([...this.overrides.favorites, sourceKey])
      : this.overrides.favorites.filter((item) => item !== sourceKey);
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
    `).run(sourceKey, cover.chapterId, cover.pageIndex));
    this.overrides.customCovers[sourceKey] = cover;
    return this.getOverrides();
  }

  async removeCustomCover(sourceKey) {
    await this.#queueVisibleWrite((db) => db.prepare('DELETE FROM custom_covers WHERE source_key = ?').run(sourceKey));
    delete this.overrides.customCovers[sourceKey];
    return this.getOverrides();
  }

  getCustomCover(sourceKey) {
    return this.overrides.customCovers[sourceKey] ?? null;
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
    });
    if (Object.keys(metadata).length > 0) this.overrides.metadata[sourceKey] = metadata;
    else delete this.overrides.metadata[sourceKey];
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
    });
    if (tags.length > 0) this.overrides.tags[sourceKey] = tags;
    else delete this.overrides.tags[sourceKey];
    return tags;
  }

  #refreshFts(db, sourceKey, metadata, tags) {
    const series = db.prepare('SELECT id, title, author FROM series WHERE source_key = ?').get(sourceKey);
    if (!series) return;
    db.prepare('DELETE FROM series_fts WHERE series_id = ?').run(series.id);
    db.prepare('INSERT INTO series_fts (series_id, title, author, description, tags) VALUES (?, ?, ?, ?, ?)').run(
      series.id,
      metadata.title ?? series.title,
      metadata.author ?? series.author ?? '',
      metadata.description ?? '',
      tags.join(' '),
    );
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
    return this.overrides.readProgress[sourceKey] ?? null;
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
    `).run(sourceKey, progress.chapterId, progress.pageIndex, progress.totalPages, progress.updatedAt));
    this.overrides.readProgress[sourceKey] = progress;
    return deepClone(progress);
  }

  async clearReadProgress(sourceKey) {
    await this.#queueVisibleWrite((db) => db.prepare('DELETE FROM read_progress WHERE source_key = ?').run(sourceKey));
    delete this.overrides.readProgress[sourceKey];
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
    });
    if (Object.keys(metadata).length > 0) this.overrides.metadata[sourceKey] = metadata;
    else delete this.overrides.metadata[sourceKey];
    if (tags.length > 0) this.overrides.tags[sourceKey] = tags;
    else delete this.overrides.tags[sourceKey];
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
