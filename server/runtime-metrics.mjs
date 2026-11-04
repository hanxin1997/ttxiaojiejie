import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getArchiveIndexStats } from './archive.mjs';

function nanosecondsToMilliseconds(value) {
  return Number.isFinite(value) ? Math.round((value / 1e6) * 1000) / 1000 : 0;
}

async function readCacheStats(cache) {
  if (!cache?.getStats) return { available: false };
  try {
    return await cache.getStats();
  } catch (error) {
    // 某个缓存的磁盘统计失败，不应让整个运行状态接口不可用。
    return { error: error.message };
  }
}

export class RuntimeMetrics {
  constructor(options = {}) {
    this.eventLoop = monitorEventLoopDelay({ resolution: Math.max(10, Number(options.resolution) || 20) });
    this.eventLoop.enable();
  }

  async snapshot(ctx) {
    const memory = process.memoryUsage();
    const [imageCache, archiveCache] = await Promise.all([
      readCacheStats(ctx.thumbnailService),
      readCacheStats(ctx.archiveCache),
    ]);

    return {
      at: new Date().toISOString(),
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
      },
      eventLoop: {
        meanMs: nanosecondsToMilliseconds(this.eventLoop.mean),
        p95Ms: nanosecondsToMilliseconds(this.eventLoop.percentile(95)),
        p99Ms: nanosecondsToMilliseconds(this.eventLoop.percentile(99)),
        maxMs: nanosecondsToMilliseconds(this.eventLoop.max),
      },
      database: ctx.store.getDatabaseWorkerMetrics?.() ?? {},
      databaseWrite: ctx.store.getDatabaseWriteWorkerMetrics?.() ?? {},
      scan: {
        status: ctx.scanCoordinator.getStatus(),
        progress: ctx.scanCoordinator.getProgress(),
      },
      imageCache,
      archiveCache,
      archiveIndex: getArchiveIndexStats(),
      metadata: ctx.metadataJobs?.getMetrics?.() ?? { active: 0, queued: 0 },
      websocket: { clients: ctx.liveUpdates?.getClientCount?.() ?? 0 },
      watcher: ctx.watcher?.getStatus?.() ?? null,
      resourceProfile: ctx.config?.resourceProfile?.name ?? 'unknown',
    };
  }

  close() {
    this.eventLoop.disable();
  }
}
