import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const collator = new Intl.Collator('zh-Hans-CN-u-kn-true', {
  numeric: true,
  sensitivity: 'base',
});

export const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.avif',
]);

export function naturalCompare(left, right) {
  return collator.compare(left, right);
}

export function stableId(input) {
  return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0, 16);
}

export function normalizeArray(items) {
  const seen = new Set();
  return (items ?? [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

export function toPosixPath(value) {
  return String(value).replaceAll('\\', '/').split(path.sep).join('/');
}

export function normalizeRelativeFolderPath(value) {
  const normalized = toPosixPath(String(value ?? '').trim())
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');

  if (!normalized || normalized === '.') {
    return '';
  }

  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) {
    return '';
  }

  return parts.join('/');
}

export function formatDateTime(value) {
  if (!value) {
    return '未扫描';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未扫描' : date.toLocaleString('zh-CN');
}

export function formatPageTemplate(template, count) {
  return String(template || '{count}P').replaceAll('{count}', String(count));
}

export function sanitizeFileName(value) {
  return String(value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function deepClone(value) {
  return value == null ? value : structuredClone(value);
}

export function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
