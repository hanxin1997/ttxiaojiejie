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
    timeout.unref?.();
  });

  const backgroundTask = Promise.allSettled([
    ctx.scanCoordinator?.destroy?.(),
    ctx.metadataJobs?.destroy?.(),
  ]);
  const outcome = await Promise.race([
    Promise.all([closeServerTask, backgroundTask]).then(() => 'closed'),
    timeoutTask,
  ]);
  clearTimeout(timeout);

  if (outcome === 'timeout') {
    server?.closeAllConnections?.();
  }

  ctx.runtimeMetrics?.close?.();
  await ctx.store.close();
  return { graceful: outcome === 'closed' };
}
