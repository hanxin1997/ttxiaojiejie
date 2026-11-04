/**
 * Central directory metadata only: no retained file descriptors or ZIP streams.
 * Map insertion order is the LRU order, so cache hits do not sort the index set.
 */
export class ArchiveIndexCache {
  constructor(options = {}) {
    const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;
    this.maxBytes = positive(options.maxBytes, 16 * 1024 * 1024);
    this.maxArchives = positive(options.maxArchives, 16);
    this.maxConcurrent = positive(options.maxConcurrent, 2);
    this.maxQueue = positive(options.maxQueue, 32);
    this.entries = new Map();
    this.pending = new Map();
    this.queue = [];
    this.active = new Set();
    this.bytes = 0;
    this.hits = 0;
    this.builds = 0;
    this.evictions = 0;
    this.closed = false;
    this.generation = 0;
  }

  #error(code, message) {
    return Object.assign(new Error(message), { code, statusCode: 503 });
  }

  async get(key, loader, signal) {
    if (this.closed) throw this.#error('ARCHIVE_CLOSED', 'CBZ 索引缓存正在关闭');
    if (signal?.aborted) throw this.#error('ARCHIVE_ABORTED', 'CBZ 索引读取已取消');
    let promise;
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      this.hits += 1;
      promise = Promise.resolve(cached.value);
    } else if (this.pending.has(key)) {
      promise = this.pending.get(key).promise;
      this.hits += 1;
    } else {
      if (this.active.size >= this.maxConcurrent && this.queue.length >= this.maxQueue) {
        throw this.#error('ARCHIVE_BUSY', 'CBZ 索引读取队列已满，请稍后重试');
      }
      const job = { key, loader, controller: new AbortController(), generation: this.generation };
      job.promise = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
      this.pending.set(key, job);
      this.queue.push(job);
      promise = job.promise;
      this.#process();
    }
    if (!signal) return promise;
    // A disconnected reader must not abort a shared build needed by another one.
    return new Promise((resolve, reject) => {
      const abort = () => reject(this.#error('ARCHIVE_ABORTED', 'CBZ 索引读取已取消'));
      signal.addEventListener('abort', abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }

  #process() {
    while (!this.closed && this.active.size < this.maxConcurrent && this.queue.length) {
      const job = this.queue.shift();
      this.active.add(job);
      this.builds += 1;
      const finish = () => {
        this.active.delete(job);
        this.pending.delete(job.key);
        this.#process();
      };
      void Promise.resolve().then(() => {
        if (job.controller.signal.aborted) throw this.#error('ARCHIVE_ABORTED', 'CBZ 索引读取已取消');
        return job.loader(job.controller.signal);
      }).then((value) => {
        const bytes = value.retainedBytes;
        if (!this.closed && job.generation === this.generation && Number.isSafeInteger(bytes) &&
            bytes >= 0 && bytes <= this.maxBytes) {
          while (this.entries.size >= this.maxArchives || this.bytes + bytes > this.maxBytes) {
            const [key, oldest] = this.entries.entries().next().value;
            this.entries.delete(key);
            this.bytes -= oldest.bytes;
            this.evictions += 1;
          }
          this.entries.set(job.key, { value, bytes });
          this.bytes += bytes;
        }
        return value;
      }).then((value) => {
        finish();
        job.resolve(value);
      }, (error) => {
        finish();
        job.reject(error);
      });
    }
  }

  clear() {
    this.generation += 1;
    this.entries.clear();
    this.bytes = 0;
  }

  getStats() {
    return {
      count: this.entries.size, totalSize: this.bytes, maxBytes: this.maxBytes,
      maxArchives: this.maxArchives, hits: this.hits, builds: this.builds,
      evictions: this.evictions, active: this.active.size, queued: this.queue.length,
      handles: 0, closed: this.closed,
    };
  }

  async close() {
    this.closed = true;
    this.clear();
    for (const job of this.queue.splice(0)) {
      this.pending.delete(job.key);
      job.reject(this.#error('ARCHIVE_CLOSED', 'CBZ 索引缓存正在关闭'));
    }
    for (const job of this.active) job.controller.abort();
    await Promise.allSettled([...this.active].map((job) => job.promise));
  }
}
