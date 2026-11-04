import type { Page } from '@playwright/test'

export const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')
const categories = { auto: [], folder: ['Fixture'], manual: [], effective: ['Fixture'] }
export const fixtureItems = Array.from({ length: 80 }, (_, index) => ({
  id: `series-${index + 1}`, title: `Series ${String(index + 1).padStart(3, '0')}`,
  author: null, description: null, sourceFolderName: `series-${index + 1}`, sourceKey: `series/${index + 1}`,
  counts: { volumes: 1, chapters: 1, pages: 5000 }, totalBytes: 0, categories, tags: [], metadata: {},
  coverUrl: null, thumbCoverUrl: null, latestChapterTitle: 'Chapter 1', favorite: false, readProgress: null, readStatus: 'unread',
}))

export async function installCatalog(page: Page, options: { chapterCount?: number; volumeCount?: number } = {}) {
  const counters = { state: 0, list: 0, detail: 0, chapters: 0, favorite: 0, images: 0 }
  const chapterCount = options.chapterCount ?? 1
  const volumeCount = options.volumeCount ?? 1
  await page.addInitScript(() => {
    const nativeSetInterval = window.setInterval.bind(window)
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      return nativeSetInterval(handler, timeout === 30_000 ? 50 : timeout, ...args)
    }) as typeof window.setInterval
    class StableWebSocket extends EventTarget {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      readyState = 0
      constructor(readonly url: string | URL) {
        super()
        setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) }, 0)
      }
      send() {}
      close() { this.readyState = 3 }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: StableWebSocket })
  })
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname
    let payload: unknown = { ok: true }
    if (pathname === '/api/state') {
      counters.state++
      payload = {
        scanStatus: { running: false, trigger: null, startedAt: null, finishedAt: null, error: null }, scanProgress: null,
        summary: { seriesCount: 50_000, volumeCount: 50_000, chapterCount: 50_000, pageCount: 250_000_000, totalBytes: 0, categories: ['Fixture'] },
        issues: [], lastScanAt: '2026-08-10T00:00:00.000Z', lastScanLabel: '2026-08-10', revision: 1, resourceProfile: { name: 'lite', requested: 'lite' },
      }
    } else if (pathname === '/api/settings') {
      payload = {
        libraryRoot: '/library', scanIntervalMinutes: 15, autoExportToMihon: false,
        folderPattern: { enabled: false, separator: '-', authorSegmentIndex: null, titleSegmentIndex: 0, categorySegmentIndex: 0, stripTokens: [] },
        naming: { defaultVolumeName: 'Default Volume', directImageChapterTemplate: '{count}P' }, categoryFolders: [],
      }
    } else if (pathname === '/api/categories') payload = { items: ['Fixture'], revision: 1 }
    else if (pathname === '/api/tags') payload = { items: [] }
    else if (pathname === '/api/series') {
      counters.list++
      payload = { items: fixtureItems, total: 50_000, page: 1, pageSize: 80, totalPages: 625, revision: 1 }
    } else if (pathname.endsWith('/favorite')) { counters.favorite++; payload = { favorited: true } }
    else if (/^\/api\/series\/series-\d+$/.test(pathname)) {
      counters.detail++
      const id = pathname.split('/').at(-1)!
      payload = {
        ...fixtureItems.find((entry) => entry.id === id), counts: { volumes: volumeCount, chapters: chapterCount, pages: chapterCount * 5000 },
        volumes: Array.from({ length: volumeCount }, (_, volume) => ({
          id: `${id}-volume-${volume}`, title: `Volume ${volume + 1}`, synthetic: false,
          chapters: Array.from({ length: Math.ceil(chapterCount / volumeCount) }, (_, index) => {
            const chapter = volume * Math.ceil(chapterCount / volumeCount) + index + 1
            return { id: `${id}-chapter-${chapter}`, title: `Chapter ${chapter}`, pageCount: 5000 }
          }),
        })),
      }
    } else if (pathname.endsWith('/metadata')) {
      const id = pathname.split('/')[3]
      payload = { autoTitle: id, autoAuthor: null, override: { title: `${id} metadata` }, effective: { title: id, author: null, description: null } }
    } else if (pathname.endsWith('/recommendations')) payload = { items: [] }
    else if (/^\/api\/chapters\/.+\/pages$/.test(pathname)) {
      counters.chapters++
      const id = pathname.split('/')[3]
      payload = { chapterId: id, pageCount: 5000, urlTemplate: `/media/chapter/${id}/{pageIndex}` }
    }
    await route.fulfill({ json: payload })
  })
  await page.route('**/media/**', async (route) => {
    counters.images++
    await route.fulfill({ contentType: 'image/png', body: tinyPng, headers: { 'Cache-Control': 'public, max-age=3600' } })
  })
  return counters
}

export async function navigateToSeries(page: Page, id: string) {
  await page.evaluate((seriesId) => {
    history.pushState({}, '', `/series/${seriesId}`)
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
  }, id)
}
