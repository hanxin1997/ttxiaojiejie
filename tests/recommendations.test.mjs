import test from 'node:test';
import assert from 'node:assert/strict';

import { findSimilarSeries } from '../server/recommendations.mjs';

function createStore() {
  const metadata = new Map();
  const tags = new Map();

  return {
    getMetadata(sourceKey) {
      return metadata.get(sourceKey) ?? null;
    },
    getTags(sourceKey) {
      return tags.get(sourceKey) ?? [];
    },
    setMetadata(sourceKey, value) {
      metadata.set(sourceKey, value);
    },
    setTags(sourceKey, value) {
      tags.set(sourceKey, value);
    },
  };
}

test('findSimilarSeries ranks shared author, tags, and categories first', () => {
  const store = createStore();
  store.setTags('alice/a', ['romance', 'school']);
  store.setTags('alice/b', ['romance', 'comedy']);
  store.setTags('other/c', ['action']);

  const library = {
    series: [
      {
        id: 'a',
        title: 'Alice Love',
        author: 'Alice',
        sourceKey: 'alice/a',
        counts: { pages: 100 },
        categories: { effective: ['Romance'] },
      },
      {
        id: 'b',
        title: 'Alice Days',
        author: 'Alice',
        sourceKey: 'alice/b',
        counts: { pages: 102 },
        categories: { effective: ['Romance'] },
      },
      {
        id: 'c',
        title: 'Battle Field',
        author: 'Bob',
        sourceKey: 'other/c',
        counts: { pages: 300 },
        categories: { effective: ['Action'] },
      },
    ],
  };

  const result = findSimilarSeries(library, store, 'a', { limit: 5 });

  assert.equal(result.length, 1);
  assert.equal(result[0].series.id, 'b');
  assert.ok(result[0].score > 0);
  assert.ok(result[0].reasons.some((reason) => reason.includes('same author')));
});
