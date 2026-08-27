import fs from 'node:fs/promises';

import { naturalCompare } from './utils.mjs';

function decodeMountInfoPath(value) {
  return String(value ?? '').replace(/\\([0-7]{3})/g, (_, octal) => {
    return String.fromCharCode(Number.parseInt(octal, 8));
  });
}

function parseMountInfoLine(line) {
  const separatorIndex = line.indexOf(' - ');
  if (separatorIndex === -1) {
    return null;
  }

  const left = line.slice(0, separatorIndex).trim().split(/\s+/);
  const right = line.slice(separatorIndex + 3).trim().split(/\s+/);

  if (left.length < 5 || right.length < 3) {
    return null;
  }

  return {
    mountId: left[0],
    parentId: left[1],
    majorMinor: left[2],
    root: decodeMountInfoPath(left[3]),
    mountPoint: decodeMountInfoPath(left[4]),
    fileSystemType: right[0],
    source: decodeMountInfoPath(right[1]),
  };
}

export function parseMountInfo(raw) {
  const entries = [];

  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const entry = parseMountInfoLine(trimmed);
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}

export async function listMountRoots(options = {}) {
  const mountInfoPath = options.mountInfoPath ?? '/proc/self/mountinfo';
  const readFile = options.readFile ?? fs.readFile;

  let raw;
  try {
    raw = await readFile(mountInfoPath, 'utf8');
  } catch {
    return [];
  }

  const seen = new Set();
  return parseMountInfo(raw)
    .map((entry) => entry.mountPoint)
    .filter((mountPoint) => mountPoint.startsWith('/'))
    .filter((mountPoint) => {
      if (seen.has(mountPoint)) {
        return false;
      }
      seen.add(mountPoint);
      return true;
    })
    .sort(naturalCompare);
}
