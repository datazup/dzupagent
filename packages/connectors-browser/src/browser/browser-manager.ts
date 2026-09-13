import type { Browser, BrowserContext } from 'playwright'
import type * as Playwright from 'playwright'
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
    try {
      // Some ESM loaders expose Playwright's CommonJS exports under default.
      // Keep loading lazy, and support both module shapes.
      const playwright = await import('playwright') as typeof Playwright & {
        default?: typeof Playwright
      }
      const chromium = playwright.chromium ?? playwright.default?.chromium
      this.browser = await chromium.launch({
        headless: opts?.headless ?? true,
        ...(args.length > 0 ? { args } : {}),
      })
    } catch (cause) {
      // Consumers may display the message; diagnostics stay in the private cause.
      const error = new Error('BROWSER_LAUNCH_FAILED', { cause })
      error.name = 'BrowserLaunchError'
      throw error
    }
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
