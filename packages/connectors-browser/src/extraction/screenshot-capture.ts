import type { Page } from 'playwright'
import type { ScreenshotResult } from '../types.js'

/**
 * Maximum full-page screenshot height: viewport height * 3.
 * Prevents multi-MB captures on very long pages.
 */
const MAX_HEIGHT_MULTIPLIER = 3

export async function captureScreenshot(
  page: Page,
  fullPage = true,
): Promise<ScreenshotResult> {
  const viewport = page.viewportSize()
  const viewportHeight = viewport?.height ?? 720
  const viewportWidth = viewport?.width ?? 1280
  if (!fullPage) {
    const buffer = await page.screenshot({
      fullPage: false,
      type: 'jpeg',
      quality: 80,
    })
    return {
      buffer,
      mimeType: 'image/jpeg',
      width: viewportWidth,
      height: viewportHeight,
    }
  }

  const maxHeight = viewportHeight * MAX_HEIGHT_MULTIPLIER
  // Clip the capture area if the page is taller than the cap
  const pageHeight = await page.evaluate(() => Math.max(
    document.body?.scrollHeight ?? 0,
    document.documentElement?.scrollHeight ?? 0,
  ))
  const needsClip = pageHeight > maxHeight

  const buffer = await page.screenshot({
    fullPage: !needsClip,
    type: 'jpeg',
    quality: 80,
    ...(needsClip
      ? { clip: { x: 0, y: 0, width: viewportWidth, height: maxHeight } }
      : {}),
  })

  return {
    buffer,
    mimeType: 'image/jpeg',
    width: viewportWidth,
    height: needsClip ? maxHeight : pageHeight,
  }
}
