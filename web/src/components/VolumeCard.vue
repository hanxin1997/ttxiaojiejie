<template>
  <n-card size="small" embedded class="volume-card">
    <template v-if="volume.title" #header>
      <n-text strong style="font-size: 15px">{{ volume.title }}</n-text>
    </template>

    <div class="chapter-list">
      <div v-for="chapter in volume.chapters" :key="chapter.id" class="chapter-row">
        <div class="chapter-info">
          <div class="chapter-title">
            <n-text strong style="font-size: 14px">{{ chapter.title }}</n-text>
            <n-tag
              v-if="getChapterProgress(chapter)"
              :type="getChapterProgress(chapter)!.pageIndex >= chapter.pageCount ? 'success' : 'info'"
              size="tiny"
              round
              :bordered="false"
            >
              {{ getChapterProgress(chapter)!.pageIndex >= chapter.pageCount
                ? '已读完'
                : `${getChapterProgress(chapter)!.pageIndex}/${chapter.pageCount}` }}
            </n-tag>
          </div>
          <n-text depth="3" style="display: block; font-size: 12px">{{ chapter.pageCount }} 页</n-text>
        </div>
        <n-space :size="6" style="flex-shrink: 0">
          <n-button
            v-if="chapter.pageCount > 0"
            type="primary"
            size="small"
            @click="$emit('open-chapter', chapter)"
          >
            {{ getChapterProgress(chapter) && getChapterProgress(chapter)!.pageIndex < chapter.pageCount ? '继续' : '浏览' }}
          </n-button>
          <n-button
            v-if="chapter.pageCount > 0"
            text
            type="info"
            tag="a"
            :href="`/media/chapter/${chapter.id}/1`"
            target="_blank"
            size="small"
          >
            首页
          </n-button>
        </n-space>
      </div>
    </div>
  </n-card>
</template>

<script setup lang="ts">
import { NButton, NCard, NSpace, NTag, NText } from 'naive-ui'
import type { ChapterDto, VolumeDto } from '../api'
import { useAppState } from '../composables/useAppState'

defineProps<{ volume: VolumeDto }>()
defineEmits<{ 'open-chapter': [chapter: ChapterDto] }>()

const { state } = useAppState()

function getChapterProgress(chapter: ChapterDto) {
  const progress = state.activeSeries?.readProgress
  if (!progress || progress.chapterId !== chapter.id) return null
  return progress
}
</script>

<style scoped>
.volume-card {
  border: 1px solid var(--md-outline-variant, var(--n-border-color, #eee));
  box-shadow: none;
}

.chapter-list {
  display: grid;
  gap: 10px;
}

.chapter-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--md-outline-variant, var(--n-border-color, #eee));
}

.chapter-row:last-child { border-bottom: none; }
.chapter-info { min-width: 0; flex: 1; }
.chapter-title { display: flex; align-items: center; gap: 8px; }
</style>
