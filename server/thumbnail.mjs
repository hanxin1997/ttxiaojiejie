import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ensureDir } from './utils.mjs';

const VARIANT_SPEC_VERSION = 1;
const IMAGE_VARIANTS = Object.freeze({
  cover: Object.freeze({ name: 'cover', width: 300, height: 450, fit: 'cover', quality: 80 }),
  'reader-balanced': Object.freeze({ name: 'reader-balanced', width: 1600, height: null, fit: 'inside', quality: 80 }),
  'reader-lite': Object.freeze({ name: 'reader-lite', width: 1280, height: null, fit: 'inside', quality: 70 }),
  // 墨水屏档：服务端一次性去色并缓存，设备侧不再逐像素实时转灰度。
  'reader-mono': Object.freeze({ name: 'reader-mono', width: null, height: null, fit: 'inside', quality: 80, greyscale: true }),
  'reader-balanced-mono': Object.freeze({ name: 'reader-balanced-mono', width: 1600, height: null, fit: 'inside', quality: 80, greyscale: true }),
  'reader-lite-mono': Object.freeze({ name: 'reader-lite-mono', width: 1280, height: null, fit: 'inside', quality: 70, greyscale: true }),
});

function applyVariantPipeline(image, spec) {
  let pipeline = image.rotate();

  if (spec.greyscale) {
    // sRGB 是非线性色彩空间，greyscale() 是线性运算，缺少 gamma 校正结果会偏暗。
    // toColourspace('b-w') 才是真单通道；greyscale() 默认仍输出三个相同通道，白涨体积。
    pipeline = pipeline.gamma().greyscale().toColourspace('b-w');
  }

  if (spec.width) {
    const resize = { width: spec.width, fit: spec.fit, withoutEnlargement: true };
    if (spec.height) resize.height = spec.height;
    pipeline = pipeline.resize(resize);
  }

  return pipeline.webp({ quality: spec.quality });
}

export function getImageVariantSpec(name) {
  const spec = IMAGE_VARIANTS[String(name ?? '')];
  return spec ? { ...spec } : null;
}

export function createVariantCacheKey(sourcePath, stats, variantName) {
  const payload = [
    path.resolve(sourcePath),
    Number(stats.size) || 0,
    Number(stats.mtimeMs) || 0,
    Number(stats.ctimeMs) || 0,
    variantName,
    VARIANT_SPEC_VERSION,
  ].join('\0');
  return `${crypto.createHash('sha256').update(payload).digest('hex')}_${variantName}.webp`;
}

export function isCacheEntryExpired(stats, nowMs, ttlMs) {
  const effectiveTtl = Number(ttlMs);
  if (!Number.isFinite(effectiveTtl) || effectiveTtl <= 0) return false;
  return Number(nowMs) - Number(stats?.mtimeMs ?? 0) > effectiveTtl;
}

function sameSourceIdentity(left, right) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export class ThumbnailService {
  constructor(cacheDir, options = {}) {
    this.cacheDir = cacheDir;
    this.maxConcurrent = Math.max(1, Number(options.concurrency) || 2);
    this.maxQueue = Math.max(1, Number(options.maxQueue) || 128);
    this.maxBytes = Math.max(32 * 1024 * 1024, Number(options.maxBytes) || 512 * 1024 * 1024);
    this.ttlMs = Math.max(60_000, Number(options.ttlMs) || 7 * 24 * 60 * 60 * 1000);
    this.pendingJobs = new Map();
    this.waitingQueue = [];
    this.activeCount = 0;
    this.sharpModule = null;
    this.available = null;
    this.prunePromise = null;
    this.evictionCount = 0;
    this.lastPruneAt = null;
  }

  async init() {
    await ensureDir(this.cacheDir);
    await this.#removeTemporaryFiles();
    await this.pruneCache();
    return true;
  }

  isAvailable() {
    return this.available !== false;
  }

  async #loadSharp() {
    if (this.sharpModule) return true;
    if (this.available === false) return false;
    try {
      this.sharpModule = (await import('sharp')).default;
      this.available = true;
      return true;
    } catch {
      this.available = false;
      console.warn('[ImageCache] sharp 模块不可用，图片变体将回退原图');
      return false;
    }
  }

  #processQueue() {
    while (this.activeCount < this.maxConcurrent && this.waitingQueue.length > 0) {
      const entry = this.waitingQueue.shift();
      this.activeCount += 1;
      entry.run().then(entry.resolve, entry.reject).finally(() => {
        this.activeCount -= 1;
        this.#processQueue();
      });
    }
  }

  #enqueue(run) {
    if (this.waitingQueue.length >= this.maxQueue) {
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      this.waitingQueue.push({ run, resolve, reject });
      this.#processQueue();
    });
  }

  async getVariant(sourcePath, variantName = 'cover') {
    const spec = getImageVariantSpec(variantName);
    if (!spec || !(await this.#loadSharp())) {
      return null;
    }

    let sourceStats;
    try {
      sourceStats = await fs.stat(sourcePath);
      if (!sourceStats.isFile()) return null;
    } catch {
      return null;
    }

    const cacheKey = createVariantCacheKey(sourcePath, sourceStats, spec.name);
    const cachePath = path.join(this.cacheDir, cacheKey);
    try {
      const cached = await fs.stat(cachePath);
      if (cached.isFile() && cached.size > 0) {
        if (isCacheEntryExpired(cached, Date.now(), this.ttlMs)) {
          await fs.unlink(cachePath).catch(() => {});
        } else {
          // mtime 同时作为磁盘 LRU 的最近访问时间，TTL 因而是空闲过期时间。
          void fs.utimes(cachePath, new Date(), new Date()).catch(() => {});
          return cachePath;
        }
      }
    } catch {
      // Cache miss.
    }

    if (this.pendingJobs.has(cacheKey)) {
      return this.pendingJobs.get(cacheKey);
    }

    const job = this.#enqueue(async () => {
      const tempPath = `${cachePath}.${crypto.randomUUID()}.tmp`;
      try {
        try {
          const cached = await fs.stat(cachePath);
          if (cached.isFile() && cached.size > 0) {
            if (!isCacheEntryExpired(cached, Date.now(), this.ttlMs)) return cachePath;
            await fs.unlink(cachePath).catch(() => {});
          }
        } catch {
          // Still a cache miss after queueing.
        }

        const metadata = await this.sharpModule(sourcePath).metadata();
        if ((metadata.pages ?? 1) > 1) {
          return null;
        }

        await applyVariantPipeline(this.sharpModule(sourcePath), spec).toFile(tempPath);

        const afterStats = await fs.stat(sourcePath);
        if (!sameSourceIdentity(sourceStats, afterStats)) {
          await fs.unlink(tempPath).catch(() => {});
          return null;
        }

        await fs.rename(tempPath, cachePath);
        void this.pruneCache();
        return cachePath;
      } catch (error) {
        await fs.unlink(tempPath).catch(() => {});
        console.warn(`[ImageCache] 生成 ${variantName} 失败: ${sourcePath}`, error.message);
        return null;
      } finally {
        this.pendingJobs.delete(cacheKey);
      }
    });

    this.pendingJobs.set(cacheKey, job);
    return job;
  }

  async getThumbnail(sourcePath) {
    return this.getVariant(sourcePath, 'cover');
  }

  async pruneCache() {
    if (this.prunePromise) return this.prunePromise;
    this.prunePromise = (async () => {
      try {
        const names = await fs.readdir(this.cacheDir);
        const files = [];
        let totalSize = 0;
        const nowMs = Date.now();
        for (const name of names) {
          if (!name.endsWith('.webp')) continue;
          const filePath = path.join(this.cacheDir, name);
          try {
            const stats = await fs.stat(filePath);
            if (isCacheEntryExpired(stats, nowMs, this.ttlMs) && !this.pendingJobs.has(name)) {
              await fs.unlink(filePath).catch(() => {});
              this.evictionCount += 1;
              continue;
            }
            totalSize += stats.size;
            files.push({ name, filePath, size: stats.size, mtimeMs: stats.mtimeMs });
          } catch {
            // Ignore races with clear/prune.
          }
        }

        if (totalSize > this.maxBytes) {
          const targetSize = Math.floor(this.maxBytes * 0.9);
          files.sort((left, right) => left.mtimeMs - right.mtimeMs);
          for (const file of files) {
            if (totalSize <= targetSize) break;
            if (this.pendingJobs.has(file.name)) continue;
            await fs.unlink(file.filePath).catch(() => {});
            totalSize -= file.size;
            this.evictionCount += 1;
          }
        }
        this.lastPruneAt = new Date().toISOString();
      } finally {
        this.prunePromise = null;
      }
    })();
    return this.prunePromise;
  }

  async #removeTemporaryFiles() {
    try {
      const names = await fs.readdir(this.cacheDir);
      for (const name of names) {
        if (name.endsWith('.tmp')) {
          await fs.unlink(path.join(this.cacheDir, name)).catch(() => {});
        }
      }
    } catch {
      // Cache directory may not exist yet.
    }
  }

  async clearCache() {
    await Promise.allSettled([...this.pendingJobs.values()]);
    const names = await fs.readdir(this.cacheDir).catch(() => []);
    for (const name of names) {
      if (name.endsWith('.webp') || name.endsWith('.tmp')) {
        await fs.unlink(path.join(this.cacheDir, name)).catch(() => {});
      }
    }
  }

  async getStats() {
    const names = await fs.readdir(this.cacheDir).catch(() => []);
    let count = 0;
    let totalSize = 0;
    for (const name of names) {
      if (!name.endsWith('.webp')) continue;
      try {
        const stats = await fs.stat(path.join(this.cacheDir, name));
        count += 1;
        totalSize += stats.size;
      } catch {
        // Ignore concurrent cleanup.
      }
    }
    return {
      count,
      totalSize,
      maxBytes: this.maxBytes,
      ttlMs: this.ttlMs,
      queued: this.waitingQueue.length,
      active: this.activeCount,
      evictions: this.evictionCount,
      lastPruneAt: this.lastPruneAt,
      cacheDir: this.cacheDir,
    };
  }
}

export { IMAGE_VARIANTS };
