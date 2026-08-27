<template>
  <n-card title="扫描配置" size="small" style="border-radius: var(--md-shape-sm)">
    <template #header-extra>
      <n-text v-if="state.meta" depth="3" style="font-size: 12px">
        {{ scanStatusText }}
      </n-text>
    </template>

    <n-form
      :model="formModel"
      label-placement="top"
      label-width="auto"
      size="small"
      @submit.prevent="handleSave"
    >
      <n-form-item label="图库根目录">
        <n-input v-model:value="formModel.libraryRoot" placeholder="/library" />
      </n-form-item>

      <n-form-item label="自动扫描周期">
        <n-input-group>
          <n-input-number
            v-model:value="scanIntervalValue"
            :min="0"
            :placeholder="scanIntervalValue === 0 ? '已禁用' : ''"
            style="flex: 1"
          />
          <n-select
            v-model:value="scanIntervalUnit"
            :options="unitOptions"
            style="width: 100px"
          />
        </n-input-group>
        <n-text v-if="scanIntervalValue > 0" depth="3" style="font-size: 12px; margin-top: 4px">
          即每 {{ humanReadableInterval }} 自动扫描一次
        </n-text>
        <n-text v-else depth="3" style="font-size: 12px; margin-top: 4px">
          设为 0 则禁用自动扫描
        </n-text>
      </n-form-item>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px">
        <n-form-item label="文件夹分隔符">
          <n-input v-model:value="formModel.separator" :maxlength="3" />
        </n-form-item>
        <n-form-item label="作者段索引">
          <n-input-number v-model:value="formModel.authorSegmentIndex" :min="-1" style="width: 100%" />
          <template #feedback>
            <n-text depth="3" style="font-size: 11px">-1 表示不解析作者</n-text>
          </template>
        </n-form-item>
        <n-form-item label="标题段索引">
          <n-input-number v-model:value="formModel.titleSegmentIndex" :min="0" style="width: 100%" />
        </n-form-item>
        <n-form-item label="分类段索引">
          <n-input-number v-model:value="formModel.categorySegmentIndex" :min="0" style="width: 100%" />
        </n-form-item>
      </div>

      <n-form-item label="尾部忽略词">
        <n-input v-model:value="formModel.stripTokens" placeholder="图片, photos" />
      </n-form-item>

      <n-form-item label="叶子目录章节名模板">
        <n-input v-model:value="formModel.directImageChapterTemplate" placeholder="{count}P" />
      </n-form-item>

      <n-button type="primary" attr-type="submit" :loading="saving" block>
        保存配置
      </n-button>
    </n-form>
  </n-card>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  NButton,
  NCard,
  NForm,
  NFormItem,
  NInput,
  NInputGroup,
  NInputNumber,
  NSelect,
  NText,
  useMessage,
} from 'naive-ui'
import { useAppState } from '../composables/useAppState'

const { state, saveSettings } = useAppState()
const message = useMessage()
const saving = ref(false)

type TimeUnit = 'minutes' | 'hours' | 'days' | 'weeks'

const unitOptions = [
  { label: '分钟', value: 'minutes' as TimeUnit },
  { label: '小时', value: 'hours' as TimeUnit },
  { label: '天', value: 'days' as TimeUnit },
  { label: '周', value: 'weeks' as TimeUnit },
]

const unitMultipliers: Record<TimeUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
  weeks: 10080,
}

const scanIntervalValue = ref(15)
const scanIntervalUnit = ref<TimeUnit>('minutes')

function minutesToBestUnit(totalMinutes: number): { value: number; unit: TimeUnit } {
  if (totalMinutes <= 0) return { value: 0, unit: 'minutes' }
  if (totalMinutes % 10080 === 0) return { value: totalMinutes / 10080, unit: 'weeks' }
  if (totalMinutes % 1440 === 0) return { value: totalMinutes / 1440, unit: 'days' }
  if (totalMinutes % 60 === 0) return { value: totalMinutes / 60, unit: 'hours' }
  return { value: totalMinutes, unit: 'minutes' }
}

const totalMinutes = computed(() => {
  return (scanIntervalValue.value ?? 0) * unitMultipliers[scanIntervalUnit.value]
})

const humanReadableInterval = computed(() => {
  const value = scanIntervalValue.value ?? 0
  if (value <= 0) return '已禁用'
  const unitLabel = unitOptions.find((option) => option.value === scanIntervalUnit.value)?.label ?? ''
  return `${value} ${unitLabel}`
})

const formModel = reactive({
  libraryRoot: '',
  separator: '-',
  authorSegmentIndex: 0 as number,
  titleSegmentIndex: 1,
  categorySegmentIndex: 2,
  stripTokens: '',
  directImageChapterTemplate: '{count}P',
})

watch(
  () => state.meta,
  (meta) => {
    if (!meta) return
    const settings = meta.settings
    formModel.libraryRoot = settings.libraryRoot
    formModel.separator = settings.folderPattern.separator
    formModel.authorSegmentIndex = settings.folderPattern.authorSegmentIndex ?? -1
    formModel.titleSegmentIndex = settings.folderPattern.titleSegmentIndex
    formModel.categorySegmentIndex = settings.folderPattern.categorySegmentIndex
    formModel.stripTokens = settings.folderPattern.stripTokens.join(', ')
    formModel.directImageChapterTemplate = settings.naming.directImageChapterTemplate

    const bestUnit = minutesToBestUnit(settings.scanIntervalMinutes)
    scanIntervalValue.value = bestUnit.value
    scanIntervalUnit.value = bestUnit.unit
  },
  { immediate: true },
)

const scanStatusText = computed(() => {
  if (!state.meta) return ''
  const status = state.meta.scanStatus
  const parts = [`最后扫描: ${state.meta.lastScanLabel}`]
  parts.push(status.running ? '扫描中' : '空闲')
  if (status.error) {
    parts.push(`错误: ${status.error}`)
  }
  return parts.join(' | ')
})

async function handleSave() {
  saving.value = true
  try {
    await saveSettings({
      libraryRoot: formModel.libraryRoot.trim(),
      scanIntervalMinutes: totalMinutes.value,
      folderPattern: {
        enabled: true,
        separator: formModel.separator.trim() || '-',
        authorSegmentIndex: formModel.authorSegmentIndex >= 0 ? formModel.authorSegmentIndex : null,
        titleSegmentIndex: formModel.titleSegmentIndex ?? 1,
        categorySegmentIndex: formModel.categorySegmentIndex ?? 2,
        stripTokens: formModel.stripTokens
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      },
      naming: {
        defaultVolumeName: '默认卷',
        directImageChapterTemplate: formModel.directImageChapterTemplate.trim() || '{count}P',
      },
    })
    message.success('配置已保存并开始扫描')
  } catch (error: any) {
    message.error(error?.message || '保存失败')
  } finally {
    saving.value = false
  }
}
</script>
