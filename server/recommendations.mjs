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

function scoreCandidate(targetSeries, target, candidateSeries, store, featureCache) {
  const candidate = featureCache.get(candidateSeries.id) ?? collectSeriesFeatures(candidateSeries, store);
  featureCache.set(candidateSeries.id, candidate);
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
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(options.limit)) || 8));
  const targetSeries = library.series.find((series) => series.id === seriesId);

  if (!targetSeries) {
    return null;
  }

  const featureCache = options.featureCache ?? new Map();
  const target = featureCache.get(targetSeries.id) ?? collectSeriesFeatures(targetSeries, store);
  featureCache.set(targetSeries.id, target);
  const best = [];
  const compare = (left, right) => right.score - left.score || naturalCompare(
    featureCache.get(left.series.id).title, featureCache.get(right.series.id).title);
  for (const series of library.series) {
    if (series.id === seriesId) continue;
    const result = scoreCandidate(targetSeries, target, series, store, featureCache);
    if (result.score <= 0) continue;
    const item = { series, ...result };
    // 只保留前 K 项，等分/同标题时在已有项后插入，保持原有稳定排序。
    if (best.length === limit && compare(item, best.at(-1)) >= 0) continue;
    let low = 0;
    let high = best.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(item, best[middle]) < 0) high = middle;
      else low = middle + 1;
    }
    best.splice(low, 0, item);
    if (best.length > limit) best.pop();
  }
  return best;
}
