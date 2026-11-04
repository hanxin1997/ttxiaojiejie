export type ReadingMode = 'original' | 'balanced' | 'lite' | 'eink'

export function readerImageUrl(original: string, mode: ReadingMode): string {
  if (!original) return ''
  const url = new URL(original, 'https://reader.invalid')
  const variant = { original: '', balanced: 'reader-balanced', lite: 'reader-lite', eink: 'reader-lite-mono' }[mode]
  if (variant) url.searchParams.set('variant', variant)
  else url.searchParams.delete('variant')
  return /^https?:\/\//.test(original) ? url.href : `${url.pathname}${url.search}${url.hash}`
}

/** One speculative request at a time; browser HTTP cache owns the bytes, not decoded Images. */
export function createReaderPrefetcher(fetchImage: typeof fetch = fetch) {
  let wanted: string[] = []
  const completed = new Set<string>()
  const running = new Map<string, AbortController>()

  function pump() {
    if (running.size) return
    const url = wanted.find((item) => !completed.has(item))
    if (!url) return
    const controller = new AbortController()
    running.set(url, controller)
    void (async () => {
      try {
        const response = await fetchImage(url, { signal: controller.signal, cache: 'force-cache' })
        if (!response.ok) {
          await response.body?.cancel()
          return
        }
        // Drain in bounded stream chunks. No canvas, pixels, Blob or full-image buffer is retained.
        const reader = response.body?.getReader()
        if (reader) {
          try { while (!(await reader.read()).done) { /* HTTP cache consumes the stream. */ } }
          finally { reader.releaseLock() }
        }
      } catch {
        // Speculative failures never interrupt the current page.
      } finally {
        running.delete(url)
        if (wanted.includes(url) && !controller.signal.aborted) completed.add(url)
        pump()
      }
    })()
  }

  return {
    update(urls: string[]) {
      // The lookahead window is hard-capped even if a caller passes an entire chapter.
      wanted = [...new Set(urls.filter(Boolean))].slice(0, 2)
      for (const [url, controller] of running) if (!wanted.includes(url)) controller.abort()
      for (const url of completed) if (!wanted.includes(url)) completed.delete(url)
      pump()
    },
    clear() {
      wanted = []
      completed.clear()
      for (const controller of running.values()) controller.abort()
    },
  }
}
