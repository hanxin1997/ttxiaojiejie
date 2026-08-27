import test from 'node:test';
import assert from 'node:assert/strict';

import { batchScrapeMetadata, scrapeFromAniList } from '../server/metadata-scraper.mjs';

test('scrapeFromAniList normalizes title, author, description, and tags', async () => {
  const result = await scrapeFromAniList(
    'Test',
    { endpoint: 'https://example.invalid/graphql' },
    async () => ({
      ok: true,
      async json() {
        return {
          data: {
            Media: {
              title: { userPreferred: 'Sample Title' },
              description: '<p>Hello<br>World</p>',
              genres: ['Drama'],
              tags: [{ name: 'School', rank: 80, isGeneralSpoiler: false, isMediaSpoiler: false }],
              staff: {
                edges: [{ role: 'Story', node: { name: { full: 'Author A' } } }],
              },
              siteUrl: 'https://anilist.co/manga/1',
            },
          },
        };
      },
    }),
  );

  assert.equal(result.title, 'Sample Title');
  assert.equal(result.author, 'Author A');
  assert.equal(result.description, 'Hello\nWorld');
  assert.deepEqual(result.tags, ['Drama', 'School']);
});

test('batchScrapeMetadata applies scraped data back into the store', async () => {
  const metadata = new Map();
  const tags = new Map();
  const store = {
    getMetadata(sourceKey) {
      return metadata.get(sourceKey) ?? null;
    },
    async setMetadata(sourceKey, value) {
      metadata.set(sourceKey, value);
    },
    getTags(sourceKey) {
      return tags.get(sourceKey) ?? [];
    },
    async setTags(sourceKey, value) {
      tags.set(sourceKey, value);
    },
  };

  const library = {
    series: [
      {
        id: 'series-1',
        title: 'Series One',
        sourceKey: 'series/one',
      },
    ],
  };

  const result = await batchScrapeMetadata(library, store, { provider: 'anilist', endpoint: 'unused' }, {
    apply: true,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          data: {
            Media: {
              title: { userPreferred: 'Series One' },
              description: 'Desc',
              genres: ['Mystery'],
              tags: [],
              staff: { edges: [] },
              siteUrl: null,
            },
          },
        };
      },
    }),
  });

  assert.equal(result.successCount, 1);
  assert.deepEqual(metadata.get('series/one'), {
    title: undefined,
    author: undefined,
    description: 'Desc',
  });
  assert.deepEqual(tags.get('series/one'), ['Mystery']);
});

test('AniList retry backoff is cancelled immediately with its job signal', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('stop retrying')), 20);
  const startedAt = Date.now();

  await assert.rejects(
    scrapeFromAniList(
      'Test',
      {
        endpoint: 'https://example.invalid/graphql',
        itemTimeoutMs: 5000,
        signal: controller.signal,
      },
      async () => {
        throw new Error('temporary network failure');
      },
    ),
    /stop retrying/,
  );

  assert.ok(Date.now() - startedAt < 300, 'abort must not wait for exponential backoff');
});
