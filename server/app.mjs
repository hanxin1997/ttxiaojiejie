import { URL } from 'node:url';

import { createStaticHandler, createErrorHandler, jsonCompressed } from './middleware.mjs';
import { createRateLimitHandler } from './rate-limit.mjs';
import { createRouter } from './router.mjs';
import { registerAdvancedRoutes } from './routes/advanced.mjs';
import { registerCategoryRoutes } from './routes/categories.mjs';
import { registerMediaRoutes } from './routes/media.mjs';
import { registerMetadataRoutes } from './routes/metadata.mjs';
import { registerOpdsRoutes } from './routes/opds.mjs';
import { registerScanRoutes } from './routes/scan.mjs';
import { registerSeriesRoutes } from './routes/series.mjs';
import { registerSettingsRoutes } from './routes/settings.mjs';
import { registerStateRoutes } from './routes/state.mjs';

export function createApp(ctx) {
  const router = createRouter();
  const serveStatic = createStaticHandler(ctx.config.publicDir);
  const handleError = createErrorHandler();
  const rateLimit = createRateLimitHandler(ctx.config.rateLimit);

  registerStateRoutes(router, ctx);
  registerSeriesRoutes(router, ctx);
  registerSettingsRoutes(router, ctx);
  registerScanRoutes(router, ctx);
  registerCategoryRoutes(router, ctx);
  registerAdvancedRoutes(router, ctx);
  registerMediaRoutes(router, ctx);
  registerMetadataRoutes(router, ctx);
  registerOpdsRoutes(router, ctx);

  return async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    const { pathname } = requestUrl;
    const method = request.method;
    const query = {};

    for (const [key, value] of requestUrl.searchParams) {
      query[key] = value;
    }

    try {
      if (rateLimit.handle(request, response, pathname)) {
        return;
      }

      const matched = router.match(method, pathname);
      if (matched) {
        const { handler, params } = matched;
        const respond = (statusCode, payload) => jsonCompressed(request, response, statusCode, payload);
        await handler(request, response, { params, query, ctx, respond });
        return;
      }

      await serveStatic(request, response);
    } catch (error) {
      handleError(error, response);
    }
  };
}
