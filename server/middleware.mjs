import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

import { FolderBrowseError } from './folders.mjs';

export class PayloadTooLargeError extends Error {
  constructor(limit) {
    super(`Request body exceeds ${limit} bytes`);
    this.statusCode = 413;
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
};

const COMPRESSIBLE_TYPES = new Set([
  'text/html',
  'text/css',
  'text/plain',
  'text/xml',
  'application/json',
  'application/javascript',
  'application/xml',
  'image/svg+xml',
]);

function isCompressible(contentType) {
  const base = String(contentType).split(';')[0].trim().toLowerCase();
  return COMPRESSIBLE_TYPES.has(base);
}

function acceptsGzip(request) {
  return String(request.headers['accept-encoding'] ?? '').includes('gzip');
}

function isImageType(contentType) {
  return String(contentType).startsWith('image/') && contentType !== 'image/svg+xml';
}

export function getCacheControl(filePath, contentType) {
  // 图库文件允许客户端缓存，但每次使用验证器确认源文件是否变化。
  if (isImageType(contentType)) {
    return 'public, no-cache';
  }

  // 带 hash 的前端构建产物 — 长期缓存
  const basename = path.basename(filePath);
  if (/\.[0-9a-f]{8,}\./i.test(basename) || /-[a-z0-9_-]{8,}\.[^.]+$/i.test(basename)) {
    return 'public, max-age=31536000, immutable';
  }

  return 'no-store';
}

export function json(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

export function text(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}

export function jsonCompressed(request, response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');

  if (acceptsGzip(request) && body.length > 1024) {
    zlib.gzip(body, (error, compressed) => {
      if (error) {
        response.writeHead(statusCode, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': body.length,
        });
        response.end(body);
        return;
      }

      response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Encoding': 'gzip',
        'Content-Length': compressed.length,
      });
      response.end(compressed);
    });
    return;
  }

  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  response.end(body);
}

export function getMimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

export async function parseJsonBody(request, maxBytes = 1_048_576) {
  const chunks = [];
  let totalSize = 0;

  for await (const chunk of request) {
    totalSize += chunk.length;
    if (totalSize > maxBytes) {
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function serveFile(response, filePath, request = null) {
  try {
    const stats = await fsp.stat(filePath);
    if (!stats.isFile()) {
      text(response, 404, 'Not found');
      return;
    }

    const contentType = getMimeType(filePath);
    const cacheControl = getCacheControl(filePath, contentType);
    const etag = `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}-${Math.trunc(stats.ctimeMs).toString(16)}"`;
    const lastModified = stats.mtime.toUTCString();
    const method = String(request?.method ?? 'GET').toUpperCase();
    const requestHeaders = request?.headers ?? {};
    const baseHeaders = {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'Accept-Ranges': 'bytes',
      ETag: etag,
      'Last-Modified': lastModified,
    };

    const ifNoneMatch = String(requestHeaders['if-none-match'] ?? '').trim();
    const ifModifiedSince = String(requestHeaders['if-modified-since'] ?? '').trim();
    const notModifiedByEtag = ifNoneMatch && (ifNoneMatch === '*' || ifNoneMatch.split(',').map((value) => value.trim()).includes(etag));
    const modifiedSinceTime = ifModifiedSince ? Date.parse(ifModifiedSince) : Number.NaN;
    const notModifiedByDate = !ifNoneMatch && Number.isFinite(modifiedSinceTime) && Math.floor(stats.mtimeMs / 1000) * 1000 <= modifiedSinceTime;

    if ((method === 'GET' || method === 'HEAD') && (notModifiedByEtag || notModifiedByDate)) {
      response.writeHead(304, baseHeaders);
      response.end();
      return;
    }

    const rawRange = String(requestHeaders.range ?? '').trim();
    let range = null;
    if (rawRange) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rawRange);
      if (!match || (!match[1] && !match[2])) {
        response.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stats.size}` });
        response.end();
        return;
      }

      let start;
      let end;
      if (!match[1]) {
        const suffixLength = Number.parseInt(match[2], 10);
        if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
          response.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stats.size}` });
          response.end();
          return;
        }
        start = Math.max(0, stats.size - suffixLength);
        end = stats.size - 1;
      } else {
        start = Number.parseInt(match[1], 10);
        end = match[2] ? Number.parseInt(match[2], 10) : stats.size - 1;
      }

      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= stats.size || end < start) {
        response.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stats.size}` });
        response.end();
        return;
      }

      end = Math.min(end, stats.size - 1);
      const ifRange = String(requestHeaders['if-range'] ?? '').trim();
      const ifRangeDate = ifRange ? Date.parse(ifRange) : Number.NaN;
      const ifRangeMatches = !ifRange || ifRange === etag || (Number.isFinite(ifRangeDate) && Math.floor(stats.mtimeMs / 1000) * 1000 <= ifRangeDate);
      if (ifRangeMatches) {
        range = { start, end };
      }
    }

    if (range) {
      const contentLength = range.end - range.start + 1;
      response.writeHead(206, {
        ...baseHeaders,
        'Content-Length': contentLength,
        'Content-Range': `bytes ${range.start}-${range.end}/${stats.size}`,
      });
      if (method === 'HEAD') {
        response.end();
        return;
      }
      await pipeline(fs.createReadStream(filePath, range), response);
      return;
    }

    // 对可压缩的文本类型文件启用 gzip 流式传输
    if (method !== 'HEAD' && request && acceptsGzip(request) && isCompressible(contentType) && stats.size > 1024) {
      response.writeHead(200, {
        ...baseHeaders,
        'Content-Encoding': 'gzip',
      });
      await pipeline(fs.createReadStream(filePath), zlib.createGzip(), response);
      return;
    }

    response.writeHead(200, {
      ...baseHeaders,
      'Content-Length': stats.size,
    });

    if (method === 'HEAD') {
      response.end();
      return;
    }

    await pipeline(fs.createReadStream(filePath), response);
  } catch (error) {
    if (!response.headersSent) {
      text(response, 404, 'Not found');
    } else {
      response.destroy(error);
    }
  }
}

export function createStaticHandler(publicDir) {
  return async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    const { pathname } = requestUrl;

    const publicFilePath = path.join(
      publicDir,
      pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''),
    );

    try {
      const stats = await fsp.stat(publicFilePath);
      if (stats.isFile()) {
        await serveFile(response, publicFilePath, request);
        return true;
      }
    } catch {
      // fall through
    }

    // SPA fallback
    await serveFile(response, path.join(publicDir, 'index.html'), request);
    return true;
  };
}

export function createErrorHandler() {
  return (error, response) => {
    if (error instanceof PayloadTooLargeError) {
      json(response, 413, { error: error.message });
      return;
    }

    if (error instanceof FolderBrowseError) {
      json(response, error.statusCode ?? 400, { error: error.message });
      return;
    }

    console.error('[Server Error]', error);
    json(response, 500, { error: error.message });
  };
}
