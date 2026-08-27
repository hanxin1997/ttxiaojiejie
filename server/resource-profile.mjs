import os from 'node:os';

const PROFILE_DEFINITIONS = Object.freeze({
  lite: Object.freeze({
    name: 'lite',
    scanSeriesConcurrency: 1,
    fileStatConcurrency: 16,
    thumbnailConcurrency: 1,
    metadataConcurrency: 1,
    databaseQueueLimit: 32,
    watcherLimit: 256,
    scanBroadcastIntervalMs: 1000,
  }),
  balanced: Object.freeze({
    name: 'balanced',
    scanSeriesConcurrency: 2,
    fileStatConcurrency: 64,
    thumbnailConcurrency: 2,
    metadataConcurrency: 1,
    databaseQueueLimit: 64,
    watcherLimit: 2048,
    scanBroadcastIntervalMs: 500,
  }),
  full: Object.freeze({
    name: 'full',
    scanSeriesConcurrency: 8,
    fileStatConcurrency: 128,
    thumbnailConcurrency: 4,
    metadataConcurrency: 2,
    databaseQueueLimit: 128,
    watcherLimit: 8192,
    scanBroadcastIntervalMs: 250,
  }),
});

export function resolveResourceProfile(requested = 'auto', system = {}) {
  const normalized = String(requested ?? 'auto').trim().toLowerCase() || 'auto';
  if (normalized !== 'auto' && !PROFILE_DEFINITIONS[normalized]) {
    throw new Error(`RESOURCE_PROFILE must be one of auto, lite, balanced, or full; received: ${requested}`);
  }

  if (normalized !== 'auto') {
    return { ...PROFILE_DEFINITIONS[normalized], requested: normalized };
  }

  const cpuCount = Math.max(1, Number(system.cpuCount ?? os.availableParallelism?.() ?? os.cpus().length) || 1);
  const memoryBytes = Math.max(0, Number(system.memoryBytes ?? os.totalmem()) || 0);
  let selected = 'full';
  if (cpuCount <= 2 || memoryBytes <= 2 * 1024 ** 3) {
    selected = 'lite';
  } else if (cpuCount <= 4 || memoryBytes <= 6 * 1024 ** 3) {
    selected = 'balanced';
  }

  return {
    ...PROFILE_DEFINITIONS[selected],
    requested: 'auto',
    detectedCpuCount: cpuCount,
    detectedMemoryBytes: memoryBytes,
  };
}

export { PROFILE_DEFINITIONS };
