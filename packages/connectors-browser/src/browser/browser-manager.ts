import type { Browser, BrowserContext } from 'playwright'
import type { BrowserLaunchOptions } from '../types.js'

export class BrowserManager {
  private browser: Browser | null = null

  async launch(opts?: BrowserLaunchOptions): Promise<void> {
    if (this.browser) return
    // Dynamic import to avoid loading playwright at module level
    const { chromium } = await import('playwright')
    this.browser = await chromium.launch({
      headless: opts?.headless ?? true,
    })
  }

  async newContext(opts?: BrowserLaunchOptions): Promise<BrowserContext> {
    if (!this.browser) throw new Error('Browser not launched. Call launch() first.')
    return this.browser.newContext({
      viewport: opts?.viewport ?? { width: 1280, height: 720 },
      ...(opts?.proxy ? { proxy: { server: opts.proxy.server } } : {}),
    })
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
      this.browser = null
    }
  }
}
