import { naturalCompare, normalizeArray } from './utils.mjs';
import { findSimilarSeries } from './recommendations.mjs';
import { detectDuplicates } from './routes/advanced.mjs';

/** 只在线程内保留轻量作品信息，绝不装载/复制整库卷章或页记录。 */
export class CatalogQueries {
  constructor(db, queryPage) {
    this.db = db;
    this.queryPage = queryPage;
    this.revision = null;
    this.series = [];
    this.ordered = [];
    this.features = new Map();
    this.bySource = new Map();
  }

  refresh() {
    // 翻页/收藏/封面只改变投影字段，不清空作者、标签、分类等目录特征。
    const revision = this.db.prepare("SELECT value FROM app_meta WHERE key = 'catalog_revision'").get()?.value
      ?? this.db.prepare("SELECT value FROM app_meta WHERE key = 'revision'").get()?.value ?? '0';
    if (revision === this.revision) return;
    this.series = this.db.prepare(`
      SELECT s.id, s.title, s.author, s.source_key, s.page_count, s.chapter_count, s.volume_count,
        s.total_bytes, sm.title AS override_title, sm.author AS override_author
      FROM series s LEFT JOIN series_metadata sm ON sm.source_key = s.source_key ORDER BY s.position
    `).all().map((row) => ({
      id: row.id, title: row.title, author: row.author, sourceKey: row.source_key,
      effectiveTitle: row.override_title || row.title,
      effectiveAuthor: row.override_author || row.author,
      counts: { pages: row.page_count, chapters: row.chapter_count, volumes: row.volume_count },
      totalBytes: row.total_bytes, categories: { effective: [] }, tags: [],
    }));
    const byId = new Map(this.series.map((series) => [series.id, series]));
    this.bySource = new Map(this.series.map((series) => [series.sourceKey, series]));
    for (const row of this.db.prepare('SELECT series_id, value FROM series_categories ORDER BY series_id, kind, position').iterate()) {
      byId.get(row.series_id)?.categories.effective.push(row.value);
    }
    for (const row of this.db.prepare('SELECT source_key, value FROM series_category_overrides ORDER BY source_key, position').iterate()) {
      this.bySource.get(row.source_key)?.categories.effective.push(row.value);
    }
    for (const row of this.db.prepare('SELECT source_key, value FROM series_tags ORDER BY source_key, value COLLATE NOCASE').iterate()) {
      this.bySource.get(row.source_key)?.tags.push(row.value);
    }
    for (const series of this.series) series.categories.effective = normalizeArray(series.categories.effective);
    // 同标题沿用扫描顺序；中文数字顺序与旧 OPDS 一致。
    this.ordered = [...this.series].sort((a, b) => naturalCompare(a.effectiveTitle, b.effectiveTitle));
    this.features.clear();
    this.revision = revision;
  }

  project(ids) {
    if (ids.length === 0) return [];
    const rows = this.queryPage(this.db, { seriesIds: ids }, { page: 1, pageSize: ids.length }).items;
    const byId = new Map(rows.map((item) => [item.id, item]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
  }

  opds(query = {}) {
    this.refresh();
    const search = String(query.search ?? '').trim().toLowerCase();
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize ?? '30', 10) || 30));
    const matches = search ? this.ordered.filter((item) =>
      item.effectiveTitle.toLowerCase().includes(search) ||
      item.effectiveAuthor?.toLowerCase().includes(search) || item.sourceKey.toLowerCase().includes(search)) : this.ordered;
    const totalPages = Math.max(1, Math.ceil(matches.length / pageSize));
    const page = Math.min(totalPages, Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1));
    return { items: this.project(matches.slice((page - 1) * pageSize, page * pageSize).map((item) => item.id)),
      page, pageSize, totalPages, total: matches.length,
      lastScanAt: this.db.prepare('SELECT last_scan_at FROM library_state WHERE id=1').get()?.last_scan_at ?? null };
  }

  recommendations({ seriesId, limit = 8 }) {
    this.refresh();
    const store = {
      getMetadata: (sourceKey) => {
        const item = this.bySource.get(sourceKey);
        return item ? { title: item.effectiveTitle, author: item.effectiveAuthor } : null;
      },
      getTags: (sourceKey) => this.bySource.get(sourceKey)?.tags ?? [],
    };
    const scored = findSimilarSeries({ series: this.series }, store, seriesId, { limit, featureCache: this.features });
    if (!scored) return null;
    const projected = new Map(this.project(scored.map((item) => item.series.id)).map((item) => [item.id, item]));
    return scored.map((item) => ({ score: item.score, reasons: item.reasons, series: projected.get(item.series.id) }));
  }

  duplicates() { this.refresh(); return detectDuplicates(this.series); }
}
