import fs from 'node:fs/promises';

import {
  deepClone,
  ensureDir,
  naturalCompare,
  normalizeArray,
  normalizeRelativeFolderPath,
  pathExists,
  safeJsonParse,
} from './utils.mjs';

function normalizeFolderPattern(folderPattern, defaults) {
  const source = folderPattern ?? {};
  return {
    enabled: source.enabled ?? defaults.enabled,
    separator: String(source.separator ?? defaults.separator ?? '-'),
    titleSegmentIndex: Number.isInteger(source.titleSegmentIndex)
      ? source.titleSegmentIndex
      : defaults.titleSegmentIndex,
    categorySegmentIndex: Number.isInteger(source.categorySegmentIndex)
      ? source.categorySegmentIndex
      : defaults.categorySegmentIndex,
    stripTokens: normalizeArray(source.stripTokens ?? defaults.stripTokens),
  };
}

function normalizeNaming(naming, defaults) {
  const source = naming ?? {};
  return {
    defaultVolumeName:
      String(source.defaultVolumeName ?? defaults.defaultVolumeName).trim() ||
      defaults.defaultVolumeName,
    directImageChapterTemplate:
      String(source.directImageChapterTemplate ?? defaults.directImageChapterTemplate).trim() ||
      defaults.directImageChapterTemplate,
  };
}

function normalizeCategoryFolders(categoryFolders) {
  const merged = new Map();

  for (const item of categoryFolders ?? []) {
    const name = String(item?.name ?? '').trim();
    const folder = normalizeCategoryFolderPath(item?.folder ?? '');

    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      if (!existing.folder && folder) {
        existing.folder = folder;
      }
      continue;
    }

    merged.set(key, { name, folder });
  }

  return [...merged.values()].sort((left, right) => naturalCompare(left.name, right.name));
}

function normalizeAbsoluteFolderPath(value) {
  const raw = String(value ?? '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/+/g, '/');

  if (!raw || !raw.startsWith('/')) {
    return '';
  }

  const normalized = raw === '/' ? '/' : raw.replace(/\/+$/, '');
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) {
    return '';
  }

  return parts.length === 0 ? '/' : `/${parts.join('/')}`;
}

function normalizeCategoryFolderPath(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }

  if (/^[A-Za-z]:[\\/]/.test(raw) || /^\\\\/.test(raw)) {
    return '';
  }

  if (raw.startsWith('/')) {
    return normalizeAbsoluteFolderPath(raw);
  }

  return normalizeRelativeFolderPath(raw);
}

function getPathFlavor(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return 'empty';
  }

  if (/^[A-Za-z]:[\\/]/.test(normalized) || /^\\\\/.test(normalized)) {
    return 'windows';
  }

  if (normalized.startsWith('/')) {
    return 'posix';
  }

  return 'relative';
}

function normalizeSettings(settings, defaults) {
  const source = settings ?? {};
  const interval = Number.parseInt(String(source.scanIntervalMinutes ?? defaults.scanIntervalMinutes), 10);

  return {
    libraryRoot: String(source.libraryRoot ?? defaults.libraryRoot).trim() || defaults.libraryRoot,
    scanIntervalMinutes: Number.isFinite(interval) ? Math.max(interval, 0) : defaults.scanIntervalMinutes,
    autoExportToMihon: false,
    folderPattern: normalizeFolderPattern(source.folderPattern, defaults.folderPattern),
    naming: normalizeNaming(source.naming, defaults.naming),
    categoryFolders: normalizeCategoryFolders(source.categoryFolders ?? defaults.categoryFolders),
  };
}

function createEmptyLibrary() {
  return {
    lastScanAt: null,
    scanRoot: null,
    stats: {
      seriesCount: 0,
      volumeCount: 0,
      chapterCount: 0,
      pageCount: 0,
      categories: [],
    },
    series: [],
    issues: [],
    exportInfo: null,
  };
}

function normalizeOverrides(rawOverrides) {
  const seriesCategories = {};
  const input = rawOverrides?.seriesCategories ?? {};

  for (const [key, value] of Object.entries(input)) {
    const categories = normalizeArray(value);
    if (categories.length > 0) {
      seriesCategories[key] = categories;
    }
  }

  return { seriesCategories };
}

function normalizeState(rawState, defaults) {
  return {
    settings: normalizeSettings(rawState?.settings, defaults),
    library: rawState?.library ?? createEmptyLibrary(),
    overrides: normalizeOverrides(rawState?.overrides),
  };
}

async function migrateLibraryRoot(settings, defaults) {
  const configuredRoot = String(settings.libraryRoot ?? '').trim();
  const defaultRoot = String(defaults.libraryRoot ?? '').trim();

  if (!configuredRoot || !defaultRoot || configuredRoot === defaultRoot) {
    return { settings, changed: false };
  }

  const configuredFlavor = getPathFlavor(configuredRoot);
  const defaultFlavor = getPathFlavor(defaultRoot);

  if (
    configuredFlavor === 'relative' ||
    configuredFlavor === 'empty' ||
    defaultFlavor === 'relative' ||
    defaultFlavor === 'empty' ||
    configuredFlavor === defaultFlavor
  ) {
    return { settings, changed: false };
  }

  if (await pathExists(configuredRoot)) {
    return { settings, changed: false };
  }

  if (!(await pathExists(defaultRoot))) {
    return { settings, changed: false };
  }

  return {
    settings: {
      ...settings,
      libraryRoot: defaultRoot,
    },
    changed: true,
  };
}

function mergeSettings(currentSettings, nextSettings) {
  return {
    ...currentSettings,
    ...nextSettings,
    folderPattern: {
      ...currentSettings.folderPattern,
      ...(nextSettings?.folderPattern ?? {}),
    },
    naming: {
      ...currentSettings.naming,
      ...(nextSettings?.naming ?? {}),
    },
    categoryFolders: nextSettings?.categoryFolders ?? currentSettings.categoryFolders,
  };
}

export class AppStore {
  constructor(config) {
    this.config = config;
    this.state = normalizeState(null, config.defaultSettings);
    this.writePromise = Promise.resolve();
  }

  async init() {
    await ensureDir(this.config.dataDir);

    if (await pathExists(this.config.stateFile)) {
      const raw = await fs.readFile(this.config.stateFile, 'utf8');
      const parsedState = safeJsonParse(raw, null);
      const nextState = normalizeState(parsedState, this.config.defaultSettings);
      const migration = await migrateLibraryRoot(nextState.settings, this.config.defaultSettings);
      const disabledLegacyAutoExport = parsedState?.settings?.autoExportToMihon !== undefined;
      this.state = {
        ...nextState,
        settings: migration.settings,
      };

      if (migration.changed || disabledLegacyAutoExport) {
        await this.persist();
      }

      return;
    }

    await this.persist();
  }

  getSettings() {
    return deepClone(this.state.settings);
  }

  getLibrary() {
    return deepClone(this.state.library);
  }

  getOverrides() {
    return deepClone(this.state.overrides);
  }

  getSeriesById(seriesId) {
    return this.state.library.series.find((series) => series.id === seriesId) ?? null;
  }

  async replaceSettings(nextSettings) {
    const merged = mergeSettings(this.state.settings, nextSettings);
    this.state.settings = normalizeSettings(merged, this.config.defaultSettings);
    await this.persist();
    return this.getSettings();
  }

  async replaceCategoryFolders(categoryFolders) {
    return this.replaceSettings({ categoryFolders });
  }

  async replaceLibrary(nextLibrary) {
    this.state.library = deepClone(nextLibrary);
    await this.persist();
    return this.getLibrary();
  }

  async setSeriesCategories(sourceKey, categories) {
    const normalized = normalizeArray(categories);

    if (normalized.length === 0) {
      delete this.state.overrides.seriesCategories[sourceKey];
    } else {
      this.state.overrides.seriesCategories[sourceKey] = normalized;
    }

    await this.persist();
    return this.getOverrides();
  }

  persist() {
    this.writePromise = this.writePromise.then(async () => {
      await fs.writeFile(this.config.stateFile, JSON.stringify(this.state, null, 2), 'utf8');
    });

    return this.writePromise;
  }
}
