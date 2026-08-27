<template>
  <div class="series-list-item md-ripple" :class="{ active, selected }" @click="$emit('click')">
    <div class="list-item-cover">
      <div v-if="selectable" class="select-indicator" @click.stop="$emit('toggle-select')">
        <n-checkbox :checked="selected" />
      </div>

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

    <div class="list-item-info">
      <div class="list-item-title-row">
        <span class="list-item-title">{{ series.title }}</span>
        <n-icon
          :size="16"
          :color="series.favorite ? '#f0a020' : 'var(--n-text-color-3, #ccc)'"
          style="flex-shrink: 0; cursor: pointer"
          @click.stop="$emit('toggle-favorite')"
        >
          <StarSharp v-if="series.favorite" />
          <StarOutline v-else />
        </n-icon>
      </div>

      <n-text v-if="series.author" depth="3" style="font-size: 12px">{{ series.author }}</n-text>

      <n-text
        v-if="series.description"
        depth="3"
        style="font-size: 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-top: 4px"
      >
        {{ series.description }}
      </n-text>

      <div class="list-item-meta">
        <n-tag v-if="series.counts.volumes > 0" size="tiny" :bordered="false" round>
          {{ series.counts.volumes }}卷
        </n-tag>
        <n-tag size="tiny" :bordered="false" round>{{ series.counts.chapters }}章</n-tag>
        <n-tag size="tiny" :bordered="false" round>{{ series.counts.pages }}P</n-tag>
        <n-tag v-if="series.totalBytes > 0" size="tiny" :bordered="false" round>
          {{ formatBytes(series.totalBytes) }}
        </n-tag>
        <n-tag v-if="series.readStatus === 'reading'" type="info" size="tiny" :bordered="false" round>
          阅读中
        </n-tag>
        <n-tag
          v-else-if="series.readStatus === 'completed'"
          type="success"
          size="tiny"
          :bordered="false"
          round
        >
          已读完
        </n-tag>
      </div>

      <div v-if="series.tags && series.tags.length" class="list-item-tags">
        <n-tag
          v-for="tag in series.tags.slice(0, 5)"
          :key="tag"
          size="tiny"
          type="primary"
          :bordered="false"
          round
        >
          {{ tag }}
        </n-tag>
        <n-tag v-if="series.tags.length > 5" size="tiny" :bordered="false" round>
          +{{ series.tags.length - 5 }}
        </n-tag>
      </div>

      <div v-if="effectiveCategories.length" class="list-item-tags">
        <n-tag
          v-for="(cat, i) in effectiveCategories.slice(0, 3)"
          :key="cat"
          size="tiny"
          :type="tagTypes[i % tagTypes.length]"
          :bordered="false"
          round
        >
          {{ cat }}
        </n-tag>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NCheckbox, NIcon, NImage, NSpin, NTag, NText } from 'naive-ui'
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
.series-list-item {
  display: flex;
  gap: 16px;
  padding: 12px;
  border-radius: 12px;
  cursor: pointer;
  
  background-color: var(--md-surface, #fff);
  
  box-shadow: 
    0 0 0 1px rgba(0, 0, 0, 0.05),
    inset 0 1px 0 0 rgba(255, 255, 255, 0.4),
    0 2px 8px -2px rgba(0, 0, 0, 0.05);
  transition: transform 0.2s ease, background-color 0.2s ease, border-color 0.2s ease;
}

@media (prefers-color-scheme: dark) {
  .series-list-item {
    background-color: rgba(30, 30, 30, 0.5);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1), inset 0 1px 0 0 rgba(255, 255, 255, 0.15), 0 2px 8px -2px rgba(0, 0, 0, 0.2);
  }
}

.series-list-item:hover {
  transform: scale(1.01);
  box-shadow: 
    0 0 0 1px rgba(0, 0, 0, 0.05),
    inset 0 1px 0 0 rgba(255, 255, 255, 0.6),
    0px 0px 1px rgba(0,0,0,0.4), 
    0px 12px 24px -6px rgba(0,0,0,0.15);
}

@media (prefers-color-scheme: dark) {
  .series-list-item:hover {
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1), inset 0 1px 0 0 rgba(255, 255, 255, 0.2), 0px 0px 1px rgba(0,0,0,0.6), 0px 12px 24px -6px rgba(0,0,0,0.3);
  }
}

.series-list-item:active {
  box-shadow: var(--md-elevation-8);
}

.series-list-item.active {
  box-shadow: 0 0 0 2px var(--md-primary, #6750A4), var(--md-elevation-2);
}

.series-list-item.selected {
  box-shadow: 0 0 0 2px var(--md-primary, #6750A4);
  opacity: 0.88;
}

.list-item-cover {
  width: 80px;
  height: 120px;
  flex-shrink: 0;
  border-radius: var(--md-shape-sm);
  overflow: hidden;
  position: relative;
  background: linear-gradient(
    135deg,
    var(--tpap-cover-gradient-start, rgba(100, 100, 100, 0.08)),
    var(--tpap-cover-gradient-end, rgba(60, 60, 60, 0.04))
  );
}

.list-item-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.list-item-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.list-item-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.list-item-title {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
  color: var(--md-on-surface, inherit);
}

.list-item-meta {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.list-item-tags {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 2px;
}
</style>
