import { json } from '../middleware.mjs';
import { formatDateTime } from '../utils.mjs';

function buildStatePayload(ctx) {
  const library = ctx.store.getLibrarySummary();

  return {
    scanStatus: ctx.scanCoordinator.getStatus(),
    scanProgress: ctx.scanCoordinator.getProgress(),
    summary: library.stats,
    issues: library.issues,
    lastScanAt: library.lastScanAt,
    lastScanLabel: formatDateTime(library.lastScanAt),
    revision: library.revision,
    resourceProfile: ctx.config.resourceProfile,
  };
}

export { buildStatePayload };

export function registerStateRoutes(router, ctx) {
  router.get('/api/health', (_req, _res, { respond }) => {
    respond(200, { ok: true, now: new Date().toISOString() });
  });

  router.get('/api/health/live', (_req, _res, { respond }) => {
    respond(200, { ok: true, uptimeSeconds: Math.round(process.uptime()) });
  });

  router.get('/api/health/ready', async (_req, _res, { respond }) => {
    try {
      await ctx.store.checkReady();
      respond(200, { ok: true, revision: ctx.store.getLibrarySummary().revision });
    } catch (error) {
      respond(503, { ok: false, error: error.message });
    }
  });

  router.get('/api/metrics', async (_req, _res, { respond }) => {
    const metrics = ctx.runtimeMetrics
      ? await ctx.runtimeMetrics.snapshot(ctx)
      : { at: new Date().toISOString(), unavailable: true };
    respond(200, metrics);
  });

  router.get('/api/state', (_req, _res, { respond }) => {
    respond(200, buildStatePayload(ctx));
  });

  router.get('/api/categories', (_req, _res, { respond }) => {
    const library = ctx.store.getLibrarySummary();
    respond(200, {
      items: ctx.store.getAllCategories(),
      revision: library.revision,
    });
  });

  router.get('/api/tags', (_req, _res, { respond }) => {
    respond(200, { items: ctx.store.getAllTags() });
  });
}
