import { expect, test } from '@playwright/test'
import { installCatalog } from './fixtures'

test('large catalog stays bounded and refreshes only once per user action', async ({ page }) => {
  const counters = await installCatalog(page)
  await page.goto('/library')
  await expect(page.locator('.series-card').first()).toBeVisible()
  expect(await page.locator('*').count()).toBeLessThanOrEqual(1500)
  const initialListRequests = counters.list
  await page.locator('.series-card').first().locator('.favorite-btn').click()
  await expect.poll(() => counters.favorite).toBe(1)
  expect(counters.list).toBe(initialListRequests)
  expect(counters.state).toBe(1)
  await page.locator('.series-card').first().click()
  await expect(page).toHaveURL(/\/series\/series-1$/)
  await expect(page.locator('.chapter-row').getByText('5000 页', { exact: true })).toBeVisible()
  expect(counters.detail).toBe(1)
  await page.getByRole('button', { name: '浏览', exact: true }).click()
  await expect(page.locator('.viewer-fullscreen')).toBeVisible()
  await expect.poll(() => page.locator('.viewer-image').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1)
  expect(counters.chapters).toBe(1)
  expect(await page.locator('*').count()).toBeLessThanOrEqual(1500)
  await expect.poll(() => counters.images).toBe(3)
  // Accelerated fallback polling must remain idle while the WebSocket is connected.
  await page.waitForTimeout(250)
  expect(counters.state).toBe(1)
})

for (const volumeCount of [1, 5000]) {
  test(`5000 chapters across ${volumeCount} volumes keep detail DOM bounded`, async ({ page }) => {
    await installCatalog(page, { chapterCount: 5000, volumeCount })
    await page.goto('/series/series-1')
    await expect(page.locator('.chapter-row').first()).toBeVisible()
    expect(await page.locator('.volume-card').count()).toBe(1)
    expect(await page.locator('.chapter-row').count()).toBeLessThanOrEqual(25)
    expect(await page.locator('*').count()).toBeLessThanOrEqual(1500)
    const pagination = page.locator(volumeCount === 1 ? '.volume-card .n-pagination' : '.volume-stack > .n-pagination')
    await pagination.locator('input').fill(volumeCount === 1 ? '200' : '5000')
    await pagination.locator('input').press('Enter')
    await expect(page.locator('.chapter-row').getByText('Chapter 5000', { exact: true })).toBeVisible()
  })
}

test('slow image prefetch stays bounded during 30 page jumps and cancels on close', async ({ page }) => {
  await installCatalog(page)
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window)
    const stats = { active: 0, peak: 0, aborted: 0 }
    Object.assign(window, { readerRequestStats: stats })
    window.fetch = async (input, options) => {
      if (!String(input).includes('/media/')) return originalFetch(input, options)
      stats.peak = Math.max(stats.peak, ++stats.active)
      // Send headers now and leave the response body open until the reader cancels it.
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([137, 80, 78, 71]))
          options?.signal?.addEventListener('abort', () => {
            stats.active--; stats.aborted++
            controller.error(new DOMException('Cancelled', 'AbortError'))
          }, { once: true })
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'image/png' } })
    }
  })
  await page.goto('/series/series-1')
  await page.getByRole('button', { name: '浏览', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).readerRequestStats.active)).toBe(1)
  for (let index = 0; index < 30; index++) await page.keyboard.press('ArrowRight')
  await expect(page.locator('.viewer-image')).toHaveAttribute('alt', 'Page 31')
  await expect.poll(() => page.locator('.viewer-image').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1)
  await expect.poll(() => page.evaluate(() => (window as any).readerRequestStats.active)).toBe(1)
  await page.getByLabel('关闭阅读').click()
  await expect(page.locator('.viewer-image')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).readerRequestStats.active)).toBe(0)
  const stats = await page.evaluate(() => (window as any).readerRequestStats)
  expect(stats.peak).toBe(1)
  expect(stats.aborted).toBeGreaterThan(0)
})

test('eink selection requests server grayscale, suppresses motion and persists locally', async ({ page }) => {
  await installCatalog(page)
  await page.goto('/series/series-1')
  await page.getByRole('button', { name: '浏览', exact: true }).click()
  await page.getByLabel('阅读画质').selectOption('eink')
  await expect(page.locator('.viewer-image')).toHaveAttribute('src', /variant=reader-lite-mono$/)
  await expect.poll(() => page.locator('.viewer-image').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1)
  expect(await page.locator('.viewer-image').evaluate((image) => getComputedStyle(image).transitionDuration)).toBe('0s')
  await page.reload()
  await page.getByRole('button', { name: '浏览', exact: true }).click()
  await expect(page.getByLabel('阅读画质')).toHaveValue('eink')
  await expect(page.locator('.viewer-image')).toHaveAttribute('src', /variant=reader-lite-mono$/)
})
