function stripHtml(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Operation cancelled'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Operation cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchWithRetry(url, options, fetchImpl = fetch, retries = 2, delayMs = 500) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('Operation cancelled');
    }
    try {
      const response = await fetchImpl(url, options);

      if (response.status === 429 && attempt < retries) {
        const retryAfter = Number(response.headers.get('retry-after')) || delayMs / 1000;
        await sleep(Math.min(retryAfter * 1000, 10_000), options.signal);
        continue;
      }

      return response;
    } catch (error) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? error;
      }
      if (attempt >= retries) {
        throw error;
      }

      await sleep(delayMs * 2 ** attempt, options.signal);
    }
  }
}

function pickPreferredTitle(title) {
  if (!title || typeof title !== 'object') {
    return null;
  }

  return (
    String(title.userPreferred ?? '').trim() ||
    String(title.romaji ?? '').trim() ||
    String(title.english ?? '').trim() ||
    String(title.native ?? '').trim() ||
    null
  );
}

function pickAuthor(media) {
  const edges = media?.staff?.edges ?? [];
  const preferred = edges.find((entry) => /story|art|creator|author/i.test(entry?.role ?? ''));
  const fallback = edges.find((entry) => entry?.node?.name?.full);
  return preferred?.node?.name?.full ?? fallback?.node?.name?.full ?? null;
}

function normalizeTags(media) {
  const tags = [];

  for (const genre of media?.genres ?? []) {
    if (typeof genre === 'string' && genre.trim()) {
      tags.push(genre.trim());
    }
  }

  for (const tag of media?.tags ?? []) {
    if (!tag?.name || tag.isGeneralSpoiler || tag.isMediaSpoiler) {
      continue;
    }

    if (typeof tag.rank === 'number' && tag.rank < 50) {
      continue;
    }

    tags.push(String(tag.name).trim());
  }

  return [...new Set(tags.filter(Boolean))].slice(0, 12);
}

export async function scrapeFromAniList(searchTitle, config, fetchImpl = fetch) {
  const title = String(searchTitle ?? '').trim();
  if (!title) {
    return null;
  }

  const timeoutSignal = AbortSignal.timeout(Math.max(Number(config.itemTimeoutMs) || 15_000, 1));
  const signal = config.signal ? AbortSignal.any([config.signal, timeoutSignal]) : timeoutSignal;
  const response = await fetchWithRetry(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      query: `
        query ($search: String) {
          Media(search: $search, type: MANGA) {
            title {
              romaji
              english
              native
              userPreferred
            }
            description(asHtml: false)
            genres
            tags {
              name
              rank
              isGeneralSpoiler
              isMediaSpoiler
            }
            siteUrl
            staff(sort: [RELEVANCE, ROLE, FAVOURITES_DESC], perPage: 5) {
              edges {
                role
                node {
                  name {
                    full
                  }
                }
              }
            }
          }
        }
      `,
      variables: {
        search: title,
      },
    }),
    signal,
  }, fetchImpl);

  if (!response.ok) {
    throw new Error(`Metadata scraper request failed (${response.status})`);
  }

  const payload = await response.json();
  const media = payload?.data?.Media;
  if (!media) {
    return null;
  }

  return {
    source: 'anilist',
    sourceUrl: media.siteUrl ?? null,
    title: pickPreferredTitle(media.title),
    author: pickAuthor(media),
    description: stripHtml(media.description),
    tags: normalizeTags(media),
  };
}

const PROVIDERS = new Map([
  ['anilist', scrapeFromAniList],
]);

export function hasMetadataProvider(provider) {
  return PROVIDERS.has(String(provider ?? '').trim().toLowerCase());
}

export async function scrapeSeriesMetadata(series, store, config, fetchImpl = fetch) {
  const metaOverride = store.getMetadata(series.sourceKey);
  const searchTitle = metaOverride?.title || series.title;
  const provider = String(config.provider ?? '').trim().toLowerCase();
  const scraper = PROVIDERS.get(provider);
  if (!scraper) throw new Error(`Unknown metadata provider: ${config.provider}`);
  return scraper(searchTitle, config, fetchImpl);
}

function buildMergedMetadata(series, store, scraped, overwrite) {
  const current = store.getMetadata(series.sourceKey) ?? {};

  return {
    title: overwrite ? scraped.title ?? undefined : current.title ?? undefined,
    author:
      overwrite || !current.author
        ? scraped.author ?? current.author ?? undefined
        : current.author,
    description:
      overwrite || !current.description
        ? scraped.description ?? current.description ?? undefined
        : current.description,
  };
}

export async function batchScrapeMetadata(library, store, config, options = {}) {
  const seriesIds = Array.isArray(options.seriesIds) && options.seriesIds.length > 0
    ? new Set(options.seriesIds)
    : null;
  const overwrite = Boolean(options.overwrite);
  const apply = options.apply !== false;

  const items = [];

  for (const series of library.series) {
    if (seriesIds && !seriesIds.has(series.id)) {
      continue;
    }

    // 请求间隔，避免被 AniList 限流
    if (items.length > 0) {
      await sleep(1200, config.signal);
    }

    try {
      const scraped = await scrapeSeriesMetadata(series, store, config, options.fetchImpl ?? fetch);
      if (!scraped) {
        items.push({
          seriesId: series.id,
          title: series.title,
          ok: false,
          error: 'No metadata match',
        });
        continue;
      }

      if (apply) {
        const metadata = buildMergedMetadata(series, store, scraped, overwrite);
        await store.setMetadata(series.sourceKey, metadata);

        const existingTags = store.getTags(series.sourceKey);
        const nextTags = overwrite
          ? scraped.tags
          : [...new Set([...existingTags, ...scraped.tags])];
        await store.setTags(series.sourceKey, nextTags);
      }

      items.push({
        seriesId: series.id,
        title: series.title,
        ok: true,
        applied: apply,
        scraped,
      });
    } catch (error) {
      items.push({
        seriesId: series.id,
        title: series.title,
        ok: false,
        error: error.message,
      });
    }
  }

  return {
    total: items.length,
    successCount: items.filter((item) => item.ok).length,
    failureCount: items.filter((item) => !item.ok).length,
    items,
  };
}
