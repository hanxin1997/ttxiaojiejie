export function createContext({ store, scanCoordinator, watcher, config, liveUpdates, thumbnailService, metadataJobs, runtimeMetrics }) {
  const ctx = {
    store,
    scanCoordinator,
    watcher,
    config,
    liveUpdates,
    thumbnailService: thumbnailService ?? null,
    metadataJobs: metadataJobs ?? null,
    runtimeMetrics: runtimeMetrics ?? null,
  };

  ctx.notifyScanUpdate = () => {
    ctx.liveUpdates?.broadcast('scan:update', {
      status: ctx.scanCoordinator.getStatus(),
      progress: ctx.scanCoordinator.getProgress(),
    });
  };

  ctx.notifyLibraryChanged = (reason, extra = {}) => {
    const library = ctx.store.getLibrarySummary();
    ctx.liveUpdates?.broadcast('library:changed', {
      reason,
      lastScanAt: library.lastScanAt,
      summary: library.stats,
      ...extra,
    });
  };

  ctx.notifyWatcherEvent = (event) => {
    ctx.liveUpdates?.broadcast('watcher:event', event);
  };

  ctx.notifyWatcherStatus = () => {
    ctx.liveUpdates?.broadcast(
      'watcher:status',
      ctx.watcher
        ? ctx.watcher.getStatus()
        : { running: false, watchedPaths: 0, lastEvent: null, eventCount: 0, errors: [] },
    );
  };

  ctx.notifyMetadataJobUpdate = (job) => {
    ctx.liveUpdates?.broadcast('metadata:job', job);
  };

  return ctx;
}
