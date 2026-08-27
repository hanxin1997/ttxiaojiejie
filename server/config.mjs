import path from 'node:path';

import { resolveResourceProfile } from './resource-profile.mjs';

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export function loadConfig() {
  const cwd = process.cwd();
  const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(cwd, 'data'));
  const libraryRoot = path.resolve(process.env.LIBRARY_ROOT ?? path.join(cwd, 'library'));

  const resourceProfile = resolveResourceProfile(process.env.RESOURCE_PROFILE ?? 'auto');

  return {
    cwd,
    port: parseInteger(process.env.PORT, 4321),
    publicDir: path.resolve(process.env.PUBLIC_DIR ?? path.join(cwd, 'public')),
    dataDir,
    stateFile: path.join(dataDir, 'state.json'),
    databaseFile: path.join(dataDir, 'app.sqlite'),
    resourceProfile,
    shutdownTimeoutMs: Math.max(parseInteger(process.env.SHUTDOWN_TIMEOUT_MS, 10_000), 1000),
    imageCache: {
      maxBytes: Math.max(parseInteger(process.env.IMAGE_CACHE_MAX_MB, 512), 32) * 1024 * 1024,
      maxQueue: Math.max(parseInteger(process.env.IMAGE_CACHE_MAX_QUEUE, 128), 1),
      ttlMs: Math.max(parseInteger(process.env.IMAGE_CACHE_TTL_HOURS, 168), 1) * 60 * 60 * 1000,
    },
    webSocket: {
      maxFrameBytes: Math.max(parseInteger(process.env.WS_MAX_FRAME_KB, 1024), 16) * 1024,
      maxBufferedBytes: Math.max(parseInteger(process.env.WS_MAX_BUFFER_KB, 2048), 32) * 1024,
      maxWritableBytes: Math.max(parseInteger(process.env.WS_MAX_WRITABLE_KB, 1024), 16) * 1024,
    },
    rateLimit: {
      windowMs: Math.max(parseInteger(process.env.RATE_LIMIT_WINDOW_MS, 60_000), 1),
      maxRequests: Math.max(parseInteger(process.env.RATE_LIMIT_MAX_REQUESTS, 240), 0),
      pruneIntervalMs: Math.max(parseInteger(process.env.RATE_LIMIT_PRUNE_INTERVAL_MS, 60_000), 1000),
      trustProxy: parseBoolean(process.env.TRUST_PROXY, false),
    },
    metadataScraper: {
      provider: String(process.env.METADATA_SCRAPER_PROVIDER ?? 'anilist').trim() || 'anilist',
      endpoint:
        String(process.env.METADATA_SCRAPER_ENDPOINT ?? 'https://graphql.anilist.co').trim() ||
        'https://graphql.anilist.co',
      itemTimeoutMs: Math.max(parseInteger(process.env.METADATA_ITEM_TIMEOUT_MS, 15_000), 1000),
      jobDeadlineMs: Math.max(parseInteger(process.env.METADATA_JOB_DEADLINE_MS, 10 * 60_000), 1000),
    },
    defaultSettings: {
      libraryRoot,
      scanIntervalMinutes: Math.max(parseInteger(process.env.SCAN_INTERVAL_MINUTES, 15), 0),
      autoExportToMihon: false,
      scanMode: 'flat',
      folderPattern: {
        enabled: false,
        separator: '-',
        authorSegmentIndex: null,
        titleSegmentIndex: 0,
        categorySegmentIndex: null,
        stripTokens: [],
      },
      naming: {
        defaultVolumeName: '默认卷',
        directImageChapterTemplate: '{count}P',
      },
      categoryFolders: [],
    },
  };
}
