import { describe, it, expect, vi } from 'vitest'
import { captureScreenshot } from '../extraction/screenshot-capture.js'

describe('captureScreenshot', () => {
  it('reports full page height when no clipping is needed', async () => {
    const sensitiveElements = { kind: 'sensitive-elements' }
    const mockPage = {
      viewportSize: () => ({ width: 1200, height: 800 }),
      evaluate: vi.fn(async () => 1600),
      screenshot: vi.fn(async () => Buffer.from('jpeg')),
      locator: vi.fn(() => sensitiveElements),
    }

    const result = await captureScreenshot(mockPage as never)

    expect(mockPage.screenshot).toHaveBeenCalledWith({
      fullPage: true,
      type: 'jpeg',
      quality: 80,
      mask: [sensitiveElements],
      maskColor: '#000000',
    })
    expect(result.width).toBe(1200)
    expect(result.height).toBe(1600)
  })
})
