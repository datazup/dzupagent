import type { Browser, BrowserContext } from 'playwright'
import type { BrowserLaunchOptions } from '../types.js'
import { buildChromiumLaunchArgs } from './launch-args.js'

export class BrowserManager {
  private browser: Browser | null = null

  /**
   * Launch the shared Chromium instance. No-op if already launched.
   *
   * Launch arguments are never taken verbatim from the caller: typed options
   * (currently `hostResolverRules`) are rendered into flags by
   * `buildChromiumLaunchArgs`, which validates fail-closed and throws here
   * before any browser is started.
   */
  async launch(opts?: BrowserLaunchOptions): Promise<void> {
    if (this.browser) return
    // Validate/render before importing playwright so a bad option fails fast.
    const args = buildChromiumLaunchArgs({
      hostResolverRules: opts?.hostResolverRules,
    })
    // Dynamic import to avoid loading playwright at module level
    const { chromium } = await import('playwright')
    this.browser = await chromium.launch({
      headless: opts?.headless ?? true,
      ...(args.length > 0 ? { args } : {}),
    })
  }

  async newContext(opts?: BrowserLaunchOptions): Promise<BrowserContext> {
    if (!this.browser) throw new Error('Browser not launched. Call launch() first.')
    return this.browser.newContext({
      viewport: opts?.viewport ?? { width: 1280, height: 720 },
      ...(opts?.proxy ? { proxy: { server: opts.proxy.server } } : {}),
      ...(opts?.serviceWorkers ? { serviceWorkers: opts.serviceWorkers } : {}),
    })
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
      this.browser = null
    }
  }
}
