function detectDuplicates(seriesList) {
  const groups = [];
  const titleMap = new Map();

  for (const series of seriesList) {
    const normalizedTitle = series.title.toLowerCase().replace(/[\s\-_]+/g, '');
    if (!titleMap.has(normalizedTitle)) {
      titleMap.set(normalizedTitle, []);
    }

    titleMap.get(normalizedTitle).push({
      id: series.id,
      title: series.title,
      sourceKey: series.sourceKey,
      counts: series.counts,
      totalBytes: series.totalBytes ?? 0,
    });
  }

  for (const items of titleMap.values()) {
    if (items.length > 1) {
      groups.push({ reason: 'same_title', items });
    }
  }

  const sizeMap = new Map();
  for (const series of seriesList) {
    if (series.counts.pages === 0) {
      continue;
    }

    const sizeKey = `${series.counts.pages}:${series.totalBytes ?? 0}`;
    if (!sizeMap.has(sizeKey)) {
      sizeMap.set(sizeKey, []);
    }

    sizeMap.get(sizeKey).push({
      id: series.id,
      title: series.title,
      sourceKey: series.sourceKey,
      counts: series.counts,
      totalBytes: series.totalBytes ?? 0,
    });
  }

  // 同标题组已占用的作品只收集一次，避免每个尺寸组再次展开全部已有组。
  const existingIds = new Set(groups.flatMap((group) => group.items.map((item) => item.id)));
  for (const items of sizeMap.values()) {
    if (items.length <= 1) {
      continue;
    }

    const filtered = items.filter((item) => !existingIds.has(item.id));
    if (filtered.length > 1) {
      groups.push({ reason: 'same_size_and_pages', items: filtered });
      for (const item of filtered) existingIds.add(item.id);
    }
  }

  return groups;
}

export { detectDuplicates };

export function registerAdvancedRoutes(router, ctx) {
  const { store } = ctx;

  router.get('/api/health', (_req, _res, { respond }) => {
    respond(200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      version: '0.2.0',
      clients: ctx.liveUpdates?.getClientCount() ?? 0,
    });
  });

  router.get('/api/duplicates', async (_req, _res, { respond }) => {
    const groups = store.queryCatalogOperationAsync
      ? await store.queryCatalogOperationAsync('duplicates', {})
      : detectDuplicates(store.getLibraryRef?.().series ?? store.getLibrary().series);
    respond(200, { groups });
  });

  router.get('/api/watcher', (_req, _res, { respond }) => {
    const watcher = ctx.watcher;
    respond(
      200,
      watcher
        ? watcher.getStatus()
        : { running: false, watchedPaths: 0, lastEvent: null, eventCount: 0, errors: [] },
    );
  });

  router.post('/api/watcher/restart', (_req, _res, { respond }) => {
    const watcher = ctx.watcher;
    if (!watcher) {
      respond(500, { error: 'Watcher not initialized' });
      return;
    }

    watcher.restart(store.getSettings().libraryRoot);
    ctx.notifyWatcherStatus();
    respond(200, { ok: true, status: watcher.getStatus() });
  });
}
