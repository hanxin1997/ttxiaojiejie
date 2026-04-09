import path from 'node:path';

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig() {
  const cwd = process.cwd();
  const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(cwd, 'data'));
  const libraryRoot = path.resolve(process.env.LIBRARY_ROOT ?? path.join(cwd, 'library'));

  return {
    cwd,
    port: parseInteger(process.env.PORT, 4321),
    publicDir: path.resolve(process.env.PUBLIC_DIR ?? path.join(cwd, 'public')),
    dataDir,
    stateFile: path.join(dataDir, 'state.json'),
    defaultSettings: {
      libraryRoot,
      scanIntervalMinutes: Math.max(parseInteger(process.env.SCAN_INTERVAL_MINUTES, 15), 0),
      autoExportToMihon: false,
      folderPattern: {
        enabled: true,
        separator: '-',
        titleSegmentIndex: 0,
        categorySegmentIndex: 1,
        stripTokens: ['图片'],
      },
      naming: {
        defaultVolumeName: '默认卷',
        directImageChapterTemplate: '{count}P',
      },
      categoryFolders: [],
    },
  };
}
