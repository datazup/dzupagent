import type { BrowserPoolConfig, FetchResult, ExtractionConfig } from './types.js'
import { ContentExtractor } from './content-extractor.js'
import { validateOutboundUrl } from '@dzupagent/core/security'

const DEFAULT_CONFIG: BrowserPoolConfig = {
  maxConcurrency: 3,
  idleTimeoutMs: 60_000,
  stealth: true,
  headless: true,
}

const DEFAULT_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
  '--disable-gpu',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--disable-translate',
  '--hide-scrollbars',
  '--metrics-recording-only',
  '--mute-audio',
  '--safebrowsing-disable-auto-update',
]

const OPTIONAL_BROWSER_PEERS = {
  puppeteer: 'puppeteer',
  puppeteerExtra: 'puppeteer-extra',
  stealthPlugin: 'puppeteer-extra-plugin-stealth',
} as const

async function importOptionalBrowserPeer(specifier: string): Promise<Record<string, unknown>> {
  return await import(specifier) as Record<string, unknown>
}

/**
 * State of a pooled browser instance.
 *
 * Each entry tracks one running browser and how many pages are open
 * on it, so we can reuse browsers up to the concurrency limit.
 */
interface PoolEntry {
  browser: unknown // puppeteer Browser
  activePages: number
  idleTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Puppeteer browser pool with concurrency control and optional stealth.
 *
 * Puppeteer is loaded via dynamic import so it remains an optional peer
 * dependency. If puppeteer is not installed, calling any method will
 * throw a descriptive error.
 */
export class BrowserPool {
  private readonly config: BrowserPoolConfig
  private readonly extractor: ContentExtractor
  private readonly entries: PoolEntry[] = []
  private puppeteerModule: unknown = null
  private destroyed = false

  constructor(config?: Partial<BrowserPoolConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.extractor = new ContentExtractor()
  }

  /** Acquire a browser page from the pool */
  async acquire(): Promise<unknown> {
    if (this.destroyed) {
      throw new Error('BrowserPool has been destroyed')
    }

    const launcher = await this.loadPuppeteer()

    // Try to reuse an existing browser that has capacity
    for (const entry of this.entries) {
      if (entry.activePages < 1) {
        // One page per browser for isolation
        entry.activePages++
        this.clearIdleTimer(entry)
        const browser = entry.browser as { newPage: () => Promise<unknown> }
        return browser.newPage()
      }
    }

    // Need a new browser if under concurrency limit
    if (this.entries.length < this.config.maxConcurrency) {
      const browser = await this.launchBrowser(launcher)
      const entry: PoolEntry = { browser, activePages: 1, idleTimer: null }
      this.entries.push(entry)
      const typedBrowser = browser as { newPage: () => Promise<unknown> }
      return typedBrowser.newPage()
    }

    // At capacity — wait for a slot by polling
    return new Promise<unknown>((resolve, reject) => {
      const interval = setInterval(() => {
        if (this.destroyed) {
          clearInterval(interval)
          reject(new Error('BrowserPool was destroyed while waiting'))
          return
        }
        for (const entry of this.entries) {
          if (entry.activePages < 1) {
            entry.activePages++
            this.clearIdleTimer(entry)
            clearInterval(interval)
            const browser = entry.browser as { newPage: () => Promise<unknown> }
            resolve(browser.newPage())
            return
          }
        }
      }, 100)

      // Timeout after 30s
      setTimeout(() => {
        clearInterval(interval)
        reject(new Error('Timed out waiting for available browser'))
      }, 30_000)
    })
  }

  /** Release a page back to the pool */
  async release(page: unknown): Promise<void> {
    const typedPage = page as { browser: () => unknown; close: () => Promise<void> }
    const pageBrowser = typedPage.browser()

    await typedPage.close().catch(() => {})

    for (const entry of this.entries) {
      if (entry.browser === pageBrowser) {
        entry.activePages = Math.max(0, entry.activePages - 1)
        if (entry.activePages === 0) {
          this.startIdleTimer(entry)
        }
        return
      }
    }
  }

  /** Fetch a URL using the browser pool and return extracted content */
  async fetch(
    url: string,
    options?: { timeout?: number; waitFor?: string; extraction?: Partial<ExtractionConfig> },
  ): Promise<FetchResult> {
    const validation = await validateOutboundUrl(url, this.config.urlPolicy)
    if (!validation.ok) {
      throw new Error(`Outbound URL rejected: ${validation.reason}`)
    }
    const timeout = options?.timeout ?? 30_000
    const startTime = Date.now()
    const page = await this.acquire()

    try {
      const typedPage = page as {
        goto: (url: string, opts: Record<string, unknown>) => Promise<{ status: () => number } | null>
        content: () => Promise<string>
        waitForSelector: (selector: string, opts: Record<string, unknown>) => Promise<void>
      }

      // SSRF defense-in-depth: the initial validation above only covers the
      // first URL. A 3xx redirect or a DNS rebind can steer a subsequent
      // navigation at an internal service (169.254.169.254, 127.0.0.1,
      // RFC1918). Enforce the same central policy on every main-frame
      // navigation request via request interception, aborting disallowed ones.
      const ssrfBlock = await this.installSsrfInterception(page)

      const response = await typedPage.goto(url, {
        waitUntil: 'networkidle2',
        timeout,
      })

      if (ssrfBlock.blocked) {
        throw new Error(`Outbound URL rejected: ${ssrfBlock.reason ?? 'blocked navigation'}`)
      }

      if (options?.waitFor) {
        await typedPage.waitForSelector(options.waitFor, { timeout: 5000 }).catch(() => {})
      }

      const html = await typedPage.content()
      const status = response?.status() ?? 0
      const extracted = this.extractor.extract(html, {
        mode: 'all',
        cleanHtml: true,
        ...options?.extraction,
      })

      return {
        url,
        status,
        contentType: 'text/html',
        text: extracted.text,
        title: extracted.title,
        description: extracted.description,
        author: extracted.author,
        publishedDate: extracted.publishedDate,
        html,
        durationMs: Date.now() - startTime,
        method: 'browser',
      }
    } finally {
      await this.release(page)
    }
  }

  /**
   * Enable Puppeteer request interception on a page and validate every
   * main-frame navigation request against the central outbound-URL policy.
   *
   * This closes the SSRF gap where only the initial URL was validated: HTTP
   * 3xx redirects and DNS-rebinding both produce fresh navigation requests
   * that must be re-checked. Each candidate URL is run through
   * `validateOutboundUrl` (which resolves DNS and rejects non-public resolved
   * IPs — the same pinning-aware check used elsewhere), and disallowed
   * requests are aborted rather than allowed to reach an internal service.
   *
   * Non-navigation subresource requests (images, scripts, XHR) are allowed
   * through unchanged to preserve existing scraper behavior for public pages.
   *
   * The returned handle carries the first block reason so the caller can turn
   * an aborted navigation into a thrown error instead of silently returning a
   * blank page.
   */
  private async installSsrfInterception(
    page: unknown,
  ): Promise<{ blocked: boolean; reason?: string }> {
    const handle: { blocked: boolean; reason?: string } = { blocked: false }

    const typedPage = page as {
      setRequestInterception: (value: boolean) => Promise<void>
      on: (event: string, handler: (req: unknown) => void) => void
    }

    if (
      typeof typedPage.setRequestInterception !== 'function' ||
      typeof typedPage.on !== 'function'
    ) {
      // Interception unsupported (e.g. a minimal mock) — leave behavior as-is.
      return handle
    }

    await typedPage.setRequestInterception(true)

    typedPage.on('request', (request: unknown) => {
      const typedRequest = request as {
        url: () => string
        isNavigationRequest?: () => boolean
        resourceType?: () => string
        continue: () => Promise<void>
        abort: (errorCode?: string) => Promise<void>
      }

      void this.handleInterceptedRequest(typedRequest, handle)
    })

    return handle
  }

  /** Validate a single intercepted request and continue or abort it. */
  private async handleInterceptedRequest(
    request: {
      url: () => string
      isNavigationRequest?: () => boolean
      resourceType?: () => string
      continue: () => Promise<void>
      abort: (errorCode?: string) => Promise<void>
    },
    handle: { blocked: boolean; reason?: string },
  ): Promise<void> {
    const requestUrl = request.url()

    // Only main-frame navigations (initial load + redirect targets) can steer
    // the browser at an internal service in a way the initial check misses.
    const isNavigation =
      typeof request.isNavigationRequest === 'function'
        ? request.isNavigationRequest()
        : true
    const resourceType =
      typeof request.resourceType === 'function' ? request.resourceType() : undefined

    if (!isNavigation && resourceType !== 'document') {
      await request.continue().catch(() => {})
      return
    }

    const validation = await validateOutboundUrl(requestUrl, this.config.urlPolicy)
    if (validation.ok) {
      await request.continue().catch(() => {})
      return
    }

    if (!handle.blocked) {
      handle.blocked = true
      handle.reason = validation.reason
    }
    await request.abort('blockedbyclient').catch(() => {})
  }

  /** Gracefully shut down all browsers */
  async destroy(): Promise<void> {
    this.destroyed = true
    const closeTasks = this.entries.map(async (entry) => {
      this.clearIdleTimer(entry)
      const browser = entry.browser as { close: () => Promise<void> }
      await browser.close().catch(() => {})
    })
    await Promise.all(closeTasks)
    this.entries.length = 0
  }

  /** Dynamically import puppeteer (or puppeteer-extra with stealth) */
  private async loadPuppeteer(): Promise<unknown> {
    if (this.puppeteerModule) return this.puppeteerModule

    if (this.config.stealth) {
      try {
        const pExtra = await importOptionalBrowserPeer(OPTIONAL_BROWSER_PEERS.puppeteerExtra)
        const stealthPlugin = await importOptionalBrowserPeer(OPTIONAL_BROWSER_PEERS.stealthPlugin)
        const puppeteerExtra = pExtra.default ?? pExtra
        const StealthPlugin = stealthPlugin.default ?? stealthPlugin
        ;(puppeteerExtra as unknown as { use: (plugin: unknown) => void }).use(
          typeof StealthPlugin === 'function'
            ? (StealthPlugin as () => unknown)()
            : StealthPlugin,
        )
        this.puppeteerModule = puppeteerExtra
        return this.puppeteerModule
      } catch {
        // Fall through to plain puppeteer
      }
    }

    try {
      const puppeteer = await importOptionalBrowserPeer(OPTIONAL_BROWSER_PEERS.puppeteer)
      this.puppeteerModule = puppeteer.default ?? puppeteer
      return this.puppeteerModule
    } catch {
      throw new Error(
        'puppeteer is required for browser mode. Install it: npm install puppeteer',
      )
    }
  }

  /** Launch a new browser instance */
  private async launchBrowser(launcher: unknown): Promise<unknown> {
    const launchArgs = this.config.launchArgs ?? DEFAULT_LAUNCH_ARGS
    const execPath =
      this.config.executablePath ?? process.env['PUPPETEER_EXECUTABLE_PATH']

    const options: Record<string, unknown> = {
      headless: this.config.headless,
      args: launchArgs,
    }
    if (execPath) {
      options['executablePath'] = execPath
    }

    const typedLauncher = launcher as { launch: (opts: Record<string, unknown>) => Promise<unknown> }
    return typedLauncher.launch(options)
  }

  /** Start an idle timer that closes a browser after idleTimeoutMs */
  private startIdleTimer(entry: PoolEntry): void {
    this.clearIdleTimer(entry)
    const closeIdleEntry = async (): Promise<void> => {
      const index = this.entries.indexOf(entry)
      if (index !== -1 && entry.activePages === 0) {
        this.entries.splice(index, 1)
        const browser = entry.browser as { close: () => Promise<void> }
        await browser.close().catch(() => {})
      }
    }
    entry.idleTimer = setTimeout(() => { void closeIdleEntry() }, this.config.idleTimeoutMs)
  }

  /** Clear a pending idle timer */
  private clearIdleTimer(entry: PoolEntry): void {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
  }
}
