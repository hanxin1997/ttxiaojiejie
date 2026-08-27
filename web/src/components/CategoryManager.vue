<template>
  <n-card title="分类库" size="small" style="border-radius: var(--md-shape-sm)">
    <template #header-extra>
      <n-space>
        <n-button size="small" :disabled="!state.categoryDirty" :loading="applying" @click="handleApply">
          {{ state.categoryDirty ? '应用变更' : '已同步' }}
        </n-button>
        <n-button size="small" type="primary" @click="openAdd">
          添加分类
        </n-button>
      </n-space>
    </template>

    <n-text depth="3" style="display: block; margin-bottom: 12px; font-size: 12px; line-height: 1.6">
      每个分类绑定一个目录，扫描时自动递归查找包含图片的叶子目录作为独立漫画。
      保存后，该目录下扫描出的漫画会自动归入对应分类。
    </n-text>

    <n-empty
      v-if="state.categoryDrafts.length === 0"
      description="还没有配置分类"
    />

    <div v-else style="display: grid; gap: 10px">
      <n-card
        v-for="(item, index) in state.categoryDrafts"
        :key="index"
        size="small"
        embedded
        style="border-radius: var(--md-shape-sm)"
      >
        <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px">
          <div style="flex: 1; min-width: 0">
            <n-text strong>{{ item.name }}</n-text>
            <n-text depth="3" style="display: block; margin-top: 2px; font-size: 12px; word-break: break-all">
              {{ formatFolderDisplay(item.folder) }}
            </n-text>
          </div>
          <n-space size="small">
            <n-button size="tiny" @click="openEdit(index)">编辑</n-button>
            <n-button size="tiny" type="error" quaternary @click="handleRemove(index)">删除</n-button>
          </n-space>
        </div>
      </n-card>
    </div>

    <CategoryDialog
      v-model:show="dialogVisible"
      :editing-index="editingIndex"
      :initial-name="editingName"
      :initial-folder="editingFolder"
      :library-root="state.meta?.settings?.libraryRoot ?? ''"
      @confirm="handleDialogConfirm"
    />
  </n-card>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NCard, NEmpty, NSpace, NText, useDialog, useMessage } from 'naive-ui'
import CategoryDialog from './CategoryDialog.vue'
import { useAppState, type CategoryDraft } from '../composables/useAppState'

const {
  state,
  addCategoryDraft,
  removeCategoryDraft,
  saveCategoryFolders,
  updateCategoryDraft,
} = useAppState()

const message = useMessage()
const dialog = useDialog()
const applying = ref(false)

const dialogVisible = ref(false)
const editingIndex = ref<number | null>(null)
const editingName = ref('')
const editingFolder = ref('')

function isAbsolutePath(value: string) {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}

function formatFolderDisplay(folder: string) {
  const raw = folder.trim()
  if (!raw) return '未选择目录'
  if (isAbsolutePath(raw)) return raw
  const root = state.meta?.settings?.libraryRoot ?? ''
  return root ? `${root.replace(/[\\/]+$/, '')}/${raw}` : raw
}

function openAdd() {
  editingIndex.value = null
  editingName.value = ''
  editingFolder.value = ''
  dialogVisible.value = true
}

function openEdit(index: number) {
  const item = state.categoryDrafts[index]
  if (!item) return
  editingIndex.value = index
  editingName.value = item.name
  editingFolder.value = item.folder
  dialogVisible.value = true
}

function handleDialogConfirm(data: CategoryDraft) {
  if (editingIndex.value !== null) {
    updateCategoryDraft(editingIndex.value, data)
  } else {
    addCategoryDraft(data)
  }
  dialogVisible.value = false
}

function handleRemove(index: number) {
  dialog.warning({
    title: '确认删除',
    content: `确定要删除分类 ${state.categoryDrafts[index]?.name ?? ''} 吗？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      removeCategoryDraft(index)
    },
  })
}

async function handleApply() {
  applying.value = true
  try {
    await saveCategoryFolders()
    message.success('分类已保存并开始扫描')
  } catch (error: any) {
    message.error(error?.message || '保存失败')
  } finally {
    applying.value = false
  }
}
</script>
