import { Worker } from 'node:worker_threads';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import path from 'node:path';

function* catalogRecords(library) {
  for (let position = 0; position < library.issues.length; position += 1) {
    yield { type: 'issue', position, value: library.issues[position] };
  }
  for (let seriesPosition = 0; seriesPosition < library.series.length; seriesPosition += 1) {
    const series = library.series[seriesPosition];
    const { volumes, ...value } = series;
    value.updatedAt ??= library.lastScanAt ?? new Date().toISOString();
    yield { type: 'series', position: seriesPosition, value };
    if (series._reused) continue;
    for (let volumePosition = 0; volumePosition < volumes.length; volumePosition += 1) {
      const { chapters, ...volume } = volumes[volumePosition];
      yield { type: 'volume', seriesId: series.id, position: volumePosition, value: volume };
      for (let chapterPosition = 0; chapterPosition < chapters.length; chapterPosition += 1) {
        const { pages = [], ...chapter } = chapters[chapterPosition];
        chapter.pageCount ??= pages.length;
        yield { type: 'chapter', seriesId: series.id, volumeId: volume.id, volumeTitle: volume.title,
          position: chapterPosition, value: chapter };
        if (chapter._reused) continue;
        for (let pagePosition = 0; pagePosition < pages.length; pagePosition += 1) {
          const page = pages[pagePosition];
          yield { type: 'page', chapterId: chapter.id, value: {
            index: page.index ?? pagePosition + 1,
            sourcePath: page.sourcePath ?? path.join(chapter.sourcePath, page.relativePath),
            sizeBytes: page.sizeBytes ?? 0, mtimeMs: page.mtimeMs ?? 0,
            archiveEntry: page.archiveEntry ?? null,
          } };
        }
      }
    }
  }
}

/** One acknowledged batch at a time bounds message copying and preserves transaction atomicity. */
export class DatabaseWriteWorker {
  constructor(databaseFile, { batchRows = 256, batchBytes = 256 * 1024 } = {}) {
    this.databaseFile = databaseFile;
    this.batchRows = Math.max(1, Math.min(1024, batchRows));
    this.batchBytes = Math.max(1024, Math.min(1024 * 1024, batchBytes));
    this.worker = null;
    this.readyPromise = null;
    this.pending = new Map();
    this.nextId = 1;
    this.replacing = false;
    this.closed = false;
    this.metrics = { completed: 0, failed: 0, batches: 0, peakBatchRows: 0, peakBatchBytes: 0, lastWrite: null };
  }

  async start() {
    if (this.closed) throw new Error('Database write worker is closed');
    if (this.worker) return this.readyPromise;
    const worker = new Worker(new URL('./database-write-worker-thread.mjs', import.meta.url), {
      workerData: { databaseFile: this.databaseFile },
    });
    this.worker = worker;
    this.readyPromise = new Promise((resolve, reject) => {
      const fail = (error) => {
        reject(error);
        for (const task of this.pending.values()) task.reject(error);
        this.pending.clear();
      };
      worker.on('message', (message) => {
        if (message.ready) { resolve(); if (!this.pending.size) worker.unref(); return; }
        const task = this.pending.get(message.id);
        if (!task) return;
        this.pending.delete(message.id);
        if (message.error) task.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        else task.resolve(message.result);
        if (!this.pending.size) worker.unref();
      });
      worker.on('error', fail);
      worker.on('exit', (code) => {
        if (this.worker === worker) this.worker = null;
        fail(new Error(`Database write worker exited with code ${code}`));
      });
    });
    return this.readyPromise;
  }

  async call(operation, payload) {
    await this.start();
    const id = this.nextId++;
    this.worker.ref();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ id, operation, payload }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  async replaceLibrary(library) {
    if (this.replacing) throw new Error('A catalog write is already pending');
    this.replacing = true;
    const startedAt = performance.now();
    try {
      const { series: _series, issues: _issues, ...summary } = library;
      await this.call('begin', summary);
      let batch = [];
      let bytes = 0;
      const flush = async () => {
        if (!batch.length) return;
        this.metrics.peakBatchRows = Math.max(this.metrics.peakBatchRows, batch.length);
        this.metrics.peakBatchBytes = Math.max(this.metrics.peakBatchBytes, bytes);
        await this.call('batch', batch);
        this.metrics.batches += 1;
        batch = [];
        bytes = 0;
        await yieldToEventLoop();
      };
      for (const record of catalogRecords(library)) {
        const recordBytes = Buffer.byteLength(JSON.stringify(record));
        if (recordBytes > 4 * 1024 * 1024) throw new Error('A catalog record exceeds the 4 MiB message limit');
        if (batch.length >= this.batchRows || (batch.length && bytes + recordBytes > this.batchBytes)) await flush();
        batch.push(record);
        bytes += recordBytes;
      }
      await flush();
      const result = await this.call('commit');
      this.metrics.completed += 1;
      this.metrics.lastWrite = { ...result, durationMs: performance.now() - startedAt };
      return result;
    } catch (error) {
      this.metrics.failed += 1;
      // A failed record rolls back in the worker; explicit rollback also covers local serialization errors.
      if (this.worker) await this.call('rollback').catch(() => {});
      throw error;
    } finally {
      this.replacing = false;
    }
  }

  getMetrics() {
    return { ...this.metrics, pending: this.pending.size, active: this.replacing,
      batchRows: this.batchRows, batchBytes: this.batchBytes };
  }

  async close() {
    if (this.closed) return;
    if (this.worker) {
      await this.call('close');
      await this.worker?.terminate();
    }
    this.closed = true;
  }
}
