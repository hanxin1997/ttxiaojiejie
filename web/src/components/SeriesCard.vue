<template>
  <div
    class="series-card md-ripple"
    :class="{ active, selected }"
    role="button"
    tabindex="0"
    :aria-label="series.title"
    :aria-selected="selected"
    @click="$emit('click')"
    @keydown.enter="$emit('click')"
    @keydown.space.prevent="$emit('click')"
    @contextmenu.prevent="$emit('toggle-select')"
  >
    <div class="cover-shell">
      <div v-if="selectable" class="select-indicator" @click.stop="$emit('toggle-select')">
        <n-checkbox :checked="selected" />
      </div>

      <div class="favorite-btn" @click.stop="$emit('toggle-favorite')">
        <n-icon :size="16" :color="series.favorite ? '#f0a020' : 'rgba(255,255,255,0.7)'">
          <StarSharp v-if="series.favorite" />
          <StarOutline v-else />
        </n-icon>
      </div>

      <div class="page-badge">{{ series.counts.pages }}P</div>

      <div v-if="series.readStatus === 'reading'" class="read-badge read-badge-reading">阅读中</div>
      <div v-else-if="series.readStatus === 'completed'" class="read-badge read-badge-completed">已读完</div>

      <n-image
        v-if="series.thumbCoverUrl || series.coverUrl"
        :src="series.thumbCoverUrl || series.coverUrl!"
        :alt="series.title"
        object-fit="cover"
        width="100%"
        height="100%"
        lazy
        :preview-disabled="true"
        style="display: block"
      >
        <template #placeholder>
          <div class="cover-placeholder"><n-spin size="small" /></div>
        </template>
        <template #error>
          <div class="cover-placeholder">加载失败</div>
        </template>
      </n-image>
      <div v-else class="cover-placeholder">无封面</div>
    </div>

    <div class="card-info">
      <div class="card-title">{{ series.title }}</div>
      <div v-if="series.author" class="card-author">{{ series.author }}</div>
      <div class="card-meta">
        <template v-if="series.counts.volumes > 0">
          {{ series.counts.volumes }}卷 · {{ series.counts.chapters }}章
        </template>
        <template v-else>
          {{ series.counts.chapters }}章
        </template>
        <template v-if="series.totalBytes > 0"> · {{ formatBytes(series.totalBytes) }}</template>
      </div>

      <div v-if="series.tags && series.tags.length" class="tag-row">
        <n-tag
          v-for="tag in series.tags.slice(0, 2)"
          :key="tag"
          size="tiny"
          type="primary"
          :bordered="false"
          round
        >
          {{ tag }}
        </n-tag>
        <n-tag v-if="series.tags.length > 2" size="tiny" :bordered="false" round>
          +{{ series.tags.length - 2 }}
        </n-tag>
      </div>

      <div v-if="effectiveCategories.length" class="tag-row">
        <n-tag
          v-for="(cat, i) in effectiveCategories.slice(0, 2)"
          :key="cat"
          size="tiny"
          :type="tagTypes[i % tagTypes.length]"
          :bordered="false"
          round
        >
          {{ cat }}
        </n-tag>
        <n-tag v-if="effectiveCategories.length > 2" size="tiny" :bordered="false" round>
          +{{ effectiveCategories.length - 2 }}
        </n-tag>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NCheckbox, NIcon, NImage, NSpin, NTag } from 'naive-ui'
import { StarOutline, StarSharp } from '@vicons/ionicons5'
import type { SeriesListItem } from '../api'
import { formatBytes } from '../utils/format'

const props = defineProps<{
  series: SeriesListItem
  active: boolean
  selected?: boolean
  selectable?: boolean
}>()

defineEmits<{
  click: []
  'toggle-select': []
  'toggle-favorite': []
}>()

const tagTypes = ['success', 'info', 'warning', 'error', 'default'] as const

const effectiveCategories = computed(() => {
  const cats = props.series.categories
  return cats.effective?.length ? cats.effective : cats.folder
})
</script>

<style scoped>
.series-card {
  cursor: pointer;
  border-radius: var(--md-shape-sm);
  overflow: hidden;
  background: var(--md-surface, var(--n-color-embedded, var(--tpap-bg-embedded)));
  box-shadow: var(--md-elevation-1);
  transition:
    box-shadow var(--md-duration-medium) var(--md-easing-standard),
    transform var(--md-duration-medium) var(--md-easing-standard);
}

.series-card:hover {
  box-shadow: var(--md-elevation-4);
}

.series-card:active {
  box-shadow: var(--md-elevation-8);
}

.series-card:focus-visible {
  outline: 2px solid var(--md-primary, #6750A4);
  outline-offset: 2px;
}

.series-card.active {
  box-shadow: 0 0 0 2px var(--md-primary, #6750A4), var(--md-elevation-4);
}

.series-card.selected {
  box-shadow: 0 0 0 2px var(--md-primary, #6750A4);
  opacity: 0.88;
}

.page-badge {
  position: absolute;
  bottom: 6px;
  left: 6px;
  z-index: 2;
  background: var(--tpap-badge-bg);
  color: #fff;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: var(--md-shape-xs);
  font-weight: 500;
}

.read-badge {
  position: absolute;
  bottom: 6px;
  right: 6px;
  z-index: 2;
  color: #fff;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: var(--md-shape-xs);
  font-weight: 600;
}

.read-badge-reading {
  background: var(--md-success, rgba(24, 160, 88, 0.85));
}

.read-badge-completed {
  background: var(--md-secondary, rgba(45, 140, 240, 0.85));
}

.card-info {
  padding: 12px 16px 16px;
}

.card-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  color: var(--md-on-surface, inherit);
}

.card-author {
  font-size: 11px;
  color: var(--md-on-surface-variant, var(--n-text-color-2, var(--tpap-text-secondary)));
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-meta {
  font-size: 11px;
  color: var(--md-on-surface-variant, var(--n-text-color-3, var(--tpap-text-tertiary)));
  margin-top: 4px;
}

.card-info .tag-row {
  margin-top: 6px;
}
</style>
