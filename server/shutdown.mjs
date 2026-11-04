import { logger } from './logger.mjs';

function closeHttpServer(server) {
  return new Promise((resolve) => {
    if (!server?.close) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
}

export async function shutdownRuntime(server, ctx, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 10_000);
  ctx.watcher?.stop?.();
  ctx.liveUpdates?.destroy?.();

  const closeServerTask = closeHttpServer(server);
  let timeout;
  const timeoutTask = new Promise((resolve) => {
    timeout = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  const backgroundTask = Promise.allSettled([
    ctx.scanCoordinator?.destroy?.(),
    ctx.metadataJobs?.destroy?.(),
  ]);
  let timedOut = false;
  const gracefulCloseTask = Promise.all([closeServerTask, backgroundTask]).then(async () => {
    // HTTP 仍可能在发送原图或生成变体；先排空消费者，再关闭它们使用的归档缓存。
    if (!timedOut) {
      await ctx.thumbnailService?.close?.();
      await ctx.archiveCache?.close?.();
      await ctx.archiveIndexCache?.close?.();
    }
    return 'closed';
  });

  try {
    const outcome = await Promise.race([gracefulCloseTask, timeoutTask]);
    if (outcome === 'timeout') {
      timedOut = true;
      server?.closeAllConnections?.();
      // 同一 deadline 也约束缓存关闭。到期后发出取消，让提取器自行清理临时文件，
      // 不再无期限等候已经超时的任务；正在等待的温和关闭可被 force 升级。
      const forcedClose = ctx.archiveCache?.close?.({ force: true });
      void Promise.resolve(forcedClose).catch((error) => {
        logger.warn('archive-cache-force-close-failed', { error: error.message });
      });
      // 取消某个读者不会取消共享索引构建；deadline 到期须明确关闭所有生产者。
      for (const [name, service] of [['archive-index', ctx.archiveIndexCache], ['image-cache', ctx.thumbnailService]]) {
        void Promise.resolve().then(() => service?.close?.()).catch((error) => {
          logger.warn(`${name}-force-close-failed`, { error: error.message });
        });
      }
    }
    return { graceful: outcome === 'closed' };
  } finally {
    clearTimeout(timeout);
    ctx.runtimeMetrics?.close?.();
    await ctx.store.close();
  }
}
