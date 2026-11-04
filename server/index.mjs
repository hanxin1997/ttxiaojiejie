import http from 'node:http';
import path from 'node:path';

import { createApp } from './app.mjs';
import { ArchiveCache } from './archive-cache.mjs';
import { closeArchiveIndexCache, configureArchiveIndexCache, getArchiveIndexStats } from './archive.mjs';
import { loadConfig } from './config.mjs';
import { createContext } from './context.mjs';
import { LiveUpdatesHub } from './live-updates.mjs';
import { logger } from './logger.mjs';
import { MetadataJobCoordinator } from './metadata-job-coordinator.mjs';
import { RuntimeMetrics } from './runtime-metrics.mjs';
import { ScanCoordinator } from './scan-coordinator.mjs';
import { shutdownRuntime } from './shutdown.mjs';
import { AppStore } from './store.mjs';
import { ThumbnailService } from './thumbnail.mjs';
import { LibraryWatcher } from './watcher.mjs';
import { ensureDir } from './utils.mjs';

const config = loadConfig();
// 保留足够容纳单个大型归档的索引预算；低配减少归档数和构建并发。
await configureArchiveIndexCache({ maxBytes: 16 * 1024 * 1024,
  maxArchives: config.resourceProfile.archiveIndexArchives,
  maxConcurrent: Math.min(2, config.resourceProfile.thumbnailConcurrency),
  maxQueue: config.resourceProfile.name === 'lite' ? 16 : 32 });
await ensureDir(config.publicDir);
await ensureDir(config.dataDir);

const store = new AppStore(config);
await store.init();

const thumbnailService = new ThumbnailService(path.join(config.dataDir, 'thumbs'), {
  concurrency: config.resourceProfile.thumbnailConcurrency,
  maxQueue: config.imageCache.maxQueue,
  maxBytes: config.imageCache.maxBytes,
  ttlMs: config.imageCache.ttlMs,
});
await thumbnailService.init();

// 使用同一资源档位控制解压并发，但原图缓存不能混入 thumbs 的 WebP 清理范围。
const archiveCache = new ArchiveCache(path.join(config.dataDir, 'archive-pages'), {
  concurrency: config.resourceProfile.thumbnailConcurrency,
  ...config.archiveCache,
});
await archiveCache.init();

const scanCoordinator = new ScanCoordinator(store, config);
const liveUpdates = new LiveUpdatesHub(config.webSocket);
const runtimeMetrics = new RuntimeMetrics();
const metadataJobs = new MetadataJobCoordinator(store, config, {
  onUpdate: (job) => ctx.notifyMetadataJobUpdate(job),
});
const watcher = new LibraryWatcher({
  libraryRoot: store.getSettings().libraryRoot,
  debounceMs: 5000,
  maxWatchers: config.resourceProfile.watcherLimit,
  onEvent: (event) => {
    ctx.notifyWatcherEvent(event);
  },
  onChange: (dirtyPaths) => {
    void scanCoordinator.run('fs-watch', { dirtyPaths }).catch((error) => {
      console.warn(`[Watcher] scan failed: ${error.message}`);
    });
  },
});
const ctx = createContext({
  store,
  scanCoordinator,
  watcher,
  config,
  liveUpdates,
  thumbnailService,
  archiveCache,
  metadataJobs,
  runtimeMetrics,
});
ctx.archiveIndexCache = { close: closeArchiveIndexCache, getStats: getArchiveIndexStats };

scanCoordinator.setContext(ctx);

const handler = createApp(ctx);
const server = http.createServer(handler);
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown-started', { signal });
  try {
    const result = await shutdownRuntime(server, ctx, { timeoutMs: config.shutdownTimeoutMs });
    logger.info('shutdown-completed', result);
  } catch (error) {
    process.exitCode = 1;
    logger.error('shutdown-failed', { error: error.message });
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

server.on('upgrade', (request, socket, head) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    if (requestUrl.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    if (!liveUpdates.handleUpgrade(request, socket, head)) {
      socket.destroy();
      return;
    }

    ctx.notifyScanUpdate();
    ctx.notifyWatcherStatus();
  } catch {
    socket.destroy();
  }
});

server.listen(config.port, async () => {
  logger.info('server-started', {
    address: `http://0.0.0.0:${config.port}`,
    resourceProfile: config.resourceProfile.name,
  });

  try {
    watcher.start();
    ctx.notifyWatcherStatus();
  } catch (error) {
    logger.warn('watcher-start-failed', { error: error.message });
  }

  scanCoordinator.schedule();
  try {
    await scanCoordinator.run('startup');
  } catch (error) {
    logger.error('startup-scan-failed', { error: error.message });
  }
});
