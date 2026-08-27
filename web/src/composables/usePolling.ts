import { ref, onMounted, onUnmounted } from 'vue'
import { useAppState } from './useAppState'

const POLL_INTERVAL = 30_000

export function usePolling() {
  const { state, refreshAll } = useAppState()
  const isPageVisible = ref(true)
  let timer: ReturnType<typeof setInterval> | null = null

  function startPolling() {
    if (timer) return
    timer = setInterval(() => {
      if (isPageVisible.value && !state.realtimeConnected) {
        refreshAll(false).catch(() => {})
      }
    }, POLL_INTERVAL)
  }

  function stopPolling() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function handleVisibility() {
    isPageVisible.value = !document.hidden
    if (isPageVisible.value) {
      if (!state.realtimeConnected) refreshAll(false).catch(() => {})
      startPolling()
    } else {
      stopPolling()
    }
  }

  onMounted(() => {
    startPolling()
    document.addEventListener('visibilitychange', handleVisibility)
  })

  onUnmounted(() => {
    stopPolling()
    document.removeEventListener('visibilitychange', handleVisibility)
  })

  return { isPageVisible }
}
