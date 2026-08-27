import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCatalogFeed, buildRootFeed, buildSeriesFeed } from '../server/routes/opds.mjs';

function createRequest() {
  return {
    headers: {
      host: 'localhost:4321',
    },
  };
}

function createContext() {
  const series = {
    id: 'series-1',
    title: 'Alpha',
    author: 'Alice',
    sourceKey: 'alpha',
    sourceFolderName: 'Alice-Alpha-images',
    categories: { effective: ['Drama'] },
    counts: { volumes: 1, chapters: 1, pages: 2 },
    totalBytes: 100,
    cover: { sourcePath: '/tmp/1.jpg' },
    volumes: [
      {
        id: 'vol-1',
        title: 'Vol.1',
        synthetic: false,
        sourcePath: '/tmp/vol1',
        chapters: [
          {
            id: 'chap-1',
            title: '2P',
            sourcePath: '/tmp/chap1',
            pageCount: 2,
            pages: [
              { id: 'p1', index: 1, sourcePath: '/tmp/1.jpg' },
              { id: 'p2', index: 2, sourcePath: '/tmp/2.jpg' },
            ],
          },
        ],
      },
    ],
  };

  return {
    store: {
      getLibrary() {
        return {
          lastScanAt: '2026-01-01T00:00:00.000Z',
          series: [series],
        };
      },
      getLibraryRef() {
        return {
          lastScanAt: '2026-01-01T00:00:00.000Z',
          series: [series],
        };
      },
      getSeriesById(id) {
        return id === 'series-1' ? series : null;
      },
      getCustomCover() {
        return null;
      },
      isFavorite() {
        return false;
      },
      getMetadata() {
        return null;
      },
      getTags() {
        return [];
      },
    },
  };
}

test('buildRootFeed exposes the library catalog entry', () => {
  const xml = buildRootFeed(createRequest(), createContext());
  assert.match(xml, /TPAP OPDS Catalog/);
  assert.match(xml, /Browse library/);
});

test('buildCatalogFeed renders a series entry', () => {
  const xml = buildCatalogFeed(createRequest(), createContext(), {});
  assert.match(xml, /Alpha/);
  assert.match(xml, /opds:series:series-1/);
});

test('buildSeriesFeed renders chapter entries for a series', () => {
  const xml = buildSeriesFeed(createRequest(), createContext(), 'series-1');
  assert.match(xml, /Vol\.1 \/ 2P/);
  assert.match(xml, /opds:chapter:chap-1/);
});
