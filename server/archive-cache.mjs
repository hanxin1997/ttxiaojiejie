import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  ArchiveError,
  DEFAULT_ARCHIVE_LIMITS,
  extractArchivePage,
  validateArchiveSource,
} from './archive.mjs';

const CACHE_FILE = /^[a-f0-9]{64}\.(?:jpg|jpeg|png|webp|gif|bmp|avif)$/;
const TEMP_FILE = /^[a-f0-9]{64}\.(?:jpg|jpeg|png|webp|gif|bmp|avif)\.[a-f0-9-]+\.tmp$/;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function createArchiveCacheKey(source) {
  const entry = source.archiveEntry;
  const identity = entry.archiveIdentity;
  const payload = [
    1,
    path.resolve(source.sourcePath),
    identity.size,
    identity.mtimeMs,
    identity.ctimeMs,
    entry.index,
    entry.name,
    entry.crc32,
    entry.compressedSize,
    entry.uncompressedSize,
    entry.compressionMethod,
  ];
  const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return `${hash}${path.posix.extname(entry.name).toLowerCase()}`;
}

export class ArchiveCache {
  constructor(cacheDir, options = {}) {
    this.cacheDir = path.resolve(cacheDir);
    this.maxConcurrent = positiveInteger(options.concurrency, 2);
    this.maxQueue = positiveInteger(options.maxQueue, 128);
    this.maxBytes = positiveInteger(options.maxBytes, 512 * 1024 * 1024);
    this.ttlMs = positiveInteger(options.ttlMs, 7 * 24 * 60 * 60 * 1000);
    this.limits = Object.fromEntries(Object.entries(DEFAULT_ARCHIVE_LIMITS).map(([name, fallback]) =>
      [name, positiveInteger(options[name], fallback)]));
    this.extractPage = options.extractPage ?? extractArchivePage;
    this.pendingJobs = new Map();
    this.waitingQueue = [];
    this.activeJobs = new Set();
    this.records = new Map();
    this.pins = new Map();
    this.evictions = new Map();
    this.totalBytes = 0;
    this.reservedBytes = 0;
    this.evictionCount = 0;
    this.initPromise = null;
    this.prunePromise = null;
    this.closePromise = null;
    this.closing = false;
    this.closed = false;
    this.nextPruneAt = 0;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await fs.mkdir(this.cacheDir, { recursive: true });
        const names = await fs.readdir(this.cacheDir);
        for (const name of names) {
          const filePath = path.join(this.cacheDir, name);
          if (TEMP_FILE.test(name)) {
            await fs.unlink(filePath).catch(() => {});
            continue;
          }
          if (!CACHE_FILE.test(name)) continue;
          try {
            const stats = await fs.stat(filePath);
            if (!stats.isFile()) continue;
            this.records.set(name, { key: name, sourcePath: filePath, size: stats.size, lastAccess: stats.mtimeMs });
            this.totalBytes += stats.size;
          } catch {
            // Ignore a cache file removed by external maintenance.
          }
        }
        // 仅启动时排序；运行中使用 Map 的插入顺序维护 LRU。
        this.records = new Map([...this.records.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess));
        await this.pruneCache();
        return true;
      })();
    }
    return this.initPromise;
  }

  #assertOpen() {
    if (this.closing) throw new ArchiveError('ARCHIVE_CLOSED', 'CBZ 页面缓存正在关闭', 503);
  }

  #pin(key) {
    this.pins.set(key, (this.pins.get(key) ?? 0) + 1);
  }

  #unpin(key) {
    const next = (this.pins.get(key) ?? 1) - 1;
    if (next > 0) this.pins.set(key, next);
    else this.pins.delete(key);
    const record = this.records.get(key);
    if (record) {
      record.lastAccess = Date.now();
      this.records.delete(key);
      this.records.set(key, record);
    }
  }

  async acquire(source) {
    this.#assertOpen();
    await this.init();
    // 即使命中磁盘缓存也验证真实归档，不能长期服务已经替换或删除的源文件。
    await validateArchiveSource(source.sourcePath, source.archiveEntry, this.limits);
    if (source.archiveEntry.uncompressedSize > this.maxBytes) {
      throw new ArchiveError('ARCHIVE_LIMIT', 'CBZ 单页大小超过原图缓存容量');
    }
    this.#assertOpen();
    const key = createArchiveCacheKey(source);
    this.#pin(key);
    try {
      const sourcePath = await this.#resolve(key, source);
      // 缓存 stat/排队期间归档也可能被替换，交付租约前再次核对来源。
      await validateArchiveSource(source.sourcePath, source.archiveEntry, this.limits);
      let released = false;
      return {
        sourcePath,
        release: async () => {
          if (released) return;
          released = true;
          this.#unpin(key);
          // 热页正常释放只更新 LRU；容量压力或 TTL 到期才进入清理。
          if (this.totalBytes + this.reservedBytes > this.maxBytes || Date.now() >= this.nextPruneAt) {
            await this.pruneCache();
          }
        },
      };
    } catch (error) {
      this.#unpin(key);
      throw error;
    }
  }

  async #resolve(key, source) {
    // 淘汰已开始时等待 unlink 完成，随后再决定命中或重建，避免读取中被删除。
    if (this.evictions.has(key)) await this.evictions.get(key);
    if (this.pendingJobs.has(key)) return this.pendingJobs.get(key).promise;
    const cachePath = path.join(this.cacheDir, key);
    try {
      const stats = await fs.stat(cachePath);
      if (stats.isFile() && stats.size === source.archiveEntry.uncompressedSize) {
        const previous = this.records.get(key);
        if (!previous) this.totalBytes += stats.size;
        else this.totalBytes += stats.size - previous.size;
        // 访问时间只更新内存，不触碰文件 mtime/ctime，保持 HTTP 与缩略图缓存稳定。
        this.records.delete(key);
        this.records.set(key, { key, sourcePath: cachePath, size: stats.size, lastAccess: Date.now() });
        return cachePath;
      }
      throw new ArchiveError('ARCHIVE_INVALID', 'CBZ 原图缓存损坏，请清理缓存后重试');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const previous = this.records.get(key);
      if (previous) {
        this.records.delete(key);
        this.totalBytes -= previous.size;
      }
    }
    if (this.pendingJobs.has(key)) return this.pendingJobs.get(key).promise;
    this.#assertOpen();
    if (this.activeJobs.size >= this.maxConcurrent && this.waitingQueue.length >= this.maxQueue) {
      throw new ArchiveError('ARCHIVE_BUSY', 'CBZ 解压队列已满，请稍后重试', 503);
    }
    const job = {
      key,
      source,
      cachePath,
      controller: new AbortController(),
    };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    this.pendingJobs.set(key, job);
    this.waitingQueue.push(job);
    this.#processQueue();
    return job.promise;
  }

  #processQueue() {
    while (!this.closing && this.activeJobs.size < this.maxConcurrent && this.waitingQueue.length > 0) {
      const job = this.waitingQueue.shift();
      this.activeJobs.add(job);
      const finish = () => {
        this.activeJobs.delete(job);
        if (this.pendingJobs.get(job.key) === job) this.pendingJobs.delete(job.key);
        this.#processQueue();
      };
      void this.#runJob(job).then((result) => {
        finish();
        job.resolve(result);
      }, (error) => {
        finish();
        job.reject(error);
      });
    }
  }

  async #runJob(job) {
    const tempPath = `${job.cachePath}.${crypto.randomUUID()}.tmp`;
    const size = job.source.archiveEntry.uncompressedSize;
    let reserved = false;
    try {
      // 预留磁盘容量将临时文件也计入上限；租用中的页无法淘汰时返回可重试错误。
      this.reservedBytes += size;
      reserved = true;
      await this.pruneCache();
      if (this.totalBytes + this.reservedBytes > this.maxBytes) {
        throw new ArchiveError('ARCHIVE_BUSY', 'CBZ 缓存空间正在使用，请稍后重试', 503);
      }
      await this.extractPage(job.source.sourcePath, job.source.archiveEntry, tempPath, {
        ...this.limits,
        signal: job.controller.signal,
      });
      await validateArchiveSource(job.source.sourcePath, job.source.archiveEntry, {
        ...this.limits,
        signal: job.controller.signal,
      });
      const stats = await fs.stat(tempPath);
      if (!stats.isFile() || stats.size !== size) {
        throw new ArchiveError('ARCHIVE_INVALID', 'CBZ 解压结果大小不匹配');
      }
      if (job.controller.signal.aborted) {
        throw new ArchiveError('ARCHIVE_ABORTED', 'CBZ 读取已取消', 503);
      }
      await fs.rename(tempPath, job.cachePath);
      const previous = this.records.get(job.key);
      this.totalBytes += stats.size - (previous?.size ?? 0);
      this.records.set(job.key, { key: job.key, sourcePath: job.cachePath, size: stats.size, lastAccess: Date.now() });
      return job.cachePath;
    } finally {
      if (reserved) this.reservedBytes -= size;
      await fs.unlink(tempPath).catch(() => {});
    }
  }

  async #evict(record) {
    if (this.pins.has(record.key) || this.evictions.has(record.key)) return;
    const task = (async () => {
      try {
        await fs.unlink(record.sourcePath);
      } catch (error) {
        if (error.code !== 'ENOENT') return;
      }
      if (this.records.get(record.key) === record) {
        this.records.delete(record.key);
        this.totalBytes -= record.size;
        this.evictionCount += 1;
      }
    })();
    this.evictions.set(record.key, task);
    try {
      await task;
    } finally {
      if (this.evictions.get(record.key) === task) this.evictions.delete(record.key);
    }
  }

  async pruneCache() {
    if (this.prunePromise) return this.prunePromise;
    this.prunePromise = (async () => {
      const now = Date.now();
      const budget = this.records.size;
      let visited = 0;
      for (const record of this.records.values()) {
        // await unlink 期间热页可能移到尾部，防止一次清理不断追赶访问请求。
        if (++visited > budget) break;
        if (now - record.lastAccess <= this.ttlMs && this.totalBytes + this.reservedBytes <= this.maxBytes) break;
        await this.#evict(record);
      }
      this.nextPruneAt = now + Math.min(this.ttlMs, 60_000);
    })();
    try {
      await this.prunePromise;
    } finally {
      this.prunePromise = null;
    }
  }

  async getStats() {
    await this.init();
    return {
      count: this.records.size,
      totalSize: this.totalBytes,
      maxBytes: this.maxBytes,
      ttlMs: this.ttlMs,
      maxPageBytes: this.limits.maxPageBytes,
      queued: this.waitingQueue.length,
      active: this.activeJobs.size,
      pinned: this.pins.size,
      reservedBytes: this.reservedBytes,
      evictions: this.evictionCount,
      cacheDir: this.cacheDir,
      closing: this.closing,
    };
  }

  async close({ force = false } = {}) {
    this.closing = true;
    // 可以在温和关闭尚未结束时再次调用 force，将活动的流解压升级为取消。
    if (force) {
      for (const job of this.activeJobs) job.controller.abort(new Error('Archive cache shutdown'));
    }
    if (!this.closePromise) {
      for (const job of this.waitingQueue.splice(0)) {
        this.pendingJobs.delete(job.key);
        job.reject(new ArchiveError('ARCHIVE_CLOSED', 'CBZ 页面缓存正在关闭', 503));
      }
      this.closePromise = (async () => {
        await Promise.allSettled([...this.activeJobs].map((job) => job.promise));
        if (this.prunePromise) await this.prunePromise;
        this.closed = true;
      })();
    }
    return this.closePromise;
  }
}
