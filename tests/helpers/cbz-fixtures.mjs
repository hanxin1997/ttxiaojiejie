import fs from 'node:fs/promises';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Build a small real ZIP without installing a ZIP writer in the test environment.
 * Entry order is preserved so archive readers can be tested independently of sorting.
 */
export function createCbzBuffer(entries, options = {}) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content ?? '', 'utf8');
    const entryComment = Buffer.isBuffer(entry.comment)
      ? entry.comment
      : Buffer.from(entry.comment ?? '', 'utf8');
    const requestedMethod = entry.method ?? options.method ?? 8;
    const method = requestedMethod === 'store' ? 0 : requestedMethod === 'deflate' ? 8 : requestedMethod;
    if (!Number.isInteger(method) || method < 0 || method > 0xffff) {
      throw new Error(`Invalid fixture compression method: ${method}`);
    }
    // Unknown methods deliberately carry raw bytes, allowing rejection tests
    // without implementing those compression formats in this fixture writer.
    const compressed = method === 8 ? deflateRawSync(content) : content;
    const checksum = entry.crc32Override ?? crc32(content);
    const uncompressedSize = entry.uncompressedSizeOverride ?? content.length;
    const flags = entry.flags ?? 0x0800;
    const zip64 = Boolean(options.zip64);
    const localExtra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (zip64) {
      localExtra.writeUInt16LE(0x0001, 0);
      localExtra.writeUInt16LE(16, 2);
      localExtra.writeBigUInt64LE(BigInt(uncompressedSize), 4);
      localExtra.writeBigUInt64LE(BigInt(compressed.length), 12);
    }
    // Fixed DOS date/time and UTF-8 flag keep the generated archive reproducible.
    const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(zip64 ? 45 : 20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(zip64 ? 0xffffffff : compressed.length, 18);
    localHeader.writeUInt32LE(zip64 ? 0xffffffff : uncompressedSize, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(localExtra.length, 28);
    localRecords.push(localHeader, name, localExtra, compressed);

    const centralExtra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) {
      centralExtra.writeUInt16LE(0x0001, 0);
      centralExtra.writeUInt16LE(24, 2);
      centralExtra.writeBigUInt64LE(BigInt(uncompressedSize), 4);
      centralExtra.writeBigUInt64LE(BigInt(compressed.length), 12);
      centralExtra.writeBigUInt64LE(BigInt(localOffset), 20);
    }

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(entry.externalFileAttributes == null ? 20 : 0x031e, 4);
    centralHeader.writeUInt16LE(zip64 ? 45 : 20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(zip64 ? 0xffffffff : compressed.length, 20);
    centralHeader.writeUInt32LE(zip64 ? 0xffffffff : uncompressedSize, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(centralExtra.length, 30);
    centralHeader.writeUInt16LE(entryComment.length, 32);
    centralHeader.writeUInt32LE((entry.externalFileAttributes ?? 0) >>> 0, 38);
    centralHeader.writeUInt32LE(zip64 ? 0xffffffff : localOffset, 42);
    // Per-entry comments belong only to the central directory; its concatenated
    // length feeds both the ordinary and ZIP64 end-of-directory records below.
    centralRecords.push(centralHeader, name, centralExtra, entryComment);
    localOffset += localHeader.length + name.length + localExtra.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const comment = Buffer.from(options.comment ?? '', 'utf8');
  const zip64Records = [];
  if (options.zip64) {
    const zip64End = Buffer.alloc(56);
    zip64End.writeUInt32LE(0x06064b50, 0);
    zip64End.writeBigUInt64LE(44n, 4);
    zip64End.writeUInt16LE(45, 12);
    zip64End.writeUInt16LE(45, 14);
    zip64End.writeBigUInt64LE(BigInt(entries.length), 24);
    zip64End.writeBigUInt64LE(BigInt(entries.length), 32);
    zip64End.writeBigUInt64LE(BigInt(centralDirectory.length), 40);
    zip64End.writeBigUInt64LE(BigInt(localOffset), 48);
    const zip64Locator = Buffer.alloc(20);
    zip64Locator.writeUInt32LE(0x07064b50, 0);
    zip64Locator.writeBigUInt64LE(BigInt(localOffset + centralDirectory.length), 8);
    zip64Locator.writeUInt32LE(1, 16);
    zip64Records.push(zip64End, zip64Locator);
  }
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 8);
  endRecord.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 10);
  endRecord.writeUInt32LE(options.zip64 ? 0xffffffff : centralDirectory.length, 12);
  endRecord.writeUInt32LE(options.zip64 ? 0xffffffff : localOffset, 16);
  endRecord.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...localRecords, centralDirectory, ...zip64Records, endRecord, comment]);
}

/**
 * @param {{ name: string, content?: Buffer|string, comment?: Buffer|string, method?: number|string,
 *   crc32Override?: number, uncompressedSizeOverride?: number, flags?: number,
 *   externalFileAttributes?: number }[]} entries
 */
export async function writeCbz(filePath, entries, options = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, createCbzBuffer(entries, options));
  return filePath;
}
