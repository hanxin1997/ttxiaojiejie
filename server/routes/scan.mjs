import { buildStatePayload } from './state.mjs';

export function registerScanRoutes(router, ctx) {
  const { scanCoordinator } = ctx;

  router.post('/api/scan', async (_req, _res, { respond }) => {
    await scanCoordinator.run('manual');
    respond(200, { ok: true, state: buildStatePayload(ctx) });
  });

  router.get('/api/scan/progress', (_req, _res, { respond }) => {
    respond(200, {
      status: scanCoordinator.getStatus(),
      progress: scanCoordinator.getProgress(),
    });
  });
}
