import { text, serveFile } from '../middleware.mjs';
import { findSeriesById } from './series.mjs';

const COVER_VARIANTS = new Set(['original', 'cover']);
const CHAPTER_VARIANTS = new Set([
  'original',
  'cover',
  'reader-balanced',
  'reader-lite',
  'reader-mono',
  'reader-balanced-mono',
  'reader-lite-mono',
]);

function resolveVariant(query, allowed) {
  const variant = String(query.variant ?? 'original').trim();
  return allowed.has(variant) ? variant : null;
}

export function registerMediaRoutes(router, ctx) {
  const { store, thumbnailService } = ctx;

  const serveCover = async (req, res, { params, query }) => {
    const cover = store.queryCoverPathAsync
      ? await store.queryCoverPathAsync(params.id)
      : findSeriesById(store, params.id)?.cover;
    if (!cover?.sourcePath) {
      text(res, 404, 'Not found');
      return;
    }

    const variant = resolveVariant(query, COVER_VARIANTS);
    if (!variant) {
      text(res, 400, 'Unsupported image variant');
      return;
    }

    if (variant !== 'original' && thumbnailService) {
      const variantPath = await thumbnailService.getVariant(cover.sourcePath, variant);
      if (variantPath) {
        await serveFile(res, variantPath, req);
        return;
      }
    }

    await serveFile(res, cover.sourcePath, req);
  };

  const serveChapterPage = async (req, res, { params, query }) => {
    const pageIndex = Number.parseInt(params.pageIndex, 10);
    const page = store.queryChapterPageAsync
      ? await store.queryChapterPageAsync(params.chapterId, pageIndex)
      : store.getChapterPage(params.chapterId, pageIndex);

    if (!page?.sourcePath) {
      text(res, 404, 'Not found');
      return;
    }

    const variant = resolveVariant(query, CHAPTER_VARIANTS);
    if (!variant) {
      text(res, 400, 'Unsupported image variant');
      return;
    }

    if (variant !== 'original' && thumbnailService) {
      const variantPath = await thumbnailService.getVariant(page.sourcePath, variant);
      if (variantPath) {
        await serveFile(res, variantPath, req);
        return;
      }
    }

    await serveFile(res, page.sourcePath, req);
  };

  router.get('/media/cover/:id', serveCover);
  router.head('/media/cover/:id', serveCover);
  router.get('/media/chapter/:chapterId/:pageIndex', serveChapterPage);
  router.head('/media/chapter/:chapterId/:pageIndex', serveChapterPage);

  // 缩略图缓存管理
  router.get('/api/thumbnails/stats', async (_req, _res, { respond }) => {
    if (!thumbnailService?.isAvailable()) {
      respond(200, { available: false, count: 0, totalSize: 0, cacheDir: '' });
      return;
    }

    const stats = await thumbnailService.getStats();
    respond(200, { available: true, ...stats });
  });

  router.post('/api/thumbnails/clear', async (_req, _res, { respond }) => {
    if (!thumbnailService?.isAvailable()) {
      respond(200, { ok: false, reason: 'sharp 不可用' });
      return;
    }

    await thumbnailService.clearCache();
    respond(200, { ok: true });
  });
}
