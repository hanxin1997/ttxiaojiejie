import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';

import { IMAGE_EXTENSIONS, naturalCompare } from './utils.mjs';
import { ArchiveIndexCache } from './archive-index-cache.mjs';

const openFile = promisify(fs.open);
const closeFile = promisify(fs.close);
const statFile = promisify(fs.fstat);

export const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  maxEntries: 20_000,
  maxIndexBytes: 8 * 1024 * 1024,
  maxPageBytes: 64 * 1024 * 1024,
});

export class ArchiveError extends Error {
  constructor(code, message, statusCode = 422, options = {}) {
    super(message, options);
    this.name = 'ArchiveError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

let yauzlPromise;
let defaultIndexCache = new ArchiveIndexCache();

export function getArchiveIndexStats() { return defaultIndexCache.getStats(); }
export function clearArchiveIndexCache() { defaultIndexCache.clear(); }
export async function closeArchiveIndexCache() { await defaultIndexCache.close(); }
export async function configureArchiveIndexCache(options) {
  const { active, queued } = defaultIndexCache.getStats();
  if (active || queued) throw new ArchiveError('ARCHIVE_BUSY', 'CBZ 索引读取期间无法更改缓存配置', 503);
  await defaultIndexCache.close();
  defaultIndexCache = new ArchiveIndexCache(options);
}

async function loadYauzl() {
  // 普通图片部署仍可启动；只有真正读取归档时才需要 ZIP 依赖。
  if (!yauzlPromise) {
    yauzlPromise = import('yauzl').then((module) => module.default ?? module).catch((error) => {
      yauzlPromise = null;
      throw new ArchiveError(
        'ARCHIVE_DEPENDENCY_MISSING',
        'CBZ 读取依赖 yauzl 不可用，请使用包含该依赖的服务镜像',
        503,
        { cause: error },
      );
    });
  }
  return yauzlPromise;
}

function limitsFor(options = {}) {
  const supplied = options.limits ?? options;
  return Object.fromEntries(Object.entries(DEFAULT_ARCHIVE_LIMITS).map(([name, fallback]) => {
    const value = Number(supplied[name]);
    return [name, Number.isSafeInteger(value) && value > 0 ? value : fallback];
  }));
}

function abortIfNeeded(signal) {
  if (signal?.aborted) {
    throw new ArchiveError('ARCHIVE_ABORTED', 'CBZ 读取已取消', 503, { cause: signal.reason });
  }
}

function wrapArchiveError(error) {
  if (error instanceof ArchiveError) return error;
  if (String(error?.code ?? '').startsWith('ARCHIVE_')) {
    return new ArchiveError(error.code, error.message, error.statusCode ?? 422, { cause: error });
  }
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return new ArchiveError('ARCHIVE_ABORTED', 'CBZ 读取已取消', 503, { cause: error });
  }
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
    return new ArchiveError('ARCHIVE_NOT_FOUND', 'CBZ 源文件不存在，请重新扫描图库', 404, { cause: error });
  }
  return new ArchiveError('ARCHIVE_INVALID', `无法读取 CBZ：${error?.message ?? error}`, 422, { cause: error });
}

function identityFromStats(stats) {
  if (!stats.isFile()) throw new ArchiveError('ARCHIVE_INVALID', 'CBZ 来源不是普通文件');
  if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
    throw new ArchiveError('ARCHIVE_LIMIT', 'CBZ 大小超过可安全读取的范围');
  }
  return { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}

export async function readArchiveIdentity(sourcePath) {
  try {
    return identityFromStats(await fsp.stat(sourcePath));
  } catch (error) {
    throw wrapArchiveError(error);
  }
}

function sameIdentity(left, right) {
  return left?.size === right?.size && left?.mtimeMs === right?.mtimeMs && left?.ctimeMs === right?.ctimeMs;
}

function assertIdentity(expected, actual) {
  if (!sameIdentity(expected, actual)) {
    throw new ArchiveError('ARCHIVE_STALE', 'CBZ 文件已变化，请重新扫描图库后阅读', 409);
  }
}

function validateName(name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\') ||
      name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').includes('..')) {
    throw new ArchiveError('ARCHIVE_INVALID', 'CBZ 包含不安全的条目路径');
  }
}

function validateDescriptor(entry, limits) {
  if (!entry || entry.version !== 1 || !Number.isSafeInteger(entry.index) || entry.index < 0 ||
      !Number.isInteger(entry.crc32) || entry.crc32 < 0 || entry.crc32 > 0xffffffff ||
      !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0 ||
      !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
      ![0, 8].includes(entry.compressionMethod) || !entry.archiveIdentity ||
      !Number.isSafeInteger(entry.archiveIdentity.size) || entry.archiveIdentity.size < 0 ||
      !Number.isFinite(entry.archiveIdentity.mtimeMs) || !Number.isFinite(entry.archiveIdentity.ctimeMs)) {
    throw new ArchiveError('ARCHIVE_INVALID', 'CBZ 页面索引无效，请重新扫描图库');
  }
  validateName(entry.name);
  if (!IMAGE_EXTENSIONS.has(path.posix.extname(entry.name).toLowerCase())) {
    throw new ArchiveError('ARCHIVE_INVALID', 'CBZ 页面不是受支持的图片');
  }
  if (entry.uncompressedSize > limits.maxPageBytes || entry.index >= limits.maxEntries) {
    throw new ArchiveError('ARCHIVE_LIMIT', 'CBZ 页面超过资源上限');
  }
}

export async function validateArchiveSource(sourcePath, archiveEntry, options = {}) {
  abortIfNeeded(options.signal);
  validateDescriptor(archiveEntry, limitsFor(options));
  const identity = await readArchiveIdentity(sourcePath);
  assertIdentity(archiveEntry.archiveIdentity, identity);
  return identity;
}

async function openArchive(sourcePath, expectedIdentity, options) {
  abortIfNeeded(options.signal);
  const yauzl = await loadYauzl();
  let fd;
  try {
    fd = await openFile(sourcePath, 'r');
    const identity = identityFromStats(await statFile(fd));
    if (expectedIdentity) assertIdentity(expectedIdentity, identity);
    abortIfNeeded(options.signal);
    const zip = await new Promise((resolve, reject) => {
      yauzl.fromFd(fd, {
        lazyEntries: true,
        autoClose: false,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: false,
      }, (error, archive) => error ? reject(error) : resolve(archive));
    });
    const record = { zip, fd, identity, error: null, closed: false };
    // 错误也可能在两个操作之间到达，始终保留一个监听器避免未处理事件。
    zip.on('error', (error) => { record.error = error; });
    record.closedPromise = new Promise((resolve) => zip.once('close', () => {
      record.closed = true;
      resolve();
    }));
    return record;
  } catch (error) {
    if (fd !== undefined) await closeFile(fd).catch(() => {});
    throw wrapArchiveError(error);
  }
}

async function closeArchive(record) {
  if (!record || record.closed) return;
  record.zip.close();
  await record.closedPromise;
}

async function assertArchiveUnchanged(record, sourcePath) {
  assertIdentity(record.identity, identityFromStats(await statFile(record.fd)));
  // 同时复核路径，防止打开的旧 inode 未变而路径已被替换。
  assertIdentity(record.identity, await readArchiveIdentity(sourcePath));
}

function isImageEntry(entry) {
  const segments = entry.fileName.split('/');
  return !entry.fileName.endsWith('/') &&
    !segments.some((segment) => segment === '__MACOSX' || segment.startsWith('._')) &&
    IMAGE_EXTENSIONS.has(path.posix.extname(entry.fileName).toLowerCase());
}

function validateEntry(entry, limits) {
  validateName(entry.fileName);
  const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
  if (unixType === 0xa000) throw new ArchiveError('ARCHIVE_INVALID', 'CBZ 不支持符号链接条目');
  if (!isImageEntry(entry)) return false;
  if ((entry.generalPurposeBitFlag & 0x41) !== 0) {
    throw new ArchiveError('ARCHIVE_INVALID', 'CBZ 不支持加密图片');
  }
  if (![0, 8].includes(entry.compressionMethod)) {
    throw new ArchiveError('ARCHIVE_INVALID', `CBZ 不支持压缩方式 ${entry.compressionMethod}`);
  }
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
      !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0 ||
      entry.uncompressedSize > limits.maxPageBytes) {
    throw new ArchiveError('ARCHIVE_LIMIT', 'CBZ 单页展开大小超过上限');
  }
  return true;
}

function enumerateEntries(record, limits, signal, onEntry) {
  return new Promise((resolve, reject) => {
    let count = 0;
    let indexBytes = 0;
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      record.zip.off('entry', handleEntry);
      record.zip.off('end', handleEnd);
      record.zip.off('error', handleError);
      signal?.removeEventListener('abort', handleAbort);
      if (error) reject(wrapArchiveError(error));
      else resolve(result);
    };
    const handleError = (error) => finish(error);
    const handleAbort = () => finish(new ArchiveError('ARCHIVE_ABORTED', 'CBZ 读取已取消', 503));
    const handleEnd = () => finish(null, null);
    const handleEntry = (entry) => {
      try {
        abortIfNeeded(signal);
        const index = count++;
        // 限制条目元数据总量，避免只限制页数却被大量非图片拖垮。
        indexBytes += 256 + Buffer.byteLength(entry.fileName) +
          (entry.extraFieldLength ?? 0) + (entry.fileCommentLength ?? 0);
        if (count > limits.maxEntries || indexBytes > limits.maxIndexBytes) {
          throw new ArchiveError('ARCHIVE_LIMIT', 'CBZ 目录索引超过资源上限');
        }
        const image = validateEntry(entry, limits);
        const result = onEntry(entry, index, image);
        if (result !== undefined) finish(null, result);
        else record.zip.readEntry();
      } catch (error) {
        finish(error);
      }
    };
    record.zip.on('entry', handleEntry);
    record.zip.once('end', handleEnd);
    record.zip.on('error', handleError);
    signal?.addEventListener('abort', handleAbort, { once: true });
    if (signal?.aborted) handleAbort();
    else if (record.error) handleError(record.error);
    else if (record.zip.entryCount > limits.maxEntries) {
      finish(new ArchiveError('ARCHIVE_LIMIT', 'CBZ 条目数量超过上限'));
    } else record.zip.readEntry();
  });
}

async function readArchiveIndex(resolvedPath, identity, limits, signal) {
  let record;
  try {
    record = await openArchive(resolvedPath, identity, { signal });
    const pages = [];
    const entries = new Map();
    let retainedBytes = 512;
    await enumerateEntries(record, limits, signal, (entry, index, image) => {
      if (!image) return;
      // Preserve the Entry prototype (isEncrypted/isCompressed) and fields used
      // by yauzl's random reader. Comments/extra-field buffers were validated
      // during enumeration and need not stay resident for every opened comic.
      const locator = Object.assign(Object.create(Object.getPrototypeOf(entry)), {
        fileName: entry.fileName,
        generalPurposeBitFlag: entry.generalPurposeBitFlag,
        compressionMethod: entry.compressionMethod,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        relativeOffsetOfLocalHeader: entry.relativeOffsetOfLocalHeader,
        crc32: entry.crc32,
      });
      entries.set(index, locator);
      // This is a conservative metadata accounting budget, not V8 heap bytes.
      retainedBytes += 512 + Buffer.byteLength(entry.fileName) * 4;
      pages.push({
        relativePath: entry.fileName,
        sizeBytes: entry.uncompressedSize,
        mtimeMs: record.identity.mtimeMs,
        sourcePath: resolvedPath,
        archiveEntry: {
          version: 1,
          index,
          name: entry.fileName,
          crc32: entry.crc32,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
          compressionMethod: entry.compressionMethod,
          archiveIdentity: record.identity,
        },
      });
    });
    await assertArchiveUnchanged(record, resolvedPath);
    if (pages.length === 0) throw new ArchiveError('ARCHIVE_EMPTY', 'CBZ 内没有可读取的图片');
    pages.sort((left, right) =>
      naturalCompare(left.relativePath, right.relativePath) || left.archiveEntry.index - right.archiveEntry.index);
    return { pages, entries, retainedBytes };
  } catch (error) {
    throw wrapArchiveError(error);
  } finally {
    await closeArchive(record);
  }
}

async function getArchiveIndex(sourcePath, identity, options) {
  const resolvedPath = path.resolve(sourcePath);
  const limits = limitsFor(options);
  const key = JSON.stringify([resolvedPath, identity, limits]);
  const cache = options.indexCache ?? defaultIndexCache;
  return cache.get(key, (signal) => readArchiveIndex(resolvedPath, identity, limits, signal), options.signal);
}

export async function listArchivePages(sourcePath, options = {}) {
  try {
    abortIfNeeded(options.signal);
    const identity = await readArchiveIdentity(sourcePath);
    const index = await getArchiveIndex(sourcePath, identity, options);
    assertIdentity(identity, await readArchiveIdentity(sourcePath));
    // Callers assign page numbers; keep the shared cached metadata immutable.
    return index.pages.map((page) => ({
      ...page, archiveEntry: { ...page.archiveEntry, archiveIdentity: { ...page.archiveEntry.archiveIdentity } },
    }));
  } catch (error) {
    throw wrapArchiveError(error);
  }
}

export async function extractArchivePage(sourcePath, archiveEntry, targetPath, options = {}) {
  const limits = limitsFor(options);
  let record;
  let output;
  let created = false;
  try {
    validateDescriptor(archiveEntry, limits);
    await validateArchiveSource(sourcePath, archiveEntry, options);
    const index = await getArchiveIndex(sourcePath, archiveEntry.archiveIdentity, options);
    record = await openArchive(sourcePath, archiveEntry.archiveIdentity, options);
    const entry = index.entries.get(archiveEntry.index);
    if (!entry) throw new ArchiveError('ARCHIVE_STALE', 'CBZ 页面索引不存在，请重新扫描图库', 409);
    if (entry.fileName !== archiveEntry.name || entry.crc32 !== archiveEntry.crc32 ||
        entry.compressedSize !== archiveEntry.compressedSize ||
        entry.uncompressedSize !== archiveEntry.uncompressedSize ||
        entry.compressionMethod !== archiveEntry.compressionMethod) {
      throw new ArchiveError('ARCHIVE_STALE', 'CBZ 页面索引不再匹配，请重新扫描图库', 409);
    }
    abortIfNeeded(options.signal);
    // 先准备输出再打开输入流，避免等待磁盘打开时输入流提前报错而无人监听。
    output = await fsp.open(targetPath, 'wx');
    created = true;
    const input = await new Promise((resolve, reject) => {
      record.zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream));
    });
    let bytes = 0;
    let checksum = 0;
    const verify = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > limits.maxPageBytes || bytes > entry.uncompressedSize) {
          callback(new ArchiveError('ARCHIVE_LIMIT', 'CBZ 页面实际展开大小超过上限'));
          return;
        }
        checksum = crc32(chunk, checksum);
        callback(null, chunk);
      },
      flush(callback) {
        callback(bytes !== entry.uncompressedSize || checksum !== entry.crc32
          ? new ArchiveError('ARCHIVE_INVALID', 'CBZ 页面大小或 CRC32 校验失败')
          : null);
      },
    });
    // fd 由本函数统一关闭；不用 FileHandle 流的额外引用计数阻塞 close。
    const destination = fs.createWriteStream(targetPath, { fd: output.fd, autoClose: false });
    await pipeline(input, verify, destination, { signal: options.signal });
    await output.close();
    output = null;
    await assertArchiveUnchanged(record, sourcePath);
    abortIfNeeded(options.signal);
    return { sizeBytes: bytes };
  } catch (error) {
    if (output) await output.close().catch(() => {});
    if (created) await fsp.unlink(targetPath).catch(() => {});
    throw wrapArchiveError(error);
  } finally {
    await closeArchive(record);
  }
}
