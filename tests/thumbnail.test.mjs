import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createVariantCacheKey,
  getImageVariantSpec,
  isCacheEntryExpired,
} from '../server/thumbnail.mjs';

test('image variants are fixed and preserve reader aspect ratio', () => {
  assert.deepEqual(getImageVariantSpec('cover'), {
    name: 'cover',
    width: 300,
    height: 450,
    fit: 'cover',
    quality: 80,
  });
  assert.deepEqual(getImageVariantSpec('reader-lite'), {
    name: 'reader-lite',
    width: 1280,
    height: null,
    fit: 'inside',
    quality: 70,
  });
  assert.equal(getImageVariantSpec('900x1200'), null);
});

test('cache key changes when the source file identity changes', () => {
  const first = createVariantCacheKey('/library/a.jpg', { size: 10, mtimeMs: 100, ctimeMs: 90 }, 'cover');
  const second = createVariantCacheKey('/library/a.jpg', { size: 11, mtimeMs: 101, ctimeMs: 90 }, 'cover');

  assert.notEqual(first, second);
  assert.match(first, /^[a-f0-9]{64}_cover\.webp$/);
});

test('cache TTL expires idle entries without expiring recently accessed entries', () => {
  const now = Date.parse('2026-08-10T12:00:00.000Z');
  const ttlMs = 60_000;

  assert.equal(isCacheEntryExpired({ mtimeMs: now - ttlMs - 1 }, now, ttlMs), true);
  assert.equal(isCacheEntryExpired({ mtimeMs: now - ttlMs }, now, ttlMs), false);
  assert.equal(isCacheEntryExpired({ mtimeMs: now - 1000 }, now, ttlMs), false);
});
