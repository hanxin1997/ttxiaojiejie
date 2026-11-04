import { buildSeriesDetail, buildSeriesListItem, findSeriesById } from './series.mjs';
import { naturalCompare } from '../utils.mjs';

const OPDS_CATALOG_TYPE = 'application/atom+xml;profile=opds-catalog;kind=navigation';
const OPDS_ACQUISITION_TYPE = 'application/atom+xml;profile=opds-catalog;kind=acquisition';

function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function getBaseUrl(request) {
  const proto = String(request.headers['x-forwarded-proto'] ?? '').trim() || 'http';
  const host = String(request.headers.host ?? '').trim() || '127.0.0.1';
  return `${proto}://${host}`;
}

function absoluteUrl(request, pathname) {
  return new URL(pathname, `${getBaseUrl(request)}/`).toString();
}

function xml(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/atom+xml; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}

function openSearch(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/opensearchdescription+xml; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(payload);
}

function buildFeed({ id, title, updated, iconUrl, links = [], entries = [] }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>${xmlEscape(id)}</id>
  <title>${xmlEscape(title)}</title>
  <updated>${xmlEscape(updated)}</updated>
  ${iconUrl ? `<icon>${xmlEscape(iconUrl)}</icon>` : ''}
  ${links
    .map((link) => {
      const attrs = [
        `rel="${xmlEscape(link.rel)}"`,
        `href="${xmlEscape(link.href)}"`,
        link.type ? `type="${xmlEscape(link.type)}"` : '',
        link.title ? `title="${xmlEscape(link.title)}"` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `<link ${attrs} />`;
    })
    .join('\n  ')}
  ${entries.join('\n  ')}
</feed>`;
}

function buildCatalogEntry(request, series, store, projected = false) {
  const item = projected ? series : buildSeriesListItem(series, store);
  const coverUrl = item.coverUrl ? absoluteUrl(request, item.coverUrl) : null;
  const detailUrl = absoluteUrl(request, `/opds/series/${item.id}`);
  const apiUrl = absoluteUrl(request, `/api/series/${item.id}`);
  const authorBlock = item.author
    ? `<author><name>${xmlEscape(item.author)}</name></author>`
    : '';
  const categoryBlock = (item.categories?.effective ?? [])
    .map((category) => `<category term="${xmlEscape(category)}" label="${xmlEscape(category)}" />`)
    .join('');

  return `<entry>
    <id>${xmlEscape(`opds:series:${item.id}`)}</id>
    <title>${xmlEscape(item.title)}</title>
    <updated>${xmlEscape(new Date().toISOString())}</updated>
    ${authorBlock}
    ${item.description ? `<summary type="text">${xmlEscape(item.description)}</summary>` : ''}
    ${categoryBlock}
    <link rel="subsection" type="${OPDS_ACQUISITION_TYPE}" href="${xmlEscape(detailUrl)}" />
    <link rel="alternate" type="application/json" href="${xmlEscape(apiUrl)}" />
    ${coverUrl ? `<link rel="http://opds-spec.org/image/thumbnail" type="image/jpeg" href="${xmlEscape(coverUrl)}" />` : ''}
  </entry>`;
}

function buildChapterEntry(request, chapter, sequence, title) {
  const firstPageUrl = chapter.firstPageUrl ? absoluteUrl(request, chapter.firstPageUrl) : null;
  const apiUrl = absoluteUrl(request, `/media/chapter/${chapter.id}/1`);

  return `<entry>
    <id>${xmlEscape(`opds:chapter:${chapter.id}`)}</id>
    <title>${xmlEscape(title)}</title>
    <updated>${xmlEscape(new Date().toISOString())}</updated>
    <summary type="text">${xmlEscape(`${chapter.pageCount} pages`)}</summary>
    <content type="text">${xmlEscape(`Sequence ${sequence}`)}</content>
    ${firstPageUrl ? `<link rel="http://opds-spec.org/acquisition/open-access" type="image/jpeg" href="${xmlEscape(firstPageUrl)}" />` : ''}
    <link rel="alternate" type="image/jpeg" href="${xmlEscape(apiUrl)}" />
  </entry>`;
}

function buildRootFeed(request, ctx) {
  const summary = getSummary(ctx.store);
  const updated = summary.lastScanAt ?? new Date().toISOString();

  return buildFeed({
    id: absoluteUrl(request, '/opds'),
    title: 'TPAP OPDS Catalog',
    updated,
    links: [
      { rel: 'self', href: absoluteUrl(request, '/opds'), type: OPDS_CATALOG_TYPE },
      { rel: 'start', href: absoluteUrl(request, '/opds'), type: OPDS_CATALOG_TYPE },
      { rel: 'search', href: absoluteUrl(request, '/opds/search.xml'), type: 'application/opensearchdescription+xml' },
    ],
    entries: [
      `<entry>
        <id>${xmlEscape('opds:root:catalog')}</id>
        <title>${xmlEscape('Browse library')}</title>
        <updated>${xmlEscape(updated)}</updated>
        <content type="text">${xmlEscape('Browse all scanned series.')}</content>
        <link rel="subsection" type="${OPDS_ACQUISITION_TYPE}" href="${xmlEscape(absoluteUrl(request, '/opds/catalog'))}" />
      </entry>`,
    ],
  });
}

function getSummary(store) {
  return store.getLibrarySummary?.() ?? store.getLibraryRef?.() ?? store.getLibrary();
}

const catalogCacheByContext = new WeakMap();

function getCatalogCache(ctx) {
  let cache = catalogCacheByContext.get(ctx);
  if (!cache) {
    cache = { revision: -1, itemPairs: [] };
    catalogCacheByContext.set(ctx, cache);
  }
  const revision = getSummary(ctx.store).revision;
  if (revision === undefined || cache.revision !== revision) {
    const library = ctx.store.getLibraryRef();
    cache.itemPairs = library.series.map((series) => ({
      series,
      item: buildSeriesListItem(series, ctx.store),
    }));
    cache.itemPairs.sort((left, right) =>
      naturalCompare(left.item.title, right.item.title));
    cache.revision = revision;
  }
  return cache;
}

function buildCatalogFeed(request, ctx, query, pageData = null) {
  const search = String(query.search ?? '').trim().toLowerCase();
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);

  // 目录投影和自然排序按 revision 缓存；分页请求不再重复扫描、投影和排序全库。
  let itemPairs = pageData ? [] : getCatalogCache(ctx).itemPairs;

  if (search) {
    itemPairs = itemPairs.filter(({ item }) => {
      return (
        item.title.toLowerCase().includes(search) ||
        item.author?.toLowerCase().includes(search) ||
        item.sourceKey.toLowerCase().includes(search)
      );
    });
  }

  const totalPages = pageData?.totalPages ?? Math.max(1, Math.ceil(itemPairs.length / pageSize));
  const currentPage = pageData?.page ?? Math.min(page, totalPages);
  const items = pageData?.items ?? itemPairs.slice((currentPage - 1) * pageSize, currentPage * pageSize).map(({ item }) => item);
  const updated = (pageData?.lastScanAt ?? getSummary(ctx.store).lastScanAt) ?? new Date().toISOString();

  const queryBase = new URLSearchParams();
  if (search) {
    queryBase.set('search', search);
  }
  queryBase.set('pageSize', String(pageSize));
  const makePageUrl = (pageValue) => {
    const params = new URLSearchParams(queryBase);
    params.set('page', String(pageValue));
    return absoluteUrl(request, `/opds/catalog?${params.toString()}`);
  };

  const links = [
    { rel: 'self', href: makePageUrl(currentPage), type: OPDS_ACQUISITION_TYPE },
    { rel: 'start', href: absoluteUrl(request, '/opds'), type: OPDS_CATALOG_TYPE },
  ];

  if (currentPage > 1) {
    links.push({ rel: 'previous', href: makePageUrl(currentPage - 1), type: OPDS_ACQUISITION_TYPE });
  }
  if (currentPage < totalPages) {
    links.push({ rel: 'next', href: makePageUrl(currentPage + 1), type: OPDS_ACQUISITION_TYPE });
  }

  return buildFeed({
    id: absoluteUrl(request, '/opds/catalog'),
    title: search ? `Search results for "${search}"` : 'Library catalog',
    updated,
    links,
    entries: items.map((item) => buildCatalogEntry(request, item, ctx.store, true)),
  });
}

function buildSeriesFeed(request, ctx, seriesId) {
  const series = findSeriesById(ctx.store, seriesId);
  if (!series) {
    return null;
  }

  const detail = buildSeriesDetail(series, ctx.store);
  const updated = getSummary(ctx.store).lastScanAt ?? new Date().toISOString();
  const chapters = detail.volumes.flatMap((volume) =>
    volume.chapters.map((chapter, index) => ({
      chapter,
      title: volume.synthetic || !volume.title ? chapter.title : `${volume.title} / ${chapter.title}`,
      sequence: index + 1,
    })),
  );

  return buildFeed({
    id: absoluteUrl(request, `/opds/series/${detail.id}`),
    title: detail.title,
    updated,
    links: [
      { rel: 'self', href: absoluteUrl(request, `/opds/series/${detail.id}`), type: OPDS_ACQUISITION_TYPE },
      { rel: 'up', href: absoluteUrl(request, '/opds/catalog'), type: OPDS_ACQUISITION_TYPE },
      { rel: 'alternate', href: absoluteUrl(request, `/api/series/${detail.id}`), type: 'application/json' },
    ],
    entries: chapters.map(({ chapter, title, sequence }) =>
      buildChapterEntry(request, chapter, sequence, title),
    ),
  });
}

function buildOpenSearchDescription(request) {
  return `<?xml version="1.0" encoding="utf-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>TPAP Library</ShortName>
  <Description>Search TPAP OPDS catalog</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Url
    type="${xmlEscape(OPDS_ACQUISITION_TYPE)}"
    template="${xmlEscape(`${absoluteUrl(request, '/opds/catalog')}?search={searchTerms}&amp;page=1&amp;pageSize=30`)}"
  />
</OpenSearchDescription>`;
}

export { buildCatalogFeed, buildOpenSearchDescription, buildRootFeed, buildSeriesFeed };

export function registerOpdsRoutes(router, ctx) {
  router.get('/opds', (req, res) => {
    xml(res, 200, buildRootFeed(req, ctx));
  });

  router.get('/opds/search.xml', (req, res) => {
    openSearch(res, 200, buildOpenSearchDescription(req));
  });

  router.get('/opds/catalog', async (req, res, { query }) => {
    const page = ctx.store.queryCatalogOperationAsync
      ? await ctx.store.queryCatalogOperationAsync('opds-page', query) : null;
    xml(res, 200, buildCatalogFeed(req, ctx, query, page));
  });

  router.get('/opds/series/:id', (req, res, { params }) => {
    const payload = buildSeriesFeed(req, ctx, params.id);
    if (!payload) {
      res.writeHead(404, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'Series not found' }));
      return;
    }

    xml(res, 200, payload);
  });
}
