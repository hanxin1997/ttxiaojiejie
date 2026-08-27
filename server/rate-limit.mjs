export function resolveClientAddress(request, trustProxy = false) {
  const forwardedFor = request.headers['x-forwarded-for'];
  if (trustProxy && typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return request.socket?.remoteAddress ?? 'unknown';
}

function normalizePathname(pathname) {
  return typeof pathname === 'string' && pathname.trim() ? pathname : '/';
}

export function shouldRateLimitPath(pathname) {
  const normalized = normalizePathname(pathname);
  return normalized.startsWith('/api/') || normalized.startsWith('/opds');
}

export class RateLimiter {
  constructor(options = {}) {
    this.windowMs = Math.max(Number(options.windowMs) || 0, 1);
    this.maxRequests = Math.max(Number(options.maxRequests) || 0, 0);
    this.pruneIntervalMs = Math.max(Number(options.pruneIntervalMs) || this.windowMs, 1);
    this.buckets = new Map();
    this.nextPruneAt = null;
    this.pruneCount = 0;
  }

  isEnabled() {
    return this.maxRequests > 0;
  }

  consume(key, now = Date.now()) {
    if (!this.isEnabled()) {
      return {
        limited: false,
        remaining: Number.POSITIVE_INFINITY,
        resetAt: now + this.windowMs,
        retryAfterSeconds: 0,
      };
    }

    const bucketKey = key || 'unknown';
    if (this.nextPruneAt === null) this.nextPruneAt = now + this.pruneIntervalMs;
    else if (now >= this.nextPruneAt) {
      this.prune(now);
      this.nextPruneAt = now + this.pruneIntervalMs;
    }
    const existing = this.buckets.get(bucketKey);

    if (!existing || existing.resetAt <= now) {
      const nextBucket = {
        count: 1,
        resetAt: now + this.windowMs,
      };
      this.buckets.set(bucketKey, nextBucket);
      return {
        limited: false,
        remaining: Math.max(this.maxRequests - nextBucket.count, 0),
        resetAt: nextBucket.resetAt,
        retryAfterSeconds: 0,
      };
    }

    existing.count += 1;
    const limited = existing.count > this.maxRequests;
    const retryAfterSeconds = limited
      ? Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
      : 0;

    return {
      limited,
      remaining: Math.max(this.maxRequests - existing.count, 0),
      resetAt: existing.resetAt,
      retryAfterSeconds,
    };
  }

  prune(now = Date.now()) {
    this.pruneCount += 1;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}

export function createRateLimitHandler(options = {}) {
  const limiter = new RateLimiter(options);
  const trustProxy = Boolean(options.trustProxy);

  return {
    limiter,
    handle(request, response, pathname) {
      if (!limiter.isEnabled() || !shouldRateLimitPath(pathname)) {
        return false;
      }

      const result = limiter.consume(resolveClientAddress(request, trustProxy));
      response.setHeader('X-RateLimit-Limit', String(limiter.maxRequests));
      response.setHeader(
        'X-RateLimit-Remaining',
        Number.isFinite(result.remaining) ? String(result.remaining) : '0',
      );
      response.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

      if (!result.limited) {
        return false;
      }

      response.writeHead(429, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Retry-After': String(result.retryAfterSeconds),
      });
      response.end(
        JSON.stringify({
          error: 'Too many requests',
          retryAfterSeconds: result.retryAfterSeconds,
        }),
      );
      return true;
    },
  };
}
