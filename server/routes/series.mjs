import { parseJsonBody } from '../middleware.mjs';
import { findSimilarSeries } from '../recommendations.mjs';

function getVisibleVolumeCount(series) {
  return series.volumes.some((volume) => !volume.synthetic) ? series.counts.volumes : 0;
}

function buildChapterLabel(volume, chapter) {
  return volume.synthetic || !volume.title ? chapter.title : `${volume.title} / ${chapter.title}`;
}

function buildSeriesListItem(series, store) {
  const latestVolume = series.volumes.at(-1);
  const latestChapter = latestVolume?.chapters.at(-1);
  const customCover = store.getCustomCover?.(series.sourceKey) ?? null;
  const metaOverride = store.getMetadata?.(series.sourceKey) ?? null;
  const tags = store.getTags?.(series.sourceKey) ?? [];
  const readProgress = store.getReadProgress?.(series.sourceKey) ?? null;

  let coverUrl = series.cover ? `/media/cover/${series.id}` : null;
  if (customCover) {
    coverUrl = `/media/chapter/${customCover.chapterId}/${customCover.pageIndex}`;
  }

  const thumbCoverUrl = coverUrl
    ? `${coverUrl}${coverUrl.includes('?') ? '&' : '?'}variant=cover`
    : null;

  let readStatus = 'unread';
  if (readProgress) {
    readStatus =
      readProgress.pageIndex >= readProgress.totalPages && readProgress.totalPages > 0
        ? 'completed'
        : 'reading';
  }

  return {
    id: series.id,
    title: metaOverride?.title || series.title,
    author: metaOverride?.author || series.author || null,
    description: metaOverride?.description || null,
    sourceFolderName: series.sourceFolderName,
    sourceKey: series.sourceKey,
    categories: series.categories,
    tags,
    metadata: series.metadata ?? {},
    counts: {
      ...series.counts,
      volumes: getVisibleVolumeCount(series),
    },
    totalBytes: series.totalBytes ?? 0,
    coverUrl,
    thumbCoverUrl,
    latestChapterTitle: latestChapter ? buildChapterLabel(latestVolume, latestChapter) : 'No chapters',
    favorite: store.isFavorite?.(series.sourceKey) ?? false,
    readProgress: readProgress ?? null,
    readStatus,
  };
}

function buildSeriesDetail(series, store) {
  return {
    ...buildSeriesListItem(series, store),
    volumes: series.volumes.map((volume) => ({
      id: volume.id,
      title: volume.synthetic ? '' : volume.title,
      synthetic: volume.synthetic,
      chapters: volume.chapters.map((chapter) => ({
        id: chapter.id,
        title: chapter.title,
        pageCount: chapter.pageCount,
      })),
    })),
  };
}

function findChapterById(store, chapterId) {
  return store.findChapterById(chapterId);
}

function findSeriesById(store, seriesId) {
  return store.getSeriesById(seriesId) ?? null;
}

function matchSeriesFilter(series, store, query, projectedItem = null) {
  const item = projectedItem ?? buildSeriesListItem(series, store);
  const search = String(query.search ?? '').trim().toLowerCase();
  const category = String(query.category ?? '').trim().toLowerCase();
  const favoritesOnly = query.favorites === 'true';
  const filterTags = String(query.tags ?? '').trim();
  const tagMode = String(query.tagMode ?? 'and').trim();
  const minPages = query.minPages ? Number.parseInt(query.minPages, 10) : null;
  const maxPages = query.maxPages ? Number.parseInt(query.maxPages, 10) : null;
  const minSize = query.minSize ? Number.parseInt(query.minSize, 10) : null;
  const maxSize = query.maxSize ? Number.parseInt(query.maxSize, 10) : null;
  const readStatus = String(query.readStatus ?? '').trim();

  const matchesSearch =
    search.length === 0 ||
    item.title.toLowerCase().includes(search) ||
    (item.author ?? '').toLowerCase().includes(search) ||
    item.sourceFolderName.toLowerCase().includes(search) ||
    item.sourceKey.toLowerCase().includes(search) ||
    item.tags.some((tag) => tag.toLowerCase().includes(search));

  const matchesCategory =
    category.length === 0 ||
    item.categories.effective.some((value) => value.toLowerCase() === category);

  const matchesFavorites = !favoritesOnly || item.favorite;

  let matchesTags = true;
  if (filterTags) {
    const requestedTags = filterTags
      .split(',')
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean);
    if (requestedTags.length > 0) {
      const itemTags = item.tags.map((tag) => tag.toLowerCase());
      matchesTags =
        tagMode === 'or'
          ? requestedTags.some((tag) => itemTags.includes(tag))
          : requestedTags.every((tag) => itemTags.includes(tag));
    }
  }

  const matchesPages =
    (minPages === null || !Number.isFinite(minPages) || item.counts.pages >= minPages) &&
    (maxPages === null || !Number.isFinite(maxPages) || item.counts.pages <= maxPages);

  const matchesSize =
    (minSize === null || !Number.isFinite(minSize) || item.totalBytes >= minSize) &&
    (maxSize === null || !Number.isFinite(maxSize) || item.totalBytes <= maxSize);

  const matchesReadStatus = !readStatus || item.readStatus === readStatus;

  return (
    matchesSearch &&
    matchesCategory &&
    matchesFavorites &&
    matchesTags &&
    matchesPages &&
    matchesSize &&
    matchesReadStatus
  );
}

export { buildSeriesListItem, buildSeriesDetail, findChapterById, findSeriesById };

export function registerSeriesRoutes(router, ctx) {
  const { store } = ctx;

  router.get('/api/series', async (_req, _res, { query, respond }) => {
    const page = Number.parseInt(query.page ?? '1', 10);
    const pageSize = Number.parseInt(query.pageSize ?? '80', 10);

    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      respond(400, { error: 'page must be >= 1 and pageSize must be between 1 and 200' });
      return;
    }

    const result = store.querySeriesPageAsync
      ? await store.querySeriesPageAsync(query, { page, pageSize })
      : store.querySeriesPage(query, { page, pageSize });
    respond(200, result);
  });

  router.get('/api/series/:id', async (_req, _res, { params, respond }) => {
    const detail = store.querySeriesDetailAsync
      ? await store.querySeriesDetailAsync(params.id)
      : (() => {
          const series = findSeriesById(store, params.id);
          return series ? buildSeriesDetail(series, store) : null;
        })();
    if (!detail) {
      respond(404, { error: 'Series not found' });
      return;
    }

    respond(200, detail);
  });

  router.get('/api/chapters/:id/pages', async (_req, _res, { params, respond }) => {
    const payload = store.queryChapterPagesAsync
      ? await store.queryChapterPagesAsync(params.id)
      : (() => {
          const chapter = findChapterById(store, params.id);
          return chapter
            ? {
                chapterId: chapter.id,
                pageCount: chapter.pageCount ?? chapter.pages?.length ?? 0,
                urlTemplate: `/media/chapter/${chapter.id}/{pageIndex}`,
              }
            : null;
        })();
    if (!payload) {
      respond(404, { error: 'Chapter not found' });
      return;
    }

    respond(200, payload);
  });

  router.get('/api/series/:id/recommendations', (_req, _res, { params, query, respond }) => {
    const limit = Math.max(1, Number.parseInt(query.limit ?? '8', 10) || 8);
    const library = store.getLibrary();
    const result = findSimilarSeries(library, store, params.id, { limit });

    if (!result) {
      respond(404, { error: 'Series not found' });
      return;
    }

    respond(200, {
      items: result.map((item) => ({
        score: item.score,
        reasons: item.reasons,
        series: buildSeriesListItem(item.series, store),
      })),
    });
  });

  router.put('/api/series/:id/categories', async (req, _res, { params, respond }) => {
    const series = findSeriesById(store, params.id);
    if (!series) {
      respond(404, { error: 'Series not found' });
      return;
    }

    const body = await parseJsonBody(req);
    await store.setSeriesCategories(series.sourceKey, body.categories ?? []);
    ctx.notifyLibraryChanged('category-updated', { seriesId: params.id });
    respond(200, { ok: true });
  });

  router.post('/api/series/:id/favorite', async (_req, _res, { params, respond }) => {
    const series = findSeriesById(store, params.id);
    if (!series) {
      respond(404, { error: 'Series not found' });
      return;
    }

    const result = await store.toggleFavorite(series.sourceKey);
    ctx.notifyLibraryChanged('favorite-updated', { seriesId: params.id });
    respond(200, result);
  });

  router.put('/api/series/:id/cover', async (req, _res, { params, respond }) => {
    const series = findSeriesById(store, params.id);
    if (!series) {
      respond(404, { error: 'Series not found' });
      return;
    }

    const body = await parseJsonBody(req);
    if (!body.chapterId || !Number.isInteger(body.pageIndex)) {
      respond(400, { error: 'chapterId and pageIndex are required' });
      return;
    }

    const chapter = findChapterById(store, body.chapterId);
    if (!chapter) {
      respond(404, { error: 'Chapter not found' });
      return;
    }

    if (body.pageIndex < 1 || body.pageIndex > (chapter.pageCount ?? chapter.pages?.length ?? 0)) {
      respond(400, { error: 'pageIndex is out of range' });
      return;
    }

    await store.setCustomCover(series.sourceKey, body.chapterId, body.pageIndex);
    ctx.notifyLibraryChanged('cover-updated', { seriesId: params.id });
    respond(200, { ok: true, coverUrl: `/media/chapter/${body.chapterId}/${body.pageIndex}` });
  });

  router.delete('/api/series/:id/cover', async (_req, _res, { params, respond }) => {
    const series = findSeriesById(store, params.id);
    if (!series) {
      respond(404, { error: 'Series not found' });
      return;
    }

    await store.removeCustomCover(series.sourceKey);
    ctx.notifyLibraryChanged('cover-reset', { seriesId: params.id });
    respond(200, { ok: true });
  });

  router.post('/api/series/batch/categories', async (req, _res, { respond }) => {
    const body = await parseJsonBody(req);
    const seriesIds = Array.isArray(body.seriesIds) ? body.seriesIds : [];
    const categories = body.categories ?? [];

    if (seriesIds.length === 0) {
      respond(400, { error: 'seriesIds cannot be empty' });
      return;
    }

    const sourceKeys = seriesIds
      .map((id) => findSeriesById(store, id))
      .filter(Boolean)
      .map((series) => series.sourceKey);

    if (sourceKeys.length === 0) {
      respond(404, { error: 'No valid series found' });
      return;
    }

    await store.batchSetCategories(sourceKeys, categories);
    ctx.notifyLibraryChanged('batch-categories-updated');
    respond(200, { ok: true, updated: sourceKeys.length });
  });

  router.post('/api/series/batch/tags', async (req, _res, { respond }) => {
    const body = await parseJsonBody(req);
    const seriesIds = Array.isArray(body.seriesIds) ? body.seriesIds : [];
    const tags = Array.isArray(body.tags) ? body.tags : [];
    const mode = body.mode ?? 'merge';

    if (seriesIds.length === 0) {
      respond(400, { error: 'seriesIds cannot be empty' });
      return;
    }

    const validSeries = seriesIds
      .map((id) => findSeriesById(store, id))
      .filter(Boolean);

    if (validSeries.length === 0) {
      respond(404, { error: 'No valid series found' });
      return;
    }

    for (const series of validSeries) {
      if (mode === 'replace') {
        await store.setTags(series.sourceKey, tags);
      } else {
        const existing = store.getTags(series.sourceKey);
        const merged = [...new Set([...existing, ...tags])];
        await store.setTags(series.sourceKey, merged);
      }
    }

    ctx.notifyLibraryChanged('batch-tags-updated');
    respond(200, { ok: true, updated: validSeries.length });
  });

  router.get('/api/series/:id/metadata', (_req, _res, { params, respond }) => {
    const series = findSeriesById(store, params.id);
    if (!series) {
      respond(404, { error: 'Series not found' });
      return;
    }

    const metaOverride = store.getMetadata(series.sourceKey);
    respond(200, {
      autoTitle: series.title,
      autoAuthor: series.author || null,
      override: metaOverride ?? {},
      effective: {
        title: metaOverride?.title || series.title,
        author: metaOverride?.author || series.author || null,
        description: metaOverride?.description || null,
      },
    });
  });

  router.put('/api/series/:id/metadata', async (req, _res, { params, respond }) => {
    const series = findSeriesById(store, params.id);
    if (!series) {
      respond(404, { error: 'Series not found' });
      return;
    }

    const body = await parseJsonBody(req);
    const metadata = await store.setMetadata(series.sourceKey, {
      title: body.title,
      author: body.author,
      description: body.description,
    });
    ctx.notifyLibraryChanged('metadata-updated', { seriesId: params.id });
    respond(200, { ok: true, metadata });
  });

  router.get('/api/series/:id/tags', (_req, _res, { params, respond }) => {
    const series = findSeriesById(store, params.id);
    if (!series) {
      respond(404, { error: 'Series not found' });
      return;
    }

    respond(200, { tags: store.getTags(series.sourceKey) });
  });

  router.put('/api/series/:id/tags', async (req, _res, { params, respond }) => {
    const series = findSeriesById(store, params.id);
    if (!series) {
      respond(404, { error: 'Series not found' });
      return;
    }

    const body = await parseJsonBody(req);
    const tags = await store.setTags(series.sourceKey, body.tags ?? []);
    ctx.notifyLibraryChanged('tags-updated', { seriesId: params.id });
    respond(200, { ok: true, tags });
  });

  router.get('/api/series/:id/progress', (_req, _res, { params, respond }) => {
    const series = findSeriesById(store, params.id);
    if (!series) {
      respond(404, { error: 'Series not found' });
      return;
    }

    const progress = store.getReadProgress(series.sourceKey);
    respond(200, { progress });
  });

  router.put('/api/series/:id/progress', async (req, _res, { params, respond }) => {
    const series = findSeriesById(store, params.id);
    if (!series) {
      respond(404, { error: 'Series not found' });
      return;
    }

    const body = await parseJsonBody(req);
    if (!body.chapterId || !Number.isInteger(body.pageIndex)) {
      respond(400, { error: 'chapterId and pageIndex are required' });
      return;
    }

    const progress = await store.setReadProgress(series.sourceKey, {
      chapterId: body.chapterId,
      pageIndex: body.pageIndex,
      totalPages: body.totalPages ?? 0,
    });
    respond(200, { ok: true, progress });
  });

  router.delete('/api/series/:id/progress', async (_req, _res, { params, respond }) => {
    const series = findSeriesById(store, params.id);
    if (!series) {
      respond(404, { error: 'Series not found' });
      return;
    }

    await store.clearReadProgress(series.sourceKey);
    respond(200, { ok: true });
  });
}
