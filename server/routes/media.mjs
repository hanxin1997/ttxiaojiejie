import { text, serveFile } from '../middleware.mjs';
import { acquireMediaSource, getArchiveVariantIdentity } from '../media-source.mjs';
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

  async function serveImage(req, res, source, variant) {
    let lease;
    let variantLease;
    try {
      // 优先复用 WebP，即使其原图已经淘汰，也不必重新解压和编码。
      // 老的测试/适配器只有 getVariant 时仍沿用原契约。
      const cacheIdentity = variant !== 'original' && source.archiveEntry && thumbnailService?.acquireCachedVariant
        ? await getArchiveVariantIdentity(source, ctx.archiveCache)
        : null;
      if (cacheIdentity) {
        variantLease = await thumbnailService.acquireCachedVariant(cacheIdentity, variant);
        if (variantLease) {
          await getArchiveVariantIdentity(source, ctx.archiveCache);
          await serveFile(res, variantLease.sourcePath, req);
          return;
        }
      }
      lease = await acquireMediaSource(source, ctx.archiveCache);
      let variantPath = null;
      if (variant !== 'original' && thumbnailService) {
        if (thumbnailService.acquireVariant) {
          variantLease = await thumbnailService.acquireVariant(lease.sourcePath, variant, { cacheIdentity });
          variantPath = variantLease?.sourcePath;
        } else {
          variantPath = await thumbnailService.getVariant(lease.sourcePath, variant);
        }
        if (cacheIdentity) await getArchiveVariantIdentity(source, ctx.archiveCache);
      }
      await serveFile(res, variantPath || lease.sourcePath, req);
    } catch (error) {
      if (!res.headersSent && String(error.code ?? '').startsWith('ARCHIVE_')) {
        res.setHeader('Cache-Control', 'no-store');
        text(res, error.statusCode || 422, error.message);
      } else {
        throw error;
      }
    } finally {
      // 变体处理和 HTTP 发送都结束后才允许淘汰原图缓存。
      await variantLease?.release();
      await lease?.release();
    }
  }

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

    await serveImage(req, res, cover, variant);
  };

  const serveChapterPage = async (req, res, { params, query }) => {
    const pageIndex = /^\d+$/.test(params.pageIndex) ? Number(params.pageIndex) : Number.NaN;
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 1) {
      text(res, 404, 'Not found');
      return;
    }
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

    await serveImage(req, res, page, variant);
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
