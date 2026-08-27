<template>
  <n-modal
    :show="show"
    preset="card"
    title="选择目录"
    style="width: 680px; max-width: 95vw; border-radius: 16px"
    :mask-closable="true"
    @update:show="$emit('update:show', $event)"
  >
    <n-space vertical size="large">
      <!-- 当前路径 -->
      <n-card size="small" embedded style="border-radius: 10px">
        <n-text depth="3" style="font-size: 12px">当前路径</n-text>
        <n-text strong style="display: block; word-break: break-all; margin-top: 4px">
          {{ currentPath || '请选择挂载点' }}
        </n-text>
      </n-card>

      <!-- 返回上级 -->
      <n-button
        block
        :disabled="loading || parentPath === null"
        @click="navigateUp"
        style="border-radius: 10px"
      >
        <template #icon>
          <n-icon><ArrowBackOutline /></n-icon>
        </template>
        返回上级目录
      </n-button>

      <!-- 目录列表 -->
      <n-spin :show="loading">
        <div v-if="error" style="text-align: center; padding: 24px">
          <n-text type="error">{{ error }}</n-text>
        </div>
        <n-empty v-else-if="!loading && directories.length === 0" description="当前目录下没有子目录" />
        <div v-else style="max-height: 360px; overflow-y: auto; display: grid; gap: 8px">
          <n-button
            v-for="dir in directories"
            :key="dir.path"
            block
            quaternary
            style="justify-content: flex-start; border-radius: 10px; padding: 12px 14px"
            @click="navigateTo(dir.path)"
          >
            <template #icon>
              <n-icon><FolderOutline /></n-icon>
            </template>
            {{ dir.name }}
          </n-button>
        </div>
      </n-spin>
    </n-space>

    <template #footer>
      <n-space justify="end">
        <n-button @click="$emit('update:show', false)">取消</n-button>
        <n-button
          type="primary"
          :disabled="loading || !currentPath"
          @click="handleConfirm"
        >
          选择当前目录
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { NModal, NCard, NButton, NSpace, NText, NIcon, NSpin, NEmpty } from 'naive-ui'
import { ArrowBackOutline, FolderOutline } from '@vicons/ionicons5'
import { api } from '../api'

const props = defineProps<{
  show: boolean
  initialPath: string
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  confirm: [path: string]
}>()

const loading = ref(false)
const error = ref('')
const currentPath = ref('')
const parentPath = ref<string | null>(null)
const directories = ref<{ name: string; path: string }[]>([])

watch(
  () => props.show,
  (visible) => {
    if (visible) {
      loadFolder(props.initialPath || '')
    }
  },
)

async function loadFolder(path: string) {
  loading.value = true
  error.value = ''
  try {
    let payload
    try {
      payload = await api.browseFolders(path || undefined)
    } catch {
      if (path) {
        payload = await api.browseFolders()
      } else {
        throw new Error('无法加载目录')
      }
    }
    currentPath.value = payload.currentPath ?? ''
    parentPath.value = payload.parentPath ?? null
    directories.value = payload.directories ?? []
  } catch (e: any) {
    currentPath.value = ''
    parentPath.value = null
    directories.value = []
    error.value = e?.message || '加载目录失败'
  } finally {
    loading.value = false
  }
}

function navigateTo(path: string) {
  loadFolder(path)
}

function navigateUp() {
  if (parentPath.value !== null) {
    loadFolder(parentPath.value)
  }
}

function handleConfirm() {
  if (currentPath.value) {
    emit('confirm', currentPath.value)
  }
}
</script>
