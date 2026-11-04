import { expect, test } from '@playwright/test'
import { installCatalog, navigateToSeries } from './fixtures'

test('navigation cancels a detail body even after its response headers have arrived', async ({ page }) => {
  await installCatalog(page)
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window)
    Object.assign(window, { slowBodyStarted: false, slowBodyAborted: false })
    window.fetch = async (input, options) => {
      if (String(input) !== '/api/series/series-1') return originalFetch(input, options)
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":"series-1",'))
          Object.assign(window, { slowBodyStarted: true })
          options?.signal?.addEventListener('abort', () => {
            Object.assign(window, { slowBodyAborted: true })
            controller.error(new DOMException('Cancelled', 'AbortError'))
          }, { once: true })
        },
      })
      return new Response(body, { headers: { 'Content-Type': 'application/json' } })
    }
  })
  await page.goto('/series/series-1')
  await expect.poll(() => page.evaluate(() => (window as any).slowBodyStarted)).toBe(true)
  await navigateToSeries(page, 'series-2')
  await expect(page.locator('.detail-title-row')).toContainText('Series 002')
  await expect.poll(() => page.evaluate(() => (window as any).slowBodyAborted)).toBe(true)
  await expect(page.locator('.chapter-row').first()).toBeVisible()
})

test('late metadata and recommendations never overwrite the newly selected series', async ({ page }) => {
  await installCatalog(page)
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window)
    const releases: Array<() => void> = []
    Object.assign(window, { oldDetailReleases: releases })
    window.fetch = async (input, options) => {
      const url = String(input)
      if (!url.startsWith('/api/series/series-1/metadata') && !url.startsWith('/api/series/series-1/recommendations')) return originalFetch(input, options)
      // An already completed/cached response can race with cancellation. Intentionally deliver it late.
      await new Promise<void>((resolve) => releases.push(resolve))
      const payload = url.includes('/metadata')
        ? { override: { title: 'stale A metadata' } }
        : { items: [{ score: 1, reasons: [], series: { id: 'stale', title: 'stale A recommendation' } }] }
      const response = new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })
      const json = response.json.bind(response)
      response.json = async () => {
        const result = await json()
        Object.assign(window, { oldResponsesRead: ((window as any).oldResponsesRead ?? 0) + 1 })
        return result
      }
      return response
    }
  })
  await page.goto('/series/series-1')
  await expect.poll(() => page.evaluate(() => (window as any).oldDetailReleases.length)).toBe(2)
  await navigateToSeries(page, 'series-2')
  await expect(page.locator('.detail-title-row')).toContainText('Series 002')
  await page.getByText('编辑元数据', { exact: true }).click()
  await expect(page.getByPlaceholder('标题覆盖（留空使用自动解析）')).toHaveValue('series-2 metadata')
  await page.evaluate(() => (window as any).oldDetailReleases.forEach((release: () => void) => release()))
  await expect.poll(() => page.evaluate(() => (window as any).oldResponsesRead)).toBe(2)
  await expect(page.getByPlaceholder('标题覆盖（留空使用自动解析）')).toHaveValue('series-2 metadata')
  await expect(page.getByText('stale A recommendation', { exact: true })).toHaveCount(0)
})
