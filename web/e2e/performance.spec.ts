import { expect, test } from '@playwright/test'

const categories = { auto: [], folder: ['Fixture'], manual: [], effective: ['Fixture'] }
const counts = { volumes: 1, chapters: 1, pages: 5000 }
const fixtureItems = Array.from({ length: 80 }, (_, index) => ({
  id: `series-${index + 1}`,
  title: `Series ${String(index + 1).padStart(3, '0')}`,
  author: null,
  description: null,
  sourceFolderName: `series-${index + 1}`,
  sourceKey: `series/${index + 1}`,
  counts,
  totalBytes: 0,
  categories,
  tags: [],
  metadata: {},
  coverUrl: null,
  thumbCoverUrl: null,
  latestChapterTitle: 'Chapter 1',
  favorite: false,
  readProgress: null,
  readStatus: 'unread',
}))

test('large catalog stays bounded and refreshes only once per user action', async ({ page }) => {
  let stateRequests = 0
  let listRequests = 0
  let detailRequests = 0
  let chapterPageRequests = 0
  let favoriteRequests = 0

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
      readonly url: string
      readyState = StableWebSocket.CONNECTING

      constructor(url: string | URL) {
        super()
        this.url = String(url)
        setTimeout(() => {
          this.readyState = StableWebSocket.OPEN
          this.dispatchEvent(new Event('open'))
        }, 0)
      }

      send() {}

      close() {
        this.readyState = StableWebSocket.CLOSED
      }
    }

    Object.defineProperty(window, 'WebSocket', { configurable: true, value: StableWebSocket })
  })

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const { pathname } = url
    let payload: unknown = { ok: true }

    if (pathname === '/api/state') {
      stateRequests += 1
      payload = {
        scanStatus: { running: false, trigger: null, startedAt: null, finishedAt: null, error: null },
        scanProgress: null,
        summary: { seriesCount: 50_000, volumeCount: 50_000, chapterCount: 50_000, pageCount: 250_000_000, totalBytes: 0, categories: ['Fixture'] },
        issues: [],
        lastScanAt: '2026-08-10T00:00:00.000Z',
        lastScanLabel: '2026-08-10',
        revision: 1,
        resourceProfile: { name: 'lite', requested: 'lite' },
      }
    } else if (pathname === '/api/settings') {
      payload = {
        libraryRoot: '/library',
        scanIntervalMinutes: 15,
        autoExportToMihon: false,
        scanMode: 'flat',
        folderPattern: { enabled: false, separator: '-', authorSegmentIndex: null, titleSegmentIndex: 0, categorySegmentIndex: 0, stripTokens: [] },
        naming: { defaultVolumeName: 'Default Volume', directImageChapterTemplate: '{count}P' },
        categoryFolders: [],
      }
    } else if (pathname === '/api/categories') {
      payload = { items: ['Fixture'], revision: 1 }
    } else if (pathname === '/api/tags') {
      payload = { items: [] }
    } else if (pathname === '/api/series') {
      listRequests += 1
      payload = { items: fixtureItems, total: 50_000, page: 1, pageSize: 80, totalPages: 625, revision: 1 }
    } else if (pathname === '/api/series/series-1/favorite') {
      favoriteRequests += 1
      payload = { favorited: true }
    } else if (pathname === '/api/series/series-1') {
      detailRequests += 1
      payload = {
        ...fixtureItems[0],
        volumes: [{ id: 'volume-1', title: 'Volume 1', synthetic: false, chapters: [{ id: 'chapter-1', title: 'Chapter 1', pageCount: 5000 }] }],
      }
    } else if (pathname === '/api/series/series-1/metadata') {
      payload = { autoTitle: 'Series 001', autoAuthor: null, override: {}, effective: { title: 'Series 001', author: null, description: null } }
    } else if (pathname === '/api/series/series-1/recommendations') {
      payload = { items: [] }
    } else if (pathname === '/api/chapters/chapter-1/pages') {
      chapterPageRequests += 1
      payload = { chapterId: 'chapter-1', pageCount: 5000, urlTemplate: '/media/chapter/chapter-1/{pageIndex}' }
    }

    await route.fulfill({ json: payload })
  })
  await page.route('**/media/**', (route) => route.fulfill({ status: 204 }))

  await page.goto('/library')
  await expect(page.locator('.series-card').first()).toBeVisible()
  expect(await page.locator('*').count()).toBeLessThanOrEqual(1500)

  const listRequestsBeforeMutation = listRequests
  await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === '/api/series/series-1/favorite'),
    page.locator('.series-card').first().locator('.favorite-btn').click(),
  ])
  expect(favoriteRequests).toBe(1)
  expect(listRequests).toBe(listRequestsBeforeMutation)
  expect(stateRequests).toBe(1)

  await page.locator('.series-card').first().click()
  await expect(page).toHaveURL(/\/series\/series-1$/)
  await expect(page.locator('.chapter-row').getByText('5000 页', { exact: true })).toBeVisible()
  expect(detailRequests).toBe(1)

  await page.getByRole('button', { name: '浏览' }).click()
  await expect(page.locator('.viewer-fullscreen')).toBeVisible()
  expect(chapterPageRequests).toBe(1)
  expect(await page.locator('.viewer-fullscreen').count()).toBe(1)
  expect(await page.locator('*').count()).toBeLessThanOrEqual(1500)

  await page.waitForTimeout(250)
  expect(stateRequests).toBe(1)
})
