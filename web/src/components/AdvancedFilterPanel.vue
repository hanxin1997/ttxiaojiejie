<template>
  <n-drawer
    :show="show"
    :width="360"
    placement="right"
    @update:show="$emit('update:show', $event)"
  >
    <n-drawer-content title="高级过滤" closable>
      <n-form label-placement="top" size="small">
        <!-- 标签过滤 -->
        <n-form-item label="标签筛选">
          <n-select
            v-model:value="localTags"
            :options="tagOptions"
            multiple
            filterable
            clearable
            placeholder="选择标签..."
          />
        </n-form-item>

        <n-form-item label="标签匹配模式">
          <n-radio-group v-model:value="localTagMode" size="small">
            <n-radio-button value="and">全部包含</n-radio-button>
            <n-radio-button value="or">包含任一</n-radio-button>
          </n-radio-group>
        </n-form-item>

        <!-- 页数范围 -->
        <n-form-item label="图片数量范围">
          <div style="display: flex; gap: 8px; align-items: center">
            <n-input-number
              v-model:value="localMinPages"
              :min="0"
              placeholder="最少"
              size="small"
              style="flex: 1"
            />
            <n-text depth="3">至</n-text>
            <n-input-number
              v-model:value="localMaxPages"
              :min="0"
              placeholder="最多"
              size="small"
              style="flex: 1"
            />
          </div>
        </n-form-item>

        <!-- 文件大小范围 -->
        <n-form-item label="总大小范围 (MB)">
          <div style="display: flex; gap: 8px; align-items: center">
            <n-input-number
              v-model:value="localMinSizeMB"
              :min="0"
              :precision="0"
              placeholder="最小"
              size="small"
              style="flex: 1"
            />
            <n-text depth="3">至</n-text>
            <n-input-number
              v-model:value="localMaxSizeMB"
              :min="0"
              :precision="0"
              placeholder="最大"
              size="small"
              style="flex: 1"
            />
          </div>
        </n-form-item>

        <!-- 阅读状态 -->
        <n-form-item label="阅读状态">
          <n-select
            v-model:value="localReadStatus"
            :options="readStatusOptions"
            clearable
            placeholder="全部"
          />
        </n-form-item>
      </n-form>

      <template #footer>
        <n-space justify="space-between" style="width: 100%">
          <n-button size="small" @click="handleReset">重置</n-button>
          <n-button type="primary" size="small" @click="handleApply">应用过滤</n-button>
        </n-space>
      </template>
    </n-drawer-content>
  </n-drawer>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NForm,
  NFormItem,
  NInputNumber,
  NRadioButton,
  NRadioGroup,
  NSelect,
  NSpace,
  NText,
} from 'naive-ui'

export interface AdvancedFilters {
  tags: string[]
  tagMode: 'and' | 'or'
  minPages: number | null
  maxPages: number | null
  minSize: number | null
  maxSize: number | null
  readStatus: string | null
}

const props = defineProps<{
  show: boolean
  knownTags: string[]
  filters: AdvancedFilters
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  apply: [filters: AdvancedFilters]
}>()

const localTags = ref<string[]>([])
const localTagMode = ref<'and' | 'or'>('and')
const localMinPages = ref<number | null>(null)
const localMaxPages = ref<number | null>(null)
const localMinSizeMB = ref<number | null>(null)
const localMaxSizeMB = ref<number | null>(null)
const localReadStatus = ref<string | null>(null)

const tagOptions = computed(() =>
  props.knownTags.map((tag) => ({ label: tag, value: tag })),
)

const readStatusOptions = [
  { label: '未读', value: 'unread' },
  { label: '阅读中', value: 'reading' },
  { label: '已读完', value: 'completed' },
]

watch(() => props.show, (visible) => {
  if (visible) {
    localTags.value = [...props.filters.tags]
    localTagMode.value = props.filters.tagMode
    localMinPages.value = props.filters.minPages
    localMaxPages.value = props.filters.maxPages
    localMinSizeMB.value = props.filters.minSize != null ? Math.round(props.filters.minSize / (1024 * 1024)) : null
    localMaxSizeMB.value = props.filters.maxSize != null ? Math.round(props.filters.maxSize / (1024 * 1024)) : null
    localReadStatus.value = props.filters.readStatus
  }
})

function handleApply() {
  emit('apply', {
    tags: localTags.value,
    tagMode: localTagMode.value,
    minPages: localMinPages.value,
    maxPages: localMaxPages.value,
    minSize: localMinSizeMB.value != null ? localMinSizeMB.value * 1024 * 1024 : null,
    maxSize: localMaxSizeMB.value != null ? localMaxSizeMB.value * 1024 * 1024 : null,
    readStatus: localReadStatus.value,
  })
  emit('update:show', false)
}

function handleReset() {
  localTags.value = []
  localTagMode.value = 'and'
  localMinPages.value = null
  localMaxPages.value = null
  localMinSizeMB.value = null
  localMaxSizeMB.value = null
  localReadStatus.value = null
}
</script>
