import type { BrowserPoolConfig, FetchResult, ExtractionConfig } from './types.js'
import { ContentExtractor } from './content-extractor.js'

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
    const timeout = options?.timeout ?? 30_000
    const startTime = Date.now()
    const page = await this.acquire()

    try {
      const typedPage = page as {
        goto: (url: string, opts: Record<string, unknown>) => Promise<{ status: () => number } | null>
        content: () => Promise<string>
        waitForSelector: (selector: string, opts: Record<string, unknown>) => Promise<void>
      }

      const response = await typedPage.goto(url, {
        waitUntil: 'networkidle2',
        timeout,
      })

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
        const pExtra = await import('puppeteer-extra')
        const stealthPlugin = await import('puppeteer-extra-plugin-stealth')
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
      const puppeteer = await import('puppeteer')
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
    entry.idleTimer = setTimeout(async () => {
      const index = this.entries.indexOf(entry)
      if (index !== -1 && entry.activePages === 0) {
        this.entries.splice(index, 1)
        const browser = entry.browser as { close: () => Promise<void> }
        await browser.close().catch(() => {})
      }
    }, this.config.idleTimeoutMs)
  }

  /** Clear a pending idle timer */
  private clearIdleTimer(entry: PoolEntry): void {
    if (entry.idleTimer !== null) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
  }
}
