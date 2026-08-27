import { parseJsonBody } from '../middleware.mjs';

export function registerSettingsRoutes(router, ctx) {
  const { store, scanCoordinator } = ctx;

  router.get('/api/settings', (_req, _res, { respond }) => {
    respond(200, store.getSettings());
  });

  router.put('/api/settings', async (req, _res, { respond }) => {
    const body = await parseJsonBody(req);
    const settings = await store.replaceSettings(body);
    scanCoordinator.schedule();
    ctx.notifyLibraryChanged('settings-updated');
    respond(200, settings);
  });
}
