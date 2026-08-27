<template>
  <n-modal
    :show="show"
    preset="card"
    :title="editingIndex !== null ? '编辑分类' : '添加分类'"
    style="width: 520px; max-width: 95vw; border-radius: var(--md-shape-md)"
    :mask-closable="true"
    @update:show="$emit('update:show', $event)"
  >
    <n-form label-placement="top" size="small">
      <n-form-item label="分类名称">
        <n-input
          ref="nameInputRef"
          v-model:value="localName"
          placeholder="例如：清纯写真"
        />
      </n-form-item>

      <n-form-item label="目录路径">
        <n-input-group>
          <n-input
            v-model:value="displayFolder"
            placeholder="/library/清纯"
            readonly
            style="flex: 1"
          />
          <n-button @click="showBrowser = true">浏览</n-button>
        </n-input-group>
      </n-form-item>
    </n-form>

    <template #footer>
      <n-space justify="end">
        <n-button @click="$emit('update:show', false)">取消</n-button>
        <n-button
          type="primary"
          :disabled="!localName.trim() || !localFolder.trim()"
          @click="handleConfirm"
        >
          {{ editingIndex !== null ? '更新分类' : '保存分类' }}
        </n-button>
      </n-space>
    </template>

    <FolderBrowser
      v-model:show="showBrowser"
      :initial-path="localFolder"
      @confirm="handleFolderSelect"
    />
  </n-modal>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  NButton,
  NForm,
  NFormItem,
  NInput,
  NInputGroup,
  NModal,
  NSpace,
} from 'naive-ui'
import FolderBrowser from './FolderBrowser.vue'

const props = defineProps<{
  show: boolean
  editingIndex: number | null
  initialName: string
  initialFolder: string
  libraryRoot: string
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  confirm: [data: { name: string; folder: string }]
}>()

const localName = ref('')
const localFolder = ref('')
const showBrowser = ref(false)
const nameInputRef = ref<any>(null)

function isAbsolutePath(value: string) {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}

function resolveFolderForBrowse(folder: string): string {
  const raw = folder.trim()
  if (!raw) return ''
  if (isAbsolutePath(raw)) return raw
  return props.libraryRoot ? `${props.libraryRoot.replace(/[\\/]+$/, '')}/${raw}` : raw
}

const displayFolder = computed(() => {
  return resolveFolderForBrowse(localFolder.value) || '未选择目录'
})

watch(
  () => props.show,
  (visible) => {
    if (!visible) return
    localName.value = props.initialName
    localFolder.value = resolveFolderForBrowse(props.initialFolder)
    nextTick(() => nameInputRef.value?.focus())
  },
)

function handleFolderSelect(nextPath: string) {
  localFolder.value = nextPath
  showBrowser.value = false
}

function handleConfirm() {
  let folder = localFolder.value.trim()
  const root = props.libraryRoot.replace(/[\\/]+$/, '')

  if (root && folder.startsWith(`${root}/`)) {
    folder = folder.slice(root.length + 1)
  } else if (root && folder.startsWith(`${root}\\`)) {
    folder = folder.slice(root.length + 1)
  }

  emit('confirm', {
    name: localName.value.trim(),
    folder,
  })
}
</script>
