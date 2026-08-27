import { watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAppState } from './useAppState'

export function useRouteSync() {
  const route = useRoute()
  const { syncRouteState } = useAppState()

  watch(
    () => route.fullPath,
    () => {
      syncRouteState(route).catch(() => {})
    },
    { immediate: true },
  )
}
