<template>
  <div class="detail-panel">
    <n-spin :show="state.loadingDetail">
      <n-empty
        v-if="!state.activeSeries && !state.loadingDetail"
        description="选择一个系列查看详情"
        style="padding: 80px 0"
      />

      <template v-if="state.activeSeries">
        <div class="detail-header">
          <div class="detail-cover-block">
            <n-image
              v-if="state.activeSeries.coverUrl"
              :src="state.activeSeries.coverUrl"
              :alt="state.activeSeries.title"
              object-fit="cover"
              width="100%"
              height="100%"
              :preview-src="state.activeSeries.coverUrl"
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

            <n-button
              v-if="state.activeSeries.coverUrl?.includes('/media/chapter/')"
              size="tiny"
              type="warning"
              style="position: absolute; bottom: 6px; right: 6px"
              @click="handleRemoveCustomCover"
            >
              重置封面
            </n-button>
          </div>

          <div class="detail-info">
            <div class="detail-title-row">
              <n-h2 style="margin: 0">{{ state.activeSeries.title }}</n-h2>
              <n-button
                text
                :type="state.activeSeries.favorite ? 'warning' : 'default'"
                @click="handleToggleFavorite"
              >
                <n-icon :size="22">
                  <StarSharp v-if="state.activeSeries.favorite" />
                  <StarOutline v-else />
                </n-icon>
              </n-button>
            </div>

            <n-text v-if="state.activeSeries.author" depth="2" style="display: block; margin-top: 4px; font-size: 14px">
              作者：{{ state.activeSeries.author }}
            </n-text>

            <n-text
              v-if="state.activeSeries.description"
              depth="3"
              style="display: block; margin-top: 6px; font-size: 13px; white-space: pre-wrap"
            >
              {{ state.activeSeries.description }}
            </n-text>

            <div class="detail-stats">
              <n-tag v-if="state.activeSeries.counts.volumes > 0" type="info" size="small" round :bordered="false">
                {{ state.activeSeries.counts.volumes }} 卷
              </n-tag>
              <n-tag type="success" size="small" round :bordered="false">
                {{ state.activeSeries.counts.chapters }} 章
              </n-tag>
              <n-tag type="warning" size="small" round :bordered="false">
                {{ state.activeSeries.counts.pages }} 页
              </n-tag>
              <n-tag v-if="state.activeSeries.totalBytes > 0" size="small" round :bordered="false">
                {{ formatBytes(state.activeSeries.totalBytes) }}
              </n-tag>
            </div>

            <div v-if="state.activeSeries.tags.length" class="tag-row" style="margin-top: 8px">
              <n-tag
                v-for="tag in state.activeSeries.tags"
                :key="tag"
                size="small"
                type="primary"
                :bordered="false"
                round
                closable
                @close="handleRemoveTag(tag)"
              >
                {{ tag }}
              </n-tag>
            </div>

            <div v-if="effectiveCategories.length" class="tag-row" style="margin-top: 12px">
              <n-tag
                v-for="(category, index) in effectiveCategories"
                :key="category"
                size="small"
                :type="tagTypes[index % tagTypes.length]"
                :bordered="false"
                round
              >
                {{ category }}
              </n-tag>
            </div>

            <div style="margin-top: 16px; display: flex; gap: 8px; align-items: center; max-width: 420px">
              <n-input
                v-model:value="manualCategoriesInput"
                placeholder="手动分类，逗号分隔"
                size="small"
                style="flex: 1"
              />
              <n-button type="primary" size="small" :loading="savingCategories" @click="handleSaveCategories">
                保存
              </n-button>
            </div>

            <div style="margin-top: 12px; display: flex; gap: 8px; align-items: center; max-width: 420px">
              <n-input
                v-model:value="tagInput"
                placeholder="添加标签，逗号分隔"
                size="small"
                style="flex: 1"
                @keydown.enter="handleAddTags"
              />
              <n-button type="info" size="small" :loading="savingTags" @click="handleAddTags">
                添加
              </n-button>
            </div>

            <n-collapse style="margin-top: 16px">
              <n-collapse-item title="编辑元数据" name="metadata">
                <div style="display: flex; flex-direction: column; gap: 8px; max-width: 420px">
                  <n-input v-model:value="metaTitle" placeholder="标题覆盖（留空使用自动解析）" size="small" />
                  <n-input v-model:value="metaAuthor" placeholder="作者覆盖（留空使用自动解析）" size="small" />
                  <n-input
                    v-model:value="metaDescription"
                    placeholder="描述"
                    size="small"
                    type="textarea"
                    :rows="3"
                  />
                  <n-button type="primary" size="small" :loading="savingMeta" @click="handleSaveMetadata">
                    保存元数据
                  </n-button>
                </div>
              </n-collapse-item>
            </n-collapse>
          </div>
        </div>

        <n-card title="相似系列" size="small" embedded style="margin-top: 20px; border-radius: var(--md-shape-sm); box-shadow: var(--md-elevation-1)">
          <n-spin :show="loadingRecommendations">
            <n-empty
              v-if="!loadingRecommendations && recommendations.length === 0"
              description="暂无推荐结果"
            />
            <div v-else class="recommend-list">
              <button
                v-for="item in recommendations"
                :key="item.series.id"
                class="recommend-item"
                @click="handleOpenRecommendation(item.series.id)"
              >
                <div class="recommend-title">{{ item.series.title }}</div>
                <div class="recommend-meta">
                  匹配分：{{ item.score }}
                  <template v-if="item.reasons.length"> · {{ item.reasons.join(' / ') }}</template>
                </div>
              </button>
            </div>
          </n-spin>
        </n-card>

        <div class="volume-stack">
          <VolumeCard
            v-for="volume in state.activeSeries.volumes"
            :key="volume.id"
            :volume="volume"
            @open-chapter="openChapter"
          />
        </div>

        <ImageViewer
          :visible="viewerVisible"
          :title="viewerTitle"
          :page-urls="viewerPageUrls"
          :chapter-id="viewerChapterId"
          :initial-index="viewerInitialIndex"
          :show-cover-action="true"
          @update:visible="viewerVisible = $event"
          @set-cover="handleSetViewerCover"
          @progress-update="handleViewerProgress"
        />
      </template>
    </n-spin>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NButton,
  NCard,
  NCollapse,
  NCollapseItem,
  NEmpty,
  NH2,
  NIcon,
  NImage,
  NInput,
  NSpin,
  NTag,
  NText,
  useMessage,
} from 'naive-ui'
import { StarOutline, StarSharp } from '@vicons/ionicons5'
import type { ChapterDto, RecommendationItem } from '../api'
import { api } from '../api'
import VolumeCard from './VolumeCard.vue'
import ImageViewer from './ImageViewer.vue'
import { useAppState } from '../composables/useAppState'
import { formatBytes } from '../utils/format'

const {
  state,
  openSeriesDetail,
  removeCustomCover,
  restoreActiveDetail,
  saveReadProgress,
  saveSeriesCategories,
  setCustomCover,
  toggleFavorite,
} = useAppState()

const message = useMessage()

const manualCategoriesInput = ref('')
const tagInput = ref('')
const metaTitle = ref('')
const metaAuthor = ref('')
const metaDescription = ref('')
const savingCategories = ref(false)
const savingTags = ref(false)
const savingMeta = ref(false)
const loadingRecommendations = ref(false)
const recommendations = ref<RecommendationItem[]>([])
const viewerVisible = ref(false)
const viewerTitle = ref('')
const viewerPageUrls = ref<string[]>([])
const viewerChapterId = ref('')
const viewerInitialIndex = ref(0)
let chapterRequestGeneration = 0

const tagTypes = ['success', 'info', 'warning', 'error', 'default'] as const

const effectiveCategories = computed(() => {
  const categories = state.activeSeries?.categories
  if (!categories) return []
  return categories.effective?.length ? categories.effective : categories.folder
})

async function loadMetadataEditor(seriesId: string) {
  const payload = await api.getSeriesMetadata(seriesId)
  metaTitle.value = payload.override.title ?? ''
  metaAuthor.value = payload.override.author ?? ''
  metaDescription.value = payload.override.description ?? ''
}

async function loadRecommendations(seriesId: string) {
  loadingRecommendations.value = true
  try {
    recommendations.value = (await api.getSeriesRecommendations(seriesId)).items
  } catch {
    recommendations.value = []
  } finally {
    loadingRecommendations.value = false
  }
}

watch(
  () => state.activeSeries?.id,
  (seriesId) => {
    if (!seriesId || !state.activeSeries) {
      recommendations.value = []
      return
    }

    manualCategoriesInput.value = state.activeSeries.categories.manual.join(', ')
    tagInput.value = ''
    metaTitle.value = ''
    metaAuthor.value = ''
    metaDescription.value = ''

    loadMetadataEditor(seriesId).catch(() => {})
    loadRecommendations(seriesId).catch(() => {})
  },
  { immediate: true },
)

async function handleSaveCategories() {
  if (!state.activeSeries) return
  savingCategories.value = true
  try {
    const categories = manualCategoriesInput.value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    await saveSeriesCategories(state.activeSeries.id, categories)
    message.success('分类已保存')
  } catch (error: any) {
    message.error(error?.message || '分类保存失败')
  } finally {
    savingCategories.value = false
  }
}

async function handleToggleFavorite() {
  if (!state.activeSeries) return
  try {
    await toggleFavorite(state.activeSeries.id)
  } catch (error: any) {
    message.error(error?.message || '收藏失败')
  }
}

async function handleRemoveCustomCover() {
  if (!state.activeSeries) return
  try {
    await removeCustomCover(state.activeSeries.id)
    message.success('封面已重置')
  } catch (error: any) {
    message.error(error?.message || '封面重置失败')
  }
}

async function handleAddTags() {
  if (!state.activeSeries || !tagInput.value.trim()) return
  savingTags.value = true
  try {
    const newTags = tagInput.value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
    const merged = [...new Set([...(state.activeSeries.tags ?? []), ...newTags])]
    await api.setSeriesTags(state.activeSeries.id, merged)
    tagInput.value = ''
    await restoreActiveDetail()
    message.success('标签已添加')
  } catch (error: any) {
    message.error(error?.message || '标签添加失败')
  } finally {
    savingTags.value = false
  }
}

async function handleRemoveTag(tag: string) {
  if (!state.activeSeries) return
  try {
    const tags = state.activeSeries.tags.filter((item) => item !== tag)
    await api.setSeriesTags(state.activeSeries.id, tags)
    await restoreActiveDetail()
    message.success('标签已移除')
  } catch (error: any) {
    message.error(error?.message || '标签移除失败')
  }
}

async function handleSaveMetadata() {
  if (!state.activeSeries) return
  savingMeta.value = true
  try {
    await api.setSeriesMetadata(state.activeSeries.id, {
      title: metaTitle.value || undefined,
      author: metaAuthor.value || undefined,
      description: metaDescription.value || undefined,
    })
    await restoreActiveDetail()
    await loadRecommendations(state.activeSeries.id)
    message.success('元数据已保存')
  } catch (error: any) {
    message.error(error?.message || '元数据保存失败')
  } finally {
    savingMeta.value = false
  }
}

async function handleOpenRecommendation(seriesId: string) {
  try {
    await openSeriesDetail(seriesId)
  } catch (error: any) {
    message.error(error?.message || '打开推荐失败')
  }
}

async function openChapter(chapter: ChapterDto) {
  const generation = ++chapterRequestGeneration
  try {
    const payload = await api.getChapterPages(chapter.id)
    if (generation !== chapterRequestGeneration || !state.activeSeries) return
    viewerChapterId.value = chapter.id
    viewerTitle.value = chapter.title
    viewerPageUrls.value = Array.from({ length: payload.pageCount }, (_, index) => {
      return payload.urlTemplate.replace('{pageIndex}', String(index + 1))
    })
    const progress = state.activeSeries.readProgress
    viewerInitialIndex.value = progress?.chapterId === chapter.id && progress.pageIndex < payload.pageCount
      ? Math.max(0, progress.pageIndex - 1)
      : 0
    viewerVisible.value = payload.pageCount > 0
  } catch (error: any) {
    message.error(error?.message || '章节页面加载失败')
  }
}

async function handleSetViewerCover(chapterId: string, pageIndex: number) {
  if (!state.activeSeries) return
  try {
    await setCustomCover(state.activeSeries.id, chapterId, pageIndex)
    viewerVisible.value = false
    message.success('封面已设置')
  } catch (error: any) {
    message.error(error?.message || '设置封面失败')
  }
}

async function handleViewerProgress(chapterId: string, pageIndex: number, totalPages: number) {
  if (!state.activeSeries) return
  try {
    await saveReadProgress(state.activeSeries.id, chapterId, pageIndex, totalPages)
  } catch {
    // 阅读过程中的进度写入失败不打断查看。
  }
}
</script>

<style scoped>
.detail-panel {
  width: 100%;
}

.detail-title-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.detail-stats {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.recommend-list {
  display: grid;
  gap: 10px;
}

.recommend-item {
  text-align: left;
  border: 1px solid var(--md-outline-variant, var(--n-border-color, #e5e7eb));
  border-radius: var(--md-shape-sm);
  background: var(--md-surface, var(--n-color, #fff));
  padding: 10px 12px;
  cursor: pointer;
  transition: border-color var(--md-duration-short) var(--md-easing-standard),
              box-shadow var(--md-duration-short) var(--md-easing-standard);
}

.recommend-item:hover {
  border-color: var(--md-primary, #6750A4);
  box-shadow: var(--md-elevation-2);
}

.recommend-title {
  font-weight: 600;
  color: var(--md-on-surface, inherit);
}

.recommend-meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--md-on-surface-variant, var(--n-text-color-3, #666));
}
</style>
