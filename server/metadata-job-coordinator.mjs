import crypto from 'node:crypto';

import { hasMetadataProvider, scrapeSeriesMetadata } from './metadata-scraper.mjs';

export class MetadataJobCoordinator {
  constructor(store, config, options = {}) {
    this.store = store;
    this.config = config;
    this.scrape = options.scrape ?? ((series, context) => {
      return scrapeSeriesMetadata(series, store, {
        ...config.metadataScraper,
        provider: context.provider,
        signal: context.signal,
      });
    });
    this.maxConcurrency = Math.max(1, Number(config.resourceProfile?.metadataConcurrency) || 1);
    this.pendingJobIds = [];
    this.activeJobs = 0;
    this.jobControllers = new Map();
    this.idleWaiters = [];
    this.onUpdate = options.onUpdate ?? null;
  }

  async createJob(options = {}) {
    const provider = String(options.provider ?? this.config.metadataScraper.provider).trim().toLowerCase();
    if (!hasMetadataProvider(provider)) throw new Error(`Unknown metadata provider: ${provider}`);
    const requestedIds = Array.isArray(options.seriesIds) && options.seriesIds.length > 0
      ? new Set(options.seriesIds)
      : null;
    const series = this.store.getLibraryRef().series.filter((item) => !requestedIds || requestedIds.has(item.id));
    const jobId = crypto.randomUUID();
    await this.store.createMetadataJob({
      id: jobId,
      provider,
      apply: options.apply !== false,
      overwrite: Boolean(options.overwrite),
      series,
    });
    this.pendingJobIds.push(jobId);
    this.#pump();
    return { jobId, status: 'queued', total: series.length };
  }

  getJob(jobId, options = {}) {
    return this.store.getMetadataJob(jobId, options);
  }

  async cancelJob(jobId) {
    const cancelled = await this.store.requestMetadataJobCancel(jobId);
    if (cancelled) this.jobControllers.get(jobId)?.abort(new Error('Metadata job cancelled'));
    return cancelled;
  }

  waitForIdle() {
    if (this.pendingJobIds.length === 0 && this.activeJobs === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  getMetrics() {
    return {
      active: this.activeJobs,
      queued: this.pendingJobIds.length,
      concurrency: this.maxConcurrency,
    };
  }

  async destroy() {
    const queued = this.pendingJobIds.splice(0);
    for (const jobId of queued) await this.store.requestMetadataJobCancel(jobId);
    for (const controller of this.jobControllers.values()) {
      controller.abort(new Error('Server is shutting down'));
    }
    await this.waitForIdle();
  }

  #pump() {
    while (this.activeJobs < this.maxConcurrency && this.pendingJobIds.length > 0) {
      const jobId = this.pendingJobIds.shift();
      this.activeJobs += 1;
      void this.#runJob(jobId)
        .catch((error) => {
          console.warn(`[Metadata] job ${jobId} failed: ${error.message}`);
        })
        .finally(() => {
          this.activeJobs -= 1;
          this.#pump();
          if (this.pendingJobIds.length === 0 && this.activeJobs === 0) {
            for (const resolve of this.idleWaiters.splice(0)) resolve();
          }
        });
    }
  }

  async #runJob(jobId) {
    const controller = new AbortController();
    const deadlineMs = Math.max(Number(this.config.metadataScraper?.jobDeadlineMs) || 10 * 60_000, 1);
    const deadline = setTimeout(() => {
      controller.abort(new Error(`Metadata job deadline exceeded after ${deadlineMs}ms`));
    }, deadlineMs);
    deadline.unref?.();
    this.jobControllers.set(jobId, controller);
    await this.store.markMetadataJobRunning(jobId);
    this.#notify(jobId);

    try {
      const job = this.store.getMetadataJob(jobId);
      const items = this.store.getMetadataJobItems(jobId);
      for (const item of items) {
        if (this.store.isMetadataJobCancelRequested(jobId) || controller.signal.aborted) break;
        await this.store.markMetadataJobItemRunning(jobId, item.position);
        const series = this.store.getSeriesById(item.seriesId);
        if (!series) {
          await this.store.finishMetadataJobItem(jobId, item.position, {
            ok: false,
            error: 'Series no longer exists',
          });
          this.#notify(jobId);
          continue;
        }

        try {
          const scraped = await this.scrape(series, {
            provider: job.provider,
            signal: controller.signal,
          });
          if (controller.signal.aborted) throw new Error('Metadata job cancelled');
          if (!scraped) throw new Error('No metadata match');

          if (job.apply) {
            const currentMetadata = this.store.getMetadata(series.sourceKey) ?? {};
            const metadata = {
              title: job.overwrite || !currentMetadata.title
                ? scraped.title ?? currentMetadata.title
                : currentMetadata.title,
              author: job.overwrite || !currentMetadata.author
                ? scraped.author ?? currentMetadata.author
                : currentMetadata.author,
              description: job.overwrite || !currentMetadata.description
                ? scraped.description ?? currentMetadata.description
                : currentMetadata.description,
            };
            const currentTags = this.store.getTags(series.sourceKey);
            const tags = job.overwrite
              ? scraped.tags ?? []
              : [...new Set([...currentTags, ...(scraped.tags ?? [])])];
            await this.store.setMetadataAndTags(series.sourceKey, metadata, tags);
          }

          await this.store.finishMetadataJobItem(jobId, item.position, {
            ok: true,
            result: { seriesId: series.id, title: series.title, applied: job.apply, scraped },
          });
        } catch (error) {
          await this.store.finishMetadataJobItem(jobId, item.position, {
            ok: false,
            error: error.message,
          });
        }
        this.#notify(jobId);
      }

      const cancelled = this.store.isMetadataJobCancelRequested(jobId) || controller.signal.aborted;
      await this.store.finishMetadataJob(jobId, cancelled ? 'cancelled' : 'completed');
      this.#notify(jobId);
    } catch (error) {
      await this.store.finishMetadataJob(jobId, 'failed');
      this.#notify(jobId);
      throw error;
    } finally {
      clearTimeout(deadline);
      this.jobControllers.delete(jobId);
    }
  }

  #notify(jobId) {
    this.onUpdate?.(this.store.getMetadataJob(jobId));
  }
}
