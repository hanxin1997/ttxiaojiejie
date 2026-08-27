import { scanLibrary } from './scanner.mjs';

export class ScanCoordinator {
  constructor(appStore, runtimeConfig, options = {}) {
    this.store = appStore;
    this.config = runtimeConfig;
    this.ctx = null;
    this.timer = null;
    this.currentTask = null;
    this.scanner = options.scanner ?? scanLibrary;
    this.pendingTriggers = new Set();
    this.pendingDirtyPaths = new Set();
    this.progress = null;
    this.lastBroadcastAt = 0;
    this.status = {
      running: false,
      trigger: null,
      startedAt: null,
      finishedAt: null,
      error: null,
    };
  }

  setContext(ctx) {
    this.ctx = ctx;
  }

  getStatus() {
    return { ...this.status };
  }

  getProgress() {
    return this.progress ? { ...this.progress } : null;
  }

  schedule() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const intervalMinutes = this.store.getSettings().scanIntervalMinutes;
    if (intervalMinutes <= 0) {
      return;
    }

    const MAX_INTERVAL_MS = 2_147_483_647;
    const intervalMs = Math.min(intervalMinutes * 60 * 1000, MAX_INTERVAL_MS);

    this.timer = setInterval(() => {
      void this.run('scheduled').catch((error) => {
        console.warn(`[Scanner] scheduled scan failed: ${error.message}`);
      });
    }, intervalMs);
  }

  async destroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.pendingTriggers.clear();
    this.pendingDirtyPaths.clear();
    if (this.currentTask) await this.currentTask.catch(() => {});
  }

  publishScanUpdate(force = false) {
    if (!this.ctx) {
      return;
    }

    const now = Date.now();
    const intervalMs = this.config.resourceProfile?.scanBroadcastIntervalMs ?? 250;
    if (!force && now - this.lastBroadcastAt < intervalMs) {
      return;
    }

    this.lastBroadcastAt = now;
    this.ctx.notifyScanUpdate();
  }

  async run(trigger, options = {}) {
    if (this.currentTask) {
      this.pendingTriggers.add(trigger);
      for (const dirtyPath of options.dirtyPaths ?? []) {
        this.pendingDirtyPaths.add(dirtyPath);
      }
      return this.currentTask;
    }

    let nextTrigger = trigger;
    let nextDirtyPaths = [...(options.dirtyPaths ?? [])];

    this.currentTask = (async () => {
      try {
        let latestLibrary = null;
        while (nextTrigger) {
          const activeTrigger = nextTrigger;
          const startedAt = new Date().toISOString();
          this.progress = null;
          this.status = {
            running: true,
            trigger: activeTrigger,
            startedAt,
            finishedAt: null,
            error: null,
          };
          this.publishScanUpdate(true);

          const settings = this.store.getSettings();
          const overrides = this.store.getOverrides();
          const previousLibrary = this.store.getLibraryRef?.() ?? this.store.getLibrary();
          latestLibrary = await this.scanner(settings, overrides, {
            previousLibrary,
            dirtyPaths: nextDirtyPaths,
            seriesConcurrency: this.config.resourceProfile?.scanSeriesConcurrency,
            fileStatConcurrency: this.config.resourceProfile?.fileStatConcurrency,
            onProgress: (progress) => {
              this.progress = progress;
              this.publishScanUpdate();
            },
          });

          await this.store.replaceLibrary(latestLibrary);
          this.schedule();
          this.progress = null;
          this.ctx?.notifyLibraryChanged(`scan:${activeTrigger}`);

          if (this.pendingTriggers.size === 0) {
            this.status = {
              running: false,
              trigger: activeTrigger,
              startedAt,
              finishedAt: new Date().toISOString(),
              error: null,
            };
            this.publishScanUpdate(true);
            nextTrigger = null;
          } else {
            nextTrigger = [...this.pendingTriggers].join('+');
            nextDirtyPaths = [...this.pendingDirtyPaths];
            this.pendingTriggers.clear();
            this.pendingDirtyPaths.clear();
          }
        }

        return latestLibrary;
      } catch (error) {
        this.progress = null;
        this.status = {
          running: false,
          trigger: nextTrigger ?? trigger,
          startedAt: this.status.startedAt,
          finishedAt: new Date().toISOString(),
          error: error.message,
        };
        this.publishScanUpdate(true);
        throw error;
      } finally {
        this.currentTask = null;
      }
    })();

    return this.currentTask;
  }
}
