import test from 'node:test';
import assert from 'node:assert/strict';

import { createRouter } from '../server/router.mjs';
import { buildSeriesListItem, registerSeriesRoutes } from '../server/routes/series.mjs';

function createSeries(id, title) {
  return {
    id,
    title,
    author: null,
    sourceFolderName: title,
    sourceKey: title,
    sourcePath: `/library/${title}`,
    categories: {
      auto: [],
      folder: [],
      manual: [],
      effective: [],
    },
    counts: {
      volumes: 0,
      chapters: 1,
      pages: 1,
    },
    totalBytes: 100,
    cover: null,
    metadata: {},
    tags: [],
    volumes: [
      {
        id: `vol-${id}`,
        title: 'Default Volume',
        synthetic: true,
        sourcePath: `/library/${title}`,
        chapters: [
          {
            id: `chap-${id}`,
            title: '1P',
            sourcePath: `/library/${title}`,
            pageCount: 1,
            pages: [{ id: `page-${id}`, index: 1, sourcePath: `/library/${title}/1.jpg` }],
          },
        ],
      },
    ],
  };
}

function createCtx(seriesList) {
  const store = {
      querySeriesPage(_query, { page, pageSize }) {
        const allItems = seriesList
          .map((series) => buildSeriesListItem(series, store))
          .sort((left, right) => left.title.localeCompare(right.title));
        const start = (page - 1) * pageSize;
        return {
          items: allItems.slice(start, start + pageSize),
          total: allItems.length,
          page,
          pageSize,
          totalPages: Math.max(1, Math.ceil(allItems.length / pageSize)),
          revision: null,
        };
      },
      getLibraryRef() {
        throw new Error('list route must not materialize the library');
      },
      getSeriesById(id) {
        return seriesList.find((item) => item.id === id) ?? null;
      },
      findChapterById(id) {
        for (const series of seriesList) {
          for (const volume of series.volumes) {
            const chapter = volume.chapters.find((item) => item.id === id);
            if (chapter) return chapter;
          }
        }
        return null;
      },
      getLibrary() {
        return { series: seriesList };
      },
      getCustomCover() {
        return null;
      },
      getMetadata() {
        return null;
      },
      getTags() {
        return [];
      },
      getReadProgress() {
        return null;
      },
      isFavorite() {
        return false;
      },
    };
  return {
    store,
    scanCoordinator: {
      async run() {},
    },
    notifyLibraryChanged() {},
  };
}

async function callRoute(router, method, pathname, query = {}) {
  const matched = router.match(method, pathname);
  assert.ok(matched);

  let statusCode = null;
  let payload = null;
  await matched.handler(
    {},
    {},
    {
      query,
      params: matched.params,
      respond(code, body) {
        statusCode = code;
        payload = body;
      },
    },
  );

  return { statusCode, payload };
}

test('GET /api/series uses a bounded default page size', async () => {
  const router = createRouter();
  const ctx = createCtx(
    Array.from({ length: 100 }, (_, index) => createSeries(String(index + 1), `Series ${String(index + 1).padStart(3, '0')}`)),
  );

  registerSeriesRoutes(router, ctx);
  const { statusCode, payload } = await callRoute(router, 'GET', '/api/series');

  assert.equal(statusCode, 200);
  assert.equal(payload.total, 100);
  assert.equal(payload.items.length, 80);
  assert.equal(payload.page, 1);
  assert.equal(payload.pageSize, 80);
  assert.equal(payload.totalPages, 2);
});

test('GET /api/series rejects invalid pagination instead of silently returning an unbounded result', async () => {
  const router = createRouter();
  registerSeriesRoutes(router, createCtx([createSeries('1', 'Alpha')]));

  const { statusCode, payload } = await callRoute(router, 'GET', '/api/series', {
    page: '0',
    pageSize: '1000',
  });

  assert.equal(statusCode, 400);
  assert.match(payload.error, /page/i);
});

test('GET /api/series/:id returns chapter summaries without source paths or page URL arrays', async () => {
  const router = createRouter();
  registerSeriesRoutes(router, createCtx([createSeries('1', 'Alpha')]));

  const { statusCode, payload } = await callRoute(router, 'GET', '/api/series/1');

  assert.equal(statusCode, 200);
  assert.equal('sourcePath' in payload, false);
  assert.equal('sourcePath' in payload.volumes[0], false);
  assert.equal('sourcePath' in payload.volumes[0].chapters[0], false);
  assert.equal('pageUrls' in payload.volumes[0].chapters[0], false);
  assert.equal(payload.volumes[0].chapters[0].pageCount, 1);
});

test('GET /api/chapters/:id/pages returns a lightweight page template', async () => {
  const router = createRouter();
  registerSeriesRoutes(router, createCtx([createSeries('1', 'Alpha')]));

  const { statusCode, payload } = await callRoute(router, 'GET', '/api/chapters/chap-1/pages');

  assert.equal(statusCode, 200);
  assert.deepEqual(payload, {
    chapterId: 'chap-1',
    pageCount: 1,
    urlTemplate: '/media/chapter/chap-1/{pageIndex}',
  });
});
