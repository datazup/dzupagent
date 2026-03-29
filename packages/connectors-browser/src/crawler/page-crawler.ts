import type { BrowserContext, Page } from 'playwright'
import type { CrawlOptions, CrawlResult } from '../types.js'
import { extractLinks } from './link-extractor.js'
import { extractAccessibilityTree } from '../extraction/accessibility-tree.js'
import { captureScreenshot } from '../extraction/screenshot-capture.js'
import { extractForms } from '../extraction/form-extractor.js'
import { extractInteractiveElements } from '../extraction/element-extractor.js'
import { matchesPattern, isHashRoute } from './url-utils.js'

const DEFAULT_OPTIONS: CrawlOptions = {
  maxPages: 50,
  maxDepth: 3,
  waitForIdle: 2000,
}

export class PageCrawler {
  private visited = new Set<string>()
  private opts: CrawlOptions

  constructor(
    private context: BrowserContext,
    opts?: Partial<CrawlOptions>,
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts }
  }

  async *crawl(startUrl: string): AsyncGenerator<CrawlResult> {
    const queue: Array<{ url: string; depth: number }> = [{ url: startUrl, depth: 0 }]

    while (queue.length > 0 && this.visited.size < this.opts.maxPages) {
      const item = queue.shift()
      if (!item) break

      const { url, depth } = item

      if (this.visited.has(url)) continue
      if (depth > this.opts.maxDepth) continue

      // Check exclude patterns
      if (this.opts.excludePatterns && matchesPattern(url, this.opts.excludePatterns)) continue
      // Check include patterns (if specified, only include matching URLs)
      if (this.opts.includePatterns && this.opts.includePatterns.length > 0 && !matchesPattern(url, this.opts.includePatterns)) continue

      this.visited.add(url)

      let page: Page | null = null
      try {
        page = await this.context.newPage()
        const startTime = Date.now()

        if (isHashRoute(url)) {
          // Hash route: navigate to the base URL first, then change the hash.
          // This avoids a full page reload for hash-based SPAs.
          const parsed = new URL(url)
          const baseWithoutHash = parsed.origin + parsed.pathname + parsed.search

          // Only do a full navigation if this is the first page or a different base
          const currentBase = page.url().split('#')[0]
          if (currentBase !== baseWithoutHash) {
            await page.goto(baseWithoutHash, {
              waitUntil: 'domcontentloaded',
              timeout: 30000,
            })
            await this.waitForSpaContent(page)
          }

          // Navigate via hash change
          await page.evaluate((hash) => {
            window.location.hash = hash
          }, parsed.hash)
          // Wait for the hash-based router to render new content
          await page.waitForTimeout(this.opts.waitForIdle ?? 2000)
        } else {
          // Standard navigation
          await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          })
          await this.waitForSpaContent(page)

          if (this.opts.waitForIdle) {
            await page.waitForTimeout(this.opts.waitForIdle)
          }
        }

        const loadTimeMs = Date.now() - startTime
        const title = await page.title()

        // Extract data from the page
        const [links, accessibilityTree, screenshot, forms, interactiveElements] = await Promise.all([
          extractLinks(page),
          extractAccessibilityTree(page),
          captureScreenshot(page),
          extractForms(page),
          extractInteractiveElements(page),
        ])

        const result: CrawlResult = {
          url,
          title,
          depth,
          links,
          accessibilityTree,
          screenshot: screenshot.buffer,
          screenshotMimeType: screenshot.mimeType,
          forms,
          interactiveElements,
          loadTimeMs,
        }

        yield result

        // Add discovered links to the queue
        for (const link of links) {
          if (!this.visited.has(link) && this.visited.size + queue.length < this.opts.maxPages) {
            queue.push({ url: link, depth: depth + 1 })
          }
        }
      } catch (err: unknown) {
        // Skip pages that fail to load, continue crawling
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`Failed to crawl ${url}: ${message}`)
      } finally {
        if (page) {
          await page.close()
        }
      }
    }
  }

  /**
   * Smart wait strategy for SPA content.
   * Detects framework hydration, loading spinners, and dynamic content
   * before considering the page ready for extraction.
   */
  private async waitForSpaContent(page: Page): Promise<void> {
    // First, try to wait for networkidle with a short timeout.
    // SPAs with websockets or polling may never reach networkidle,
    // so we don't block on this forever.
    try {
      await page.waitForLoadState('networkidle', { timeout: 10_000 })
    } catch {
      // networkidle not reached — common for SPAs with persistent connections
    }

    // Wait for SPA framework hydration and loading indicators to disappear
    try {
      await page.waitForFunction(() => {
        // Check for common loading indicators
        const loadingIndicators = [
          '[class*="loading"]',
          '[class*="spinner"]',
          '[class*="skeleton"]',
          '[role="progressbar"]',
          '[aria-busy="true"]',
          '.v-skeleton-loader',        // Vuetify
          '.el-loading-mask',          // Element Plus
          '[data-loading="true"]',
          '.nprogress',                // NProgress bar
        ]

        for (const selector of loadingIndicators) {
          const el = document.querySelector(selector)
          if (el) {
            const style = window.getComputedStyle(el)
            // If the loading indicator is visible, content isn't ready
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              return false
            }
          }
        }

        // Check that meaningful content exists
        // SPAs often render an empty shell first, then populate with content
        const main = document.querySelector('main, [role="main"], #app > div, #root > div')
        if (main) {
          // Wait until the main content area has some substance
          const textContent = main.textContent?.trim() ?? ''
          if (textContent.length < 10) return false
        }

        return document.readyState === 'complete'
      }, { timeout: 8_000 })
    } catch {
      // Timeout waiting for content — proceed with what we have
    }
  }

  /** Get the count of pages visited so far. */
  get pagesVisited(): number {
    return this.visited.size
  }
}
