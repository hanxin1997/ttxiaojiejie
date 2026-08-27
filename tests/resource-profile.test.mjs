import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveResourceProfile } from '../server/resource-profile.mjs';

test('resource profile selects lite for a two-core low-memory host', () => {
  const profile = resolveResourceProfile('auto', { cpuCount: 2, memoryBytes: 2 * 1024 ** 3 });

  assert.equal(profile.name, 'lite');
  assert.equal(profile.scanSeriesConcurrency, 1);
  assert.equal(profile.fileStatConcurrency, 16);
  assert.equal(profile.thumbnailConcurrency, 1);
});

test('explicit resource profile overrides host detection', () => {
  const profile = resolveResourceProfile('full', { cpuCount: 1, memoryBytes: 512 * 1024 ** 2 });

  assert.equal(profile.name, 'full');
  assert.equal(profile.fileStatConcurrency, 128);
});

test('invalid resource profile is rejected', () => {
  assert.throws(() => resolveResourceProfile('turbo'), /RESOURCE_PROFILE/);
});
