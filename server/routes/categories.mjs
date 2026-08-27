import path from 'node:path';

import {
  browseAvailableFolders as browseFolderTree,
} from '../folders.mjs';
import { parseJsonBody } from '../middleware.mjs';

export function registerCategoryRoutes(router, ctx) {
  const { store, scanCoordinator } = ctx;

  router.get('/api/folders', async (_req, _res, { respond }) => {
    const payload = await browseFolderTree(path.resolve(store.getSettings().libraryRoot), '');
    respond(200, payload);
  });

  router.get('/api/folders/browse', async (_req, _res, { query, respond }) => {
    const payload = await browseFolderTree(
      path.resolve(store.getSettings().libraryRoot),
      query.path ?? '',
    );
    respond(200, payload);
  });

  router.get('/api/settings/categories', (_req, _res, { respond }) => {
    respond(200, { items: store.getSettings().categoryFolders ?? [] });
  });

  router.put('/api/settings/categories', async (req, _res, { respond }) => {
    const body = await parseJsonBody(req);
    const settings = await store.replaceCategoryFolders(body.items ?? []);
    scanCoordinator.schedule();
    ctx.notifyLibraryChanged('category-folders-updated');
    respond(200, { items: settings.categoryFolders });
  });
}
