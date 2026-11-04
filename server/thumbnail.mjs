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

export function createIdentityVariantKey(identity, variantName) {
  return crypto.createHash('sha256').update(JSON.stringify([identity, variantName, VARIANT_SPEC_VERSION]))
    .digest('hex') + '_' + variantName + '.webp';
}

export class ThumbnailService {
  constructor(cacheDir, options = {}) {
    this.cacheDir = path.resolve(cacheDir);
    this.maxConcurrent = Math.max(1, Number(options.concurrency) || 2);
    this.maxQueue = Math.max(1, Number(options.maxQueue) || 128);
    this.maxBytes = Math.max(1, Number(options.maxBytes) || 512 * 1024 * 1024);
    this.ttlMs = Math.max(1, Number(options.ttlMs) || 7 * 24 * 60 * 60 * 1000);
    this.pendingJobs = new Map();
    this.accessTimes = new Map();
    this.records = new Map();
    this.pins = new Map();
    this.evictions = new Map();
    this.waitingQueue = [];
    this.activeCount = 0;
    this.totalBytes = 0;
    this.reservedBytes = 0;
    this.sharpModule = null;
    this.available = null;
    this.prunePromise = null;
    this.initPromise = null;
    this.evictionCount = 0;
    this.lastPruneAt = null;
    this.nextPruneAt = 0;
    this.nextReconcileAt = 0;
    this.removeAfterRelease = new Set();
    this.closing = false;
    this.clearing = false;
  }

  async init() {
    if (!this.initPromise) this.initPromise = (async () => {
      await ensureDir(this.cacheDir);
      // 启动只重建一次磁盘目录。运行中的统计直接使用增量账目。
      await this.#reconcile();
      await this.pruneCache();
      return true;
    })();
    return this.initPromise;
  }

  async #reconcile() {
    const entries = [];
    const seen = new Set();
    for (const name of await fs.readdir(this.cacheDir)) {
      const sourcePath = path.join(this.cacheDir, name);
      if (name.endsWith('.tmp')) {
        if (!this.nextReconcileAt) await fs.unlink(sourcePath).catch(() => {});
        continue;
      }
      if (!/^[a-f0-9]{64}_[a-z-]+\.webp$/.test(name)) continue;
      try {
        const stats = await fs.stat(sourcePath);
        if (stats.isFile()) {
          seen.add(name);
          entries.push({ key: name, sourcePath, size: stats.size, lastAccess: this.accessTimes.get(name) ?? stats.mtimeMs });
        }
      } catch { /* 外部清理与启动恢复允许并发。 */ }
    }
    entries.sort((a, b) => a.lastAccess - b.lastAccess);
    for (const record of entries) this.#remember(record);
    for (const key of this.records.keys()) {
      if (!seen.has(key) && !this.pendingJobs.has(key) && !this.pins.has(key)) this.#forget(key);
    }
    this.nextReconcileAt = Date.now() + 5 * 60_000;
  }

  #remember(record) {
    const previous = this.records.get(record.key);
    this.totalBytes += record.size - (previous?.size ?? 0);
    this.records.delete(record.key);
    this.records.set(record.key, record);
    this.accessTimes.set(record.key, record.lastAccess);
  }

  #forget(key) {
    const previous = this.records.get(key);
    if (previous) this.totalBytes -= previous.size;
    this.records.delete(key);
    this.accessTimes.delete(key);
  }

  isAvailable() { return this.available !== false; }

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

  #pin(key) { this.pins.set(key, (this.pins.get(key) ?? 0) + 1); }
  #unpin(key) {
    const count = (this.pins.get(key) ?? 1) - 1;
    if (count > 0) this.pins.set(key, count);
    else this.pins.delete(key);
    const record = this.records.get(key);
    if (record) this.#remember({ ...record, lastAccess: Date.now() });
  }

  #lease(key, sourcePath) {
    let released = false;
    return { sourcePath, release: async () => {
      if (released) return;
      released = true;
      this.#unpin(key);
      if (this.removeAfterRelease.has(key) && !this.pins.has(key)) {
        const record = this.records.get(key);
        if (record) await this.#evict(record);
        this.removeAfterRelease.delete(key);
      }
      if (this.#needsPrune()) await this.pruneCache();
    } };
  }

  #needsPrune() { return this.totalBytes + this.reservedBytes > this.maxBytes || Date.now() >= this.nextPruneAt; }

  async #lookup(key) {
    if (this.evictions.has(key)) await this.evictions.get(key);
    const sourcePath = path.join(this.cacheDir, key);
    try {
      const stats = await fs.stat(sourcePath);
      if (!stats.isFile() || stats.size <= 0) return null;
      const lastAccess = this.accessTimes.get(key) ?? stats.mtimeMs;
      if (isCacheEntryExpired({ mtimeMs: lastAccess }, Date.now(), this.ttlMs) && (this.pins.get(key) ?? 0) <= 1) {
        // 和容量淘汰共用删除栅栏；后来的请求必须等 unlink 结束，
        // 不能在 stat 成功后拿到一个马上被删除的租约。
        const removal = (async () => { await fs.unlink(sourcePath); this.#forget(key); })();
        this.evictions.set(key, removal);
        try { await removal; }
        finally { if (this.evictions.get(key) === removal) this.evictions.delete(key); }
        return null;
      }
      this.#remember({ key, sourcePath, size: stats.size, lastAccess: Date.now() });
      return sourcePath;
    } catch (error) {
      if (error.code === 'ENOENT') this.#forget(key);
      return null;
    }
  }

  async acquireCachedVariant(identity, variantName) {
    if (this.closing || this.clearing || !getImageVariantSpec(variantName)) return null;
    await this.init();
    const key = createIdentityVariantKey(identity, variantName);
    this.#pin(key);
    let handedOff = false;
    try {
      const cached = await this.#lookup(key);
      if (!cached) return null;
      handedOff = true;
      return this.#lease(key, cached);
    } finally {
      if (!handedOff) this.#unpin(key);
    }
  }

  #processQueue() {
    while (this.activeCount < this.maxConcurrent && this.waitingQueue.length > 0) {
      const entry = this.waitingQueue.shift();
      this.activeCount += 1;
      Promise.resolve().then(entry.run).then(entry.resolve, entry.reject).finally(() => {
        this.activeCount -= 1;
        this.#processQueue();
      });
    }
  }

  async acquireVariant(sourcePath, variantName = 'cover', options = {}) {
    const spec = getImageVariantSpec(variantName);
    if (!spec || this.closing || this.clearing) return null;
    await this.init();
    let sourceStats;
    try {
      sourceStats = await fs.stat(sourcePath);
      if (!sourceStats.isFile()) return null;
    } catch { return null; }
    const key = options.cacheIdentity
      ? createIdentityVariantKey(options.cacheIdentity, spec.name)
      : createVariantCacheKey(sourcePath, sourceStats, spec.name);
    this.#pin(key);
    let handedOff = false;
    try {
      let cached = await this.#lookup(key);
      if (!cached) {
        if (!this.pendingJobs.has(key)) {
          if (!(await this.#loadSharp())) return null;
          // loadSharp 可能让出执行权；再次检查去重表，不重复排队同一张图片。
          if (!this.pendingJobs.has(key)) {
            if (this.closing || this.clearing || this.waitingQueue.length >= this.maxQueue) return null;
            const job = new Promise((resolve, reject) => {
              this.waitingQueue.push({ resolve, reject, run: () => this.#generate(sourcePath, sourceStats, key, spec) });
            });
            // 只有真正入队的任务才登记，拒绝不能污染之后的重试。
            this.pendingJobs.set(key, job);
            const cleanup = () => { if (this.pendingJobs.get(key) === job) this.pendingJobs.delete(key); };
            void job.then(cleanup, cleanup);
            this.#processQueue();
          }
        }
        cached = await this.pendingJobs.get(key);
      }
      if (!cached) return null;
      const afterStats = await fs.stat(sourcePath);
      if (!sameSourceIdentity(sourceStats, afterStats)) return null;
      handedOff = true;
      return this.#lease(key, cached);
    } finally {
      if (!handedOff) this.#unpin(key);
    }
  }

  async #generate(sourcePath, sourceStats, key, spec) {
    const cachePath = path.join(this.cacheDir, key);
    const tempPath = cachePath + '.' + crypto.randomUUID() + '.tmp';
    let reserved = 0;
    try {
      const cached = await this.#lookup(key);
      if (cached) return cached;
      const metadata = await this.sharpModule(sourcePath).metadata();
      if ((metadata.pages ?? 1) > 1) return null;
      await applyVariantPipeline(this.sharpModule(sourcePath), spec).toFile(tempPath);
      if (!sameSourceIdentity(sourceStats, await fs.stat(sourcePath))) return null;
      const output = await fs.stat(tempPath);
      if (!output.isFile() || output.size <= 0 || output.size > this.maxBytes) return null;
      reserved = output.size;
      this.reservedBytes += reserved;
      if (this.#needsPrune()) await this.pruneCache();
      if (this.totalBytes + this.reservedBytes > this.maxBytes) return null;
      await fs.rename(tempPath, cachePath);
      this.#remember({ key, sourcePath: cachePath, size: output.size, lastAccess: Date.now() });
      this.reservedBytes -= reserved;
      reserved = 0;
      if (this.#needsPrune()) await this.pruneCache();
      return cachePath;
    } catch (error) {
      console.warn('[ImageCache] 生成 ' + spec.name + ' 失败: ' + sourcePath, error.message);
      return null;
    } finally {
      this.reservedBytes -= reserved;
      await fs.unlink(tempPath).catch(() => {});
    }
  }

  // 旧的路径调用保留兼容；HTTP 使用 acquireVariant 持有租约，发送期间禁止淘汰。
  async getVariant(sourcePath, variantName = 'cover', options = {}) {
    const lease = await this.acquireVariant(sourcePath, variantName, options);
    if (!lease) return null;
    await lease.release();
    return lease.sourcePath;
  }
  async getThumbnail(sourcePath) { return this.getVariant(sourcePath, 'cover'); }

  async #evict(record) {
    if (this.pins.has(record.key) || this.pendingJobs.has(record.key) || this.evictions.has(record.key)) return;
    const task = (async () => {
      try { await fs.unlink(record.sourcePath); }
      catch (error) { if (error.code !== 'ENOENT') return; }
      if (this.records.get(record.key) === record) { this.#forget(record.key); this.evictionCount += 1; }
    })();
    this.evictions.set(record.key, task);
    try { await task; } finally { this.evictions.delete(record.key); }
  }

  async pruneCache() {
    if (this.prunePromise) return this.prunePromise;
    this.prunePromise = (async () => {
      const now = Date.now();
      if (now >= this.nextReconcileAt) await this.#reconcile();
      // Map 按最后访问时间排序，正常命中不复制/排序全缓存。
      const targetBytes = this.totalBytes + this.reservedBytes > this.maxBytes
        ? Math.floor(this.maxBytes * 0.9) : this.maxBytes;
      const budget = this.records.size;
      let visited = 0;
      for (const record of this.records.values()) {
        if (++visited > budget) break; // 访问中的记录可能移到尾部，清理工作量必须有界。
        const expired = now - record.lastAccess > this.ttlMs;
        if (!expired && this.totalBytes + this.reservedBytes <= targetBytes) break;
        await this.#evict(record);
      }
      this.nextPruneAt = now + Math.min(this.ttlMs, 60_000);
      this.lastPruneAt = new Date(now).toISOString();
    })();
    try { await this.prunePromise; } finally { this.prunePromise = null; }
  }

  async clearCache() {
    await this.init();
    this.clearing = true;
    try {
      await Promise.allSettled([...this.pendingJobs.values()]);
      if (this.prunePromise) await this.prunePromise;
      // 已经交给 HTTP 的变体等租约释放后再清理，绝不删除正发送的文件。
      for (const record of [...this.records.values()]) {
        if (this.pins.has(record.key)) this.removeAfterRelease.add(record.key);
        else await this.#evict(record);
      }
      this.nextPruneAt = 0;
    } finally { this.clearing = false; }
  }

  async getStats() {
    await this.init();
    if (Date.now() >= this.nextReconcileAt) await this.pruneCache();
    return {
      count: this.records.size, totalSize: this.totalBytes, maxBytes: this.maxBytes, ttlMs: this.ttlMs,
      queued: this.waitingQueue.length, active: this.activeCount, pinned: this.pins.size, reservedBytes: this.reservedBytes,
      evictions: this.evictionCount, lastPruneAt: this.lastPruneAt, cacheDir: this.cacheDir,
    };
  }

  async close() {
    this.closing = true;
    await Promise.allSettled([...this.pendingJobs.values()]);
    if (this.prunePromise) await this.prunePromise;
  }
}

export { IMAGE_VARIANTS };
