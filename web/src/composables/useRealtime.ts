import { onMounted, onUnmounted } from 'vue'
import { useAppState } from './useAppState'

function getWebSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}

export function useRealtime() {
  const {
    refreshAll,
    restoreActiveDetail,
    setLiveScanState,
    setRealtimeConnected,
    setWatcherStatus,
  } = useAppState()

  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectDelay = 1000
  let reconnectAttempts = 0
  const MAX_RECONNECT_ATTEMPTS = 30
  let refreshTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleRefresh() {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      refreshAll(false)
        .then(() => restoreActiveDetail())
        .catch(() => {})
    }, 200)
  }

  function connect() {
    if (socket) return

    socket = new WebSocket(getWebSocketUrl())

    socket.addEventListener('open', () => {
      reconnectDelay = 1000
      reconnectAttempts = 0
      setRealtimeConnected(true)
    })

    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data)
        switch (message.event) {
          case 'scan:update':
            setLiveScanState(message.payload?.status ?? null, message.payload?.progress ?? null)
            break
          case 'library:changed':
            scheduleRefresh()
            break
          case 'watcher:status':
            setWatcherStatus(message.payload ?? null)
            break
          case 'watcher:event':
            // keep watcher panel fresh only when already opened once
            break
          default:
            break
        }
      } catch {
        // ignore malformed payloads
      }
    })

    socket.addEventListener('close', () => {
      socket = null
      setRealtimeConnected(false)
      setLiveScanState(null, null)
      reconnectAttempts++
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.warn(`[ws] 已达最大重连次数 (${MAX_RECONNECT_ATTEMPTS})，停止重连`)
        return
      }
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 15000)
    })

    socket.addEventListener('error', () => {
      socket?.close()
    })
  }

  onMounted(() => {
    connect()
  })

  onUnmounted(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (refreshTimer) clearTimeout(refreshTimer)
    if (socket) {
      socket.close()
      socket = null
    }
  })
}
