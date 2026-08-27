import { Worker } from 'node:worker_threads';

/**
 * 串行执行 SQLite 读取，并在进入 worker 前执行硬队列上限，保护 HTTP 事件循环。
 */
export class DatabaseQueryWorker {
  constructor(databaseFile, { maxQueue = 64 } = {}) {
    this.databaseFile = databaseFile;
    this.maxQueue = Math.max(1, maxQueue);
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    this.metrics = { submitted: 0, completed: 0, failed: 0, rejected: 0, peakPending: 0 };
    this.readyPromise = null;
  }

  async start() {
    if (this.worker) return this.readyPromise;
    this.worker = new Worker(new URL('./database-query-worker-thread.mjs', import.meta.url), {
      workerData: { databaseFile: this.databaseFile },
    });
    this.worker.unref();
    this.readyPromise = new Promise((resolve, reject) => {
      const onReady = (message) => {
        if (!message?.ready) return;
        this.worker.off('message', onReady);
        resolve();
      };
      this.worker.on('message', onReady);
      this.worker.once('error', reject);
    });
    this.worker.on('message', (message) => this.#handleMessage(message));
    this.worker.on('error', (error) => this.#failAll(error));
    this.worker.on('exit', (code) => {
      if (code !== 0 && this.pending.size > 0) {
        this.#failAll(new Error(`Database query worker exited with code ${code}`));
      }
      this.worker = null;
    });
    return this.readyPromise;
  }

  async call(operation, payload) {
    await this.start();
    if (this.pending.size >= this.maxQueue) {
      this.metrics.rejected += 1;
      const error = new Error(`Database query queue is full (limit ${this.maxQueue})`);
      error.code = 'DB_QUEUE_FULL';
      throw error;
    }

    const id = this.nextId++;
    this.metrics.submitted += 1;
    this.metrics.peakPending = Math.max(this.metrics.peakPending, this.pending.size + 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, startedAt: performance.now() });
      this.worker.postMessage({ id, operation, payload });
    });
  }

  getMetrics() {
    return { ...this.metrics, pending: this.pending.size, limit: this.maxQueue };
  }

  async close() {
    const worker = this.worker;
    if (!worker) return;
    this.#failAll(new Error('Database query worker is closing'));
    this.worker = null;
    await worker.terminate();
  }

  #handleMessage(message) {
    if (message?.ready) return;
    const task = this.pending.get(message?.id);
    if (!task) return;
    this.pending.delete(message.id);
    if (message.error) {
      this.metrics.failed += 1;
      const error = new Error(message.error.message);
      if (message.error.code) error.code = message.error.code;
      task.reject(error);
    } else {
      this.metrics.completed += 1;
      task.resolve(message.result);
    }
  }

  #failAll(error) {
    for (const task of this.pending.values()) task.reject(error);
    this.metrics.failed += this.pending.size;
    this.pending.clear();
  }
}
