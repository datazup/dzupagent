import type { Page } from 'playwright'
import type { ScreenshotResult } from '../types.js'

/**
 * Maximum full-page screenshot height: viewport height * 3.
 * Prevents multi-MB captures on very long pages.
 */
const MAX_HEIGHT_MULTIPLIER = 3

/**
 * Browser-native masking is applied before pixels leave the page. These
 * selectors intentionally cover every editable control plus explicit
 * sensitive markers; callers may add deeper local/OCR redaction later.
 */
export const SENSITIVE_SCREENSHOT_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[data-sensitive]',
  '[data-private]',
  '[autocomplete="current-password"]',
  '[autocomplete="new-password"]',
  '[autocomplete="one-time-code"]',
].join(', ')

export async function captureScreenshot(
  page: Page,
  fullPage = true,
): Promise<ScreenshotResult> {
  const viewport = page.viewportSize()
  const viewportHeight = viewport?.height ?? 720
  const viewportWidth = viewport?.width ?? 1280
  const sensitiveElements = page.locator(SENSITIVE_SCREENSHOT_SELECTOR)
  if (!fullPage) {
    const buffer = await page.screenshot({
      fullPage: false,
      type: 'jpeg',
      quality: 80,
      mask: [sensitiveElements],
      maskColor: '#000000',
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
    mask: [sensitiveElements],
    maskColor: '#000000',
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
