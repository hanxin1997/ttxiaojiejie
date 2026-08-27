import test from 'node:test';
import assert from 'node:assert/strict';

import { RateLimiter, resolveClientAddress, shouldRateLimitPath } from '../server/rate-limit.mjs';

test('shouldRateLimitPath only applies to api and opds endpoints', () => {
  assert.equal(shouldRateLimitPath('/api/series'), true);
  assert.equal(shouldRateLimitPath('/opds/catalog'), true);
  assert.equal(shouldRateLimitPath('/media/chapter/a/1'), false);
});

test('RateLimiter limits requests inside the same window', () => {
  const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 2 });
  const now = Date.now();

  assert.equal(limiter.consume('client-1', now).limited, false);
  assert.equal(limiter.consume('client-1', now + 10).limited, false);
  assert.equal(limiter.consume('client-1', now + 20).limited, true);
  assert.equal(limiter.consume('client-1', now + 1100).limited, false);
});

test('forwarded client addresses are trusted only when TRUST_PROXY is enabled', () => {
  const request = {
    headers: { 'x-forwarded-for': '203.0.113.8, 10.0.0.2' },
    socket: { remoteAddress: '10.0.0.1' },
  };

  assert.equal(resolveClientAddress(request, false), '10.0.0.1');
  assert.equal(resolveClientAddress(request, true), '203.0.113.8');
});

test('RateLimiter prunes buckets on an interval instead of scanning them on every request', () => {
  const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 2, pruneIntervalMs: 500 });
  limiter.consume('client-1', 1000);
  limiter.consume('client-2', 1010);
  assert.equal(limiter.pruneCount, 0);
  limiter.consume('client-3', 1600);
  assert.equal(limiter.pruneCount, 1);
});
