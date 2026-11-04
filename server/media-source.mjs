import path from 'node:path';

import { ArchiveError, validateArchiveSource } from './archive.mjs';
import { createArchiveCacheKey } from './archive-cache.mjs';

// 变体使用归档本身与条目身份，而不是会被淘汰重建的原图缓存文件时间戳。
export async function getArchiveVariantIdentity(source, archiveCache) {
  if (!source.archiveEntry) return null;
  if (!archiveCache) throw new ArchiveError('ARCHIVE_UNAVAILABLE', 'CBZ 阅读服务不可用', 503);
  await validateArchiveSource(source.sourcePath, source.archiveEntry, archiveCache.limits);
  return `archive:${createArchiveCacheKey(source)}`;
}

/**
 * 普通图片和归档页统一返回租约；调用者在图片发送及变体生成结束后释放，
 * 防止缓存淘汰删除正在使用的原图。
 */
export async function acquireMediaSource(source, archiveCache) {
  if (source.archiveEntry) {
    if (!archiveCache) {
      throw new ArchiveError('ARCHIVE_UNAVAILABLE', 'CBZ 阅读服务不可用', 503);
    }
    return archiveCache.acquire(source);
  }

  // 损坏的索引不能把整个 CBZ 当作图片返回给阅读器。
  if (path.extname(source.sourcePath).toLowerCase() === '.cbz') {
    throw new ArchiveError('ARCHIVE_STALE', 'CBZ 页索引已失效，请重新扫描图库', 409);
  }
  return { sourcePath: source.sourcePath, release: async () => {} };
}
