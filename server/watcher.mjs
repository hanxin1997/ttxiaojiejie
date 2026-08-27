import fs from 'node:fs';
import path from 'node:path';

export class LibraryWatcher {
  constructor(options) {
    this.libraryRoot = path.resolve(options.libraryRoot);
    this.debounceMs = options.debounceMs ?? 5000;
    this.maxDepth = options.maxDepth ?? 10;
    this.maxWatchers = options.maxWatchers ?? 2048;
    this.degradedScanIntervalMs = Math.max(10, options.degradedScanIntervalMs ?? 5 * 60 * 1000);
    this.onChange = options.onChange;
    this.onEvent = options.onEvent ?? null;
    this.watchers = new Map();
    this.debounceTimer = null;
    this.degradedScanTimer = null;
    this.running = false;
    this.lastEvent = null;
    this.eventCount = 0;
    this.errors = [];
    this.pendingDirtyPaths = new Set();
    this.degraded = false;
    this.generation = 0;
  }

  getStatus() {
    return {
      running: this.running,
      watchedPaths: this.watchers.size,
      lastEvent: this.lastEvent,
      eventCount: this.eventCount,
      errors: this.errors.slice(-5),
      degraded: this.degraded,
    };
  }

  start() {
    if (this.running) {
      return;
    }

    this.running = true;
    const generation = ++this.generation;
    this.errors = [];
    this.eventCount = 0;
    this.pendingDirtyPaths.clear();
    this.degraded = false;

    try {
      this.watchDirectory(this.libraryRoot);
      void this.watchSubdirectories(this.libraryRoot, 0, generation);
    } catch (error) {
      this.errors.push({ time: new Date().toISOString(), message: error.message });
      this.running = false;
    }
  }

  stop() {
    this.running = false;
    this.generation += 1;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.degradedScanTimer) {
      clearInterval(this.degradedScanTimer);
      this.degradedScanTimer = null;
    }

    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // ignore close errors
      }
    }

    this.watchers.clear();
    this.pendingDirtyPaths.clear();
  }

  enterDegradedMode(message) {
    if (!this.degraded) {
      this.degraded = true;
      this.errors.push({ time: new Date().toISOString(), message });
    }
    if (this.degradedScanTimer) return;

    // 根目录监听始终最先创建；超限后停止深层发现，并用低频扫描兜底，
    // 即使用户关闭常规定时扫描也不会永久漏掉深层文件变化。
    this.degradedScanTimer = setInterval(() => {
      if (this.running) this.onChange?.([this.libraryRoot]);
    }, this.degradedScanIntervalMs);
    this.degradedScanTimer.unref?.();
  }

  restart(newLibraryRoot) {
    this.stop();
    if (newLibraryRoot) {
      this.libraryRoot = path.resolve(newLibraryRoot);
    }
    this.start();
  }

  watchDirectory(dirPath) {
    if (!this.running || this.watchers.has(dirPath)) {
      return;
    }

    if (this.watchers.size >= this.maxWatchers) {
      this.enterDegradedMode(
        `Watcher handle limit ${this.maxWatchers} reached; root watch plus periodic scans remain active`,
      );
      return;
    }

    try {
      const watcher = fs.watch(dirPath, { persistent: false }, (eventType, filename) => {
        this.handleEvent(eventType, filename, dirPath);
      });

      watcher.on('error', (error) => {
        this.errors.push({ time: new Date().toISOString(), message: `${dirPath}: ${error.message}` });
        if (['EMFILE', 'ENFILE', 'ENOSPC'].includes(error.code)) {
          this.enterDegradedMode(`Watcher resources exhausted (${error.code}); periodic scans enabled`);
        }
        this.watchers.delete(dirPath);
        try {
          watcher.close();
        } catch {
          // ignore close errors
        }
      });

      this.watchers.set(dirPath, watcher);
    } catch (error) {
      this.errors.push({ time: new Date().toISOString(), message: `Unable to watch ${dirPath}: ${error.message}` });
      if (['EMFILE', 'ENFILE', 'ENOSPC'].includes(error.code)) {
        this.enterDegradedMode(`Watcher resources exhausted (${error.code}); periodic scans enabled`);
      }
    }
  }

  async watchSubdirectories(dirPath, depth = 0, generation = this.generation) {
    if (!this.running || generation !== this.generation || depth >= this.maxDepth || this.degraded) {
      return;
    }

    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!this.running || generation !== this.generation || this.degraded) return;
        if (!entry.isDirectory()) {
          continue;
        }

        const childPath = path.join(dirPath, entry.name);
        this.watchDirectory(childPath);
        await this.watchSubdirectories(childPath, depth + 1, generation);
      }
    } catch {
      // ignore unreadable directories
    }
  }

  handleEvent(eventType, filename, dirPath) {
    this.eventCount += 1;
    this.lastEvent = {
      type: eventType,
      filename: filename || '(unknown)',
      dir: dirPath,
      time: new Date().toISOString(),
    };
    this.onEvent?.(this.lastEvent);
    const dirtyPath = filename ? path.join(dirPath, filename) : dirPath;
    this.pendingDirtyPaths.add(path.resolve(dirtyPath));

    if (filename) {
      const fullPath = path.join(dirPath, filename);
      // 文件系统事件热路径不执行同步 stat，避免大目录变化时阻塞 HTTP 事件循环。
      void fs.promises.stat(fullPath).then((stat) => {
        if (stat.isDirectory() && !this.watchers.has(fullPath)) {
          this.watchDirectory(fullPath);
          void this.watchSubdirectories(fullPath, 0, this.generation);
        }
      }).catch(() => {
        // ignore missing files
      });
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const dirtyPaths = [...this.pendingDirtyPaths];
      this.pendingDirtyPaths.clear();
      this.onChange?.(dirtyPaths);
    }, this.debounceMs);
  }
}
