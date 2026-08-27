import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

import { normalizeArray } from './utils.mjs';

function parseJson(value, fallback) {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function querySeriesPage(db, query, { page, pageSize }) {
  const conditions = [];
  const parameters = [];
  const search = String(query.search ?? '').trim();
  const category = String(query.category ?? '').trim();
  const requestedTags = String(query.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);

  if (query.seriesId) {
    conditions.push('s.id = ?');
    parameters.push(String(query.seriesId));
  }

  if (search) {
    conditions.push('s.id IN (SELECT series_id FROM series_fts WHERE series_fts MATCH ?)');
    parameters.push(`"${search.replaceAll('"', '""')}"`);
  }
  if (category) {
    conditions.push(`(
      EXISTS (SELECT 1 FROM series_categories sc WHERE sc.series_id = s.id AND sc.value = ? COLLATE NOCASE)
      OR EXISTS (SELECT 1 FROM series_category_overrides sco WHERE sco.source_key = s.source_key AND sco.value = ? COLLATE NOCASE)
    )`);
    parameters.push(category, category);
  }
  if (query.favorites === 'true') {
    conditions.push('EXISTS (SELECT 1 FROM favorites f WHERE f.source_key = s.source_key)');
  }
  if (requestedTags.length > 0) {
    const tagChecks = requestedTags.map(() =>
      'EXISTS (SELECT 1 FROM series_tags st WHERE st.source_key = s.source_key AND st.value = ? COLLATE NOCASE)');
    conditions.push(`(${tagChecks.join(query.tagMode === 'or' ? ' OR ' : ' AND ')})`);
    parameters.push(...requestedTags);
  }

  for (const [key, sql] of [
    ['minPages', 's.page_count >= ?'],
    ['maxPages', 's.page_count <= ?'],
    ['minSize', 's.total_bytes >= ?'],
    ['maxSize', 's.total_bytes <= ?'],
  ]) {
    if (query[key] === undefined || query[key] === '') continue;
    const value = Number.parseInt(query[key], 10);
    if (Number.isFinite(value)) {
      conditions.push(sql);
      parameters.push(value);
    }
  }

  const readStatusFilter = String(query.readStatus ?? '').trim();
  if (readStatusFilter === 'unread') conditions.push('rp.source_key IS NULL');
  else if (readStatusFilter === 'completed') conditions.push('rp.total_pages > 0 AND rp.page_index >= rp.total_pages');
  else if (readStatusFilter === 'reading') conditions.push('rp.source_key IS NOT NULL AND (rp.total_pages <= 0 OR rp.page_index < rp.total_pages)');

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sortExpression = {
    title: 's.title COLLATE NOCASE',
    pages: 's.page_count',
    chapters: 's.chapter_count',
    volumes: 's.volume_count',
    size: 's.total_bytes',
    updatedAt: 's.updated_at',
  }[query.sort] ?? 's.title COLLATE NOCASE';
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
      (SELECT CASE WHEN v.synthetic = 1 OR v.title = '' THEN c.title ELSE v.title || ' / ' || c.title END
       FROM chapters c JOIN volumes v ON v.id = c.volume_id
       WHERE c.series_id = s.id ORDER BY v.position DESC, c.position DESC LIMIT 1) AS latest_chapter_title
    FROM series s
    ${joins}
    ${whereSql}
    ORDER BY ${sortExpression} ${sortOrder}, s.id ASC
    LIMIT ? OFFSET ?
  `).all(...parameters, pageSize, (page - 1) * pageSize);

  const categories = db.prepare('SELECT kind, value FROM series_categories WHERE series_id = ? ORDER BY kind, position');
  const manualCategories = db.prepare('SELECT value FROM series_category_overrides WHERE source_key = ? ORDER BY position');
  const tags = db.prepare('SELECT value FROM series_tags WHERE source_key = ? ORDER BY value COLLATE NOCASE');
  const customCover = db.prepare('SELECT chapter_id, page_index FROM custom_covers WHERE source_key = ?');

  const items = rows.map((row) => {
    const auto = [];
    const folder = [];
    for (const categoryRow of categories.all(row.id)) {
      if (categoryRow.kind === 'auto') auto.push(categoryRow.value);
      else folder.push(categoryRow.value);
    }
    const manual = manualCategories.all(row.source_key).map((item) => item.value);
    const custom = customCover.get(row.source_key);
    let coverUrl = row.cover_source_path ? `/media/cover/${row.id}` : null;
    if (custom) coverUrl = `/media/chapter/${custom.chapter_id}/${custom.page_index}`;
    const progress = row.progress_chapter_id
      ? {
          chapterId: row.progress_chapter_id,
          pageIndex: row.progress_page_index,
          totalPages: row.progress_total_pages,
          updatedAt: row.progress_updated_at,
        }
      : null;
    const readStatus = progress
      ? progress.totalPages > 0 && progress.pageIndex >= progress.totalPages ? 'completed' : 'reading'
      : 'unread';

    return {
      id: row.id,
      title: row.override_title ?? row.title,
      author: row.override_author ?? row.author,
      description: row.override_description,
      sourceFolderName: row.source_folder_name,
      sourceKey: row.source_key,
      categories: { auto, folder, manual, effective: normalizeArray([...auto, ...folder, ...manual]) },
      tags: tags.all(row.source_key).map((item) => item.value),
      metadata: parseJson(row.metadata_json, {}),
      counts: { volumes: row.volume_count, chapters: row.chapter_count, pages: row.page_count },
      totalBytes: row.total_bytes,
      coverUrl,
      thumbCoverUrl: coverUrl ? `${coverUrl}${coverUrl.includes('?') ? '&' : '?'}variant=cover` : null,
      latestChapterTitle: row.latest_chapter_title ?? 'No chapters',
      favorite: Boolean(row.favorite),
      readProgress: progress,
      readStatus,
    };
  });

  const revision = Number.parseInt(
    db.prepare("SELECT value FROM app_meta WHERE key = 'revision'").get()?.value ?? '0',
    10,
  ) || 0;
  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    revision,
  };
}

function querySeriesDetail(db, seriesId) {
  const item = querySeriesPage(db, { seriesId }, { page: 1, pageSize: 1 }).items[0];
  if (!item) return null;

  const volumeRows = db.prepare(`
    SELECT id, title, synthetic FROM volumes WHERE series_id = ? ORDER BY position
  `).all(seriesId);
  const chapterStatement = db.prepare(`
    SELECT id, title, page_count FROM chapters WHERE volume_id = ? ORDER BY position
  `);
  return {
    ...item,
    volumes: volumeRows.map((volume) => ({
      id: volume.id,
      title: volume.synthetic ? '' : volume.title,
      synthetic: Boolean(volume.synthetic),
      chapters: chapterStatement.all(volume.id).map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        pageCount: chapter.page_count,
      })),
    })),
  };
}

function queryChapterPages(db, chapterId) {
  const row = db.prepare('SELECT id, page_count FROM chapters WHERE id = ?').get(chapterId);
  if (!row) return null;
  return {
    chapterId: row.id,
    pageCount: row.page_count,
    urlTemplate: `/media/chapter/${row.id}/{pageIndex}`,
  };
}

function queryCoverPath(db, seriesId) {
  const row = db.prepare('SELECT cover_source_path FROM series WHERE id = ?').get(seriesId);
  return row?.cover_source_path ? { sourcePath: row.cover_source_path } : null;
}

function queryChapterPage(db, chapterId, pageIndex) {
  const row = db.prepare(`
    SELECT position, source_path, size_bytes, mtime_ms
    FROM pages WHERE chapter_id = ? AND position = ?
  `).get(chapterId, pageIndex);
  if (!row) return null;
  return {
    index: row.position,
    sourcePath: row.source_path,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
  };
}

const db = new DatabaseSync(workerData.databaseFile);
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA query_only = ON;');

parentPort.on('message', ({ id, operation, payload }) => {
  try {
    let result;
    if (operation === 'series-page') result = querySeriesPage(db, payload.query, payload.pagination);
    else if (operation === 'series-detail') result = querySeriesDetail(db, payload.seriesId);
    else if (operation === 'chapter-pages') result = queryChapterPages(db, payload.chapterId);
    else if (operation === 'cover-path') result = queryCoverPath(db, payload.seriesId);
    else if (operation === 'chapter-page') result = queryChapterPage(db, payload.chapterId, payload.pageIndex);
    else if (operation === 'ping') result = { ok: true };
    else throw new Error(`Unknown database worker operation: ${operation}`);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, code: error.code ?? null } });
  }
});

parentPort.postMessage({ ready: true });
