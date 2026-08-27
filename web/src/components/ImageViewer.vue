<template>
  <n-modal
    :show="visible"
    :style="{ width: '100vw', height: '100vh', maxWidth: '100vw' }"
    :closable="true"
    :mask-closable="true"
    transform-origin="center"
    @update:show="handleClose"
  >
    <div class="viewer-fullscreen" tabindex="0" ref="viewerRef">
      <!-- 顶部栏 -->
      <div class="viewer-topbar">
        <n-button quaternary circle size="small" @click="handleClose(false)">
          <template #icon><n-icon size="20"><CloseOutline /></n-icon></template>
        </n-button>
        <n-text style="font-size: 14px; font-weight: 500">{{ title }}</n-text>
        <n-text depth="3" style="font-size: 13px">
          {{ currentIndex + 1 }} / {{ pageUrls.length }}
        </n-text>
      </div>

      <!-- 主图区域 -->
      <div
        class="viewer-body"
        @touchstart="handleTouchStart"
        @touchmove="handleTouchMove"
        @touchend="handleTouchEnd"
        @dblclick="handleDoubleTap"
      >
        <n-button
          quaternary
          circle
          size="large"
          :disabled="currentIndex <= 0"
          class="viewer-nav viewer-nav-prev"
          @click="prev"
        >
          <template #icon><n-icon size="28"><ChevronBackOutline /></n-icon></template>
        </n-button>

        <div class="viewer-image-area" ref="imageAreaRef">
          <img
            v-if="pageUrls[currentIndex]"
            :key="pageUrls[currentIndex]"
            :src="pageUrls[currentIndex]"
            :alt="`Page ${currentIndex + 1}`"
            class="viewer-image"
            :style="imageTransformStyle"
            @load="imageLoading = false"
            @error="imageLoading = false"
          />
          <div v-if="imageLoading" class="viewer-loading">
            <n-spin size="large" />
          </div>
        </div>

        <n-button
          quaternary
          circle
          size="large"
          :disabled="currentIndex >= pageUrls.length - 1"
          class="viewer-nav viewer-nav-next"
          @click="next"
        >
          <template #icon><n-icon size="28"><ChevronForwardOutline /></n-icon></template>
        </n-button>
      </div>

      <!-- 页码导航条 -->
      <div class="viewer-pager">
        <n-slider
          :value="currentIndex"
          :min="0"
          :max="pageUrls.length - 1"
          :step="1"
          :tooltip="true"
          :format-tooltip="(v: number) => `${v + 1} / ${pageUrls.length}`"
          style="flex: 1"
          @update:value="goTo"
        />
      </div>

      <!-- 封面选择按钮 -->
      <div v-if="showCoverAction" class="viewer-actions">
        <n-button type="primary" size="small" @click="handleSetCover">
          设为封面 (第 {{ currentIndex + 1 }} 页)
        </n-button>
      </div>
    </div>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onUnmounted, computed } from 'vue'
import { NModal, NButton, NIcon, NText, NSpin, NSlider } from 'naive-ui'
import { ChevronBackOutline, ChevronForwardOutline, CloseOutline } from '@vicons/ionicons5'

const PRELOAD_COUNT = 2
const PROGRESS_DEBOUNCE_MS = 1000

const props = defineProps<{
  visible: boolean
  title: string
  pageUrls: string[]
  chapterId: string
  initialIndex?: number
  showCoverAction?: boolean
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  'set-cover': [chapterId: string, pageIndex: number]
  'progress-update': [chapterId: string, pageIndex: number, totalPages: number]
}>()

const currentIndex = ref(0)
const imageLoading = ref(false)
const viewerRef = ref<HTMLElement | null>(null)
const imageAreaRef = ref<HTMLElement | null>(null)

// ===== 缩放状态 =====
const zoomScale = ref(1)
const zoomTranslateX = ref(0)
const zoomTranslateY = ref(0)

const imageTransformStyle = computed(() => {
  if (zoomScale.value === 1) return {}
  return {
    transform: `scale(${zoomScale.value}) translate(${zoomTranslateX.value}px, ${zoomTranslateY.value}px)`,
    transformOrigin: 'center center',
  }
})

function resetZoom() {
  zoomScale.value = 1
  zoomTranslateX.value = 0
  zoomTranslateY.value = 0
}

// ===== 触摸手势 =====
let touchStartX = 0
let touchStartY = 0
let touchStartTime = 0
let isSwiping = false
let pinchStartDistance = 0
let pinchStartScale = 1

function getTouchDistance(touches: TouchList) {
  if (touches.length < 2) return 0
  const dx = touches[0].clientX - touches[1].clientX
  const dy = touches[0].clientY - touches[1].clientY
  return Math.sqrt(dx * dx + dy * dy)
}

function handleTouchStart(e: TouchEvent) {
  if (e.touches.length === 2) {
    // 双指缩放开始
    pinchStartDistance = getTouchDistance(e.touches)
    pinchStartScale = zoomScale.value
    isSwiping = false
    return
  }

  if (e.touches.length === 1) {
    touchStartX = e.touches[0].clientX
    touchStartY = e.touches[0].clientY
    touchStartTime = Date.now()
    isSwiping = true
  }
}

function handleTouchMove(e: TouchEvent) {
  if (e.touches.length === 2) {
    // 双指缩放
    const currentDistance = getTouchDistance(e.touches)
    if (pinchStartDistance > 0) {
      const newScale = Math.max(1, Math.min(5, pinchStartScale * (currentDistance / pinchStartDistance)))
      zoomScale.value = newScale
      if (newScale <= 1) {
        zoomTranslateX.value = 0
        zoomTranslateY.value = 0
      }
    }
    e.preventDefault()
    return
  }

  // 缩放状态下拖动平移
  if (zoomScale.value > 1 && e.touches.length === 1) {
    const dx = e.touches[0].clientX - touchStartX
    const dy = e.touches[0].clientY - touchStartY
    zoomTranslateX.value += dx / zoomScale.value
    zoomTranslateY.value += dy / zoomScale.value
    touchStartX = e.touches[0].clientX
    touchStartY = e.touches[0].clientY
    isSwiping = false
    e.preventDefault()
  }
}

function handleTouchEnd(e: TouchEvent) {
  if (!isSwiping || zoomScale.value > 1) return

  const dx = (e.changedTouches[0]?.clientX ?? touchStartX) - touchStartX
  const dy = (e.changedTouches[0]?.clientY ?? touchStartY) - touchStartY
  const elapsed = Date.now() - touchStartTime
  const absDx = Math.abs(dx)
  const absDy = Math.abs(dy)

  // 水平滑动翻页：滑动距离 > 50px，水平 > 垂直，时间 < 500ms
  if (absDx > 50 && absDx > absDy * 1.5 && elapsed < 500) {
    if (dx > 0) prev()
    else next()
  }

  isSwiping = false
}

function handleDoubleTap() {
  if (zoomScale.value > 1) {
    resetZoom()
  } else {
    zoomScale.value = 2.5
  }
}

// ===== 图片预加载 =====
const preloadedUrls = new Set<string>()

function preloadImages(centerIndex: number) {
  for (let offset = -PRELOAD_COUNT; offset <= PRELOAD_COUNT; offset++) {
    const idx = centerIndex + offset
    if (idx < 0 || idx >= props.pageUrls.length || idx === centerIndex) continue
    const url = props.pageUrls[idx]
    if (url && !preloadedUrls.has(url)) {
      preloadedUrls.add(url)
      const img = new Image()
      img.src = url
    }
  }
}

// ===== 阅读进度保存（防抖） =====
let progressTimer: ReturnType<typeof setTimeout> | null = null

function saveProgressDebounced() {
  if (progressTimer) clearTimeout(progressTimer)
  progressTimer = setTimeout(() => {
    emit('progress-update', props.chapterId, currentIndex.value + 1, props.pageUrls.length)
  }, PROGRESS_DEBOUNCE_MS)
}

// ===== 核心逻辑 =====
watch(() => props.visible, (v) => {
  if (v) {
    currentIndex.value = props.initialIndex ?? 0
    imageLoading.value = true
    resetZoom()
    preloadedUrls.clear()
    nextTick(() => {
      viewerRef.value?.focus()
      preloadImages(currentIndex.value)
    })
  } else {
    // 关闭时立即保存进度
    if (progressTimer) clearTimeout(progressTimer)
    if (props.pageUrls.length > 0) {
      emit('progress-update', props.chapterId, currentIndex.value + 1, props.pageUrls.length)
    }
  }
})

watch(currentIndex, (newIndex) => {
  imageLoading.value = true
  resetZoom()
  preloadImages(newIndex)
  saveProgressDebounced()
})

function prev() { if (currentIndex.value > 0) currentIndex.value-- }
function next() { if (currentIndex.value < props.pageUrls.length - 1) currentIndex.value++ }
function goTo(index: number) { currentIndex.value = index }

function handleClose(show: boolean) {
  if (!show) emit('update:visible', false)
}

function handleSetCover() {
  emit('set-cover', props.chapterId, currentIndex.value + 1)
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft' || e.key === 'a') prev()
  else if (e.key === 'ArrowRight' || e.key === 'd') next()
  else if (e.key === 'Escape') handleClose(false)
}

function globalKeyHandler(e: KeyboardEvent) {
  if (!props.visible) return
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Escape') {
    e.preventDefault()
    handleKeydown(e)
  }
}

onMounted(() => document.addEventListener('keydown', globalKeyHandler))
onUnmounted(() => {
  document.removeEventListener('keydown', globalKeyHandler)
  if (progressTimer) clearTimeout(progressTimer)
})
</script>

<style scoped>
.viewer-fullscreen {
  width: 100vw;
  height: 100vh;
  background: var(--md-surface, var(--n-color, #000));
  display: flex;
  flex-direction: column;
  outline: none;
}

.viewer-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  
  background-color: rgba(255, 255, 255, 0.96);
  border-bottom: 1px solid rgba(0,0,0,0.08);
  flex-shrink: 0;
  z-index: 2;
}
@media (prefers-color-scheme: dark) {
  .viewer-topbar {
    background-color: rgba(30, 30, 30, 0.96);
  }
}

.viewer-body {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  min-height: 0;
  overflow: hidden;
  touch-action: none;
}

.viewer-nav {
  flex-shrink: 0;
}

.viewer-image-area {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  height: 100%;
  position: relative;
  overflow: hidden;
}

.viewer-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
  transition: transform var(--md-duration-short) var(--md-easing-standard);
  user-select: none;
  -webkit-user-drag: none;
}

.viewer-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
}

.viewer-pager {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 24px;
  flex-shrink: 0;
  
  background-color: rgba(255, 255, 255, 0.96);
  border-top: 1px solid rgba(0,0,0,0.08);
  z-index: 2;
}
@media (prefers-color-scheme: dark) {
  .viewer-pager {
    background-color: rgba(30, 30, 30, 0.96);
  }
}

.viewer-actions {
  display: flex;
  justify-content: center;
  padding: 8px 16px;
  flex-shrink: 0;
}

@media (max-width: 768px) {
  .viewer-nav {
    display: none;
  }

  .viewer-pager {
    padding: 8px 12px;
  }
}
</style>
