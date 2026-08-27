import { naturalCompare, normalizeArray } from './utils.mjs';

function tokenize(value) {
  return normalizeArray(
    String(value ?? '')
      .toLowerCase()
      .split(/[^0-9a-z\u4e00-\u9fff]+/i)
      .filter((token) => token.length >= 2),
  );
}

function buildEffectiveTitle(series, store) {
  return store.getMetadata(series.sourceKey)?.title || series.title;
}

function buildEffectiveAuthor(series, store) {
  return store.getMetadata(series.sourceKey)?.author || series.author || null;
}

function buildFeatureSet(items = []) {
  return new Set(normalizeArray(items).map((item) => String(item).toLowerCase()));
}

function collectSeriesFeatures(series, store) {
  return {
    title: buildEffectiveTitle(series, store),
    author: buildEffectiveAuthor(series, store),
    tags: buildFeatureSet(store.getTags(series.sourceKey)),
    categories: buildFeatureSet(series.categories?.effective ?? []),
    titleTokens: buildFeatureSet(tokenize(buildEffectiveTitle(series, store))),
  };
}

function intersect(left, right) {
  const shared = [];
  for (const item of left) {
    if (right.has(item)) {
      shared.push(item);
    }
  }
  return shared.sort(naturalCompare);
}

function scoreCandidate(targetSeries, candidateSeries, store) {
  const target = collectSeriesFeatures(targetSeries, store);
  const candidate = collectSeriesFeatures(candidateSeries, store);
  const reasons = [];
  let score = 0;

  if (target.author && candidate.author && target.author.toLowerCase() === candidate.author.toLowerCase()) {
    score += 5;
    reasons.push(`same author: ${target.author}`);
  }

  const sharedTags = intersect(target.tags, candidate.tags);
  if (sharedTags.length > 0) {
    score += sharedTags.length * 4;
    reasons.push(`shared tags: ${sharedTags.join(', ')}`);
  }

  const sharedCategories = intersect(target.categories, candidate.categories);
  if (sharedCategories.length > 0) {
    score += sharedCategories.length * 3;
    reasons.push(`shared categories: ${sharedCategories.join(', ')}`);
  }

  const sharedTitleTokens = intersect(target.titleTokens, candidate.titleTokens);
  if (sharedTitleTokens.length > 0) {
    score += sharedTitleTokens.length;
    reasons.push(`similar title tokens: ${sharedTitleTokens.join(', ')}`);
  }

  const targetPages = targetSeries.counts?.pages ?? 0;
  const candidatePages = candidateSeries.counts?.pages ?? 0;
  if (targetPages > 0 && candidatePages > 0) {
    const maxPages = Math.max(targetPages, candidatePages);
    const diffRatio = Math.abs(targetPages - candidatePages) / maxPages;
    if (diffRatio <= 0.1) {
      score += 2;
      reasons.push('similar page count');
    } else if (diffRatio <= 0.25) {
      score += 1;
      reasons.push('close page count');
    }
  }

  return {
    score,
    reasons,
  };
}

export function findSimilarSeries(library, store, seriesId, options = {}) {
  const limit = Math.max(1, Number(options.limit) || 8);
  const targetSeries = library.series.find((series) => series.id === seriesId);

  if (!targetSeries) {
    return null;
  }

  return library.series
    .filter((series) => series.id !== seriesId)
    .map((series) => {
      const result = scoreCandidate(targetSeries, series, store);
      return {
        series,
        score: result.score,
        reasons: result.reasons,
      };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return naturalCompare(
        buildEffectiveTitle(left.series, store),
        buildEffectiveTitle(right.series, store),
      );
    })
    .slice(0, limit);
}
