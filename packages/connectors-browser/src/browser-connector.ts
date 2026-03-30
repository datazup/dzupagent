/**
 * Browser connector — creates LangChain-compatible tools that wrap
 * browser automation capabilities for use in DzipAgent pipelines.
 */

import { createForgeTool } from '@dzipagent/agent'
import { z } from 'zod'
import { BrowserManager } from './browser/browser-manager.js'
import { PageCrawler } from './crawler/page-crawler.js'
import { AuthHandler } from './browser/auth-handler.js'
import { captureScreenshot } from './extraction/screenshot-capture.js'
import { extractAccessibilityTree } from './extraction/accessibility-tree.js'
import { extractForms } from './extraction/form-extractor.js'
import { extractInteractiveElements } from './extraction/element-extractor.js'
import type { CrawlOptions, AuthCredentials } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowserConnectorConfig {
  headless?: boolean
  auth?: AuthCredentials
  crawlOptions?: Partial<CrawlOptions>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum characters returned from tool outputs to prevent context overflow. */
const MAX_RESULT_LENGTH = 8000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a string to `maxLength` characters, appending a truncation notice
 * if the string exceeds the limit.
 */
function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return value.slice(0, maxLength) + '\n...[truncated]'
}

/**
 * Create a BrowserManager, launch the browser, create a context, and
 * optionally perform authentication. Returns both the manager and context
 * for the caller to use and close.
 */
async function createBrowserSession(config: BrowserConnectorConfig) {
  const manager = new BrowserManager()
  await manager.launch({ headless: config.headless ?? true })
  const context = await manager.newContext({ headless: config.headless ?? true })

  if (config.auth) {
    const authHandler = new AuthHandler()
    const page = await context.newPage()
    try {
      await authHandler.loginWithCredentials(page, config.auth)
    } finally {
      await page.close()
    }
  }

  return { manager, context }
}

// ---------------------------------------------------------------------------
// Connector factory
// ---------------------------------------------------------------------------

/**
 * Create a set of LangChain-compatible browser automation tools.
 *
 * Each tool is stateless — a fresh browser session is created per invocation
 * and closed when complete. This ensures no shared state leaks between calls.
 *
 * @param config - Optional configuration for browser launch, authentication,
 *   and crawl behavior.
 * @returns An array of 5 StructuredTools ready for agent registration.
 */
export function createBrowserConnector(config: BrowserConnectorConfig = {}) {
  // -------------------------------------------------------------------------
  // Tool 1: crawlSiteTool
  // -------------------------------------------------------------------------

  const crawlSiteTool = createForgeTool({
    id: 'browser-crawl-site',
    description:
      'Crawl a website starting from a URL using BFS. Returns an array of discovered pages with metadata including URL, title, link count, form count, and interactive element count.',
    inputSchema: z.object({
      startUrl: z.string().url().describe('The URL to start crawling from'),
      maxPages: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum number of pages to crawl (default: 50)'),
      maxDepth: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Maximum crawl depth from the start URL (default: 3)'),
      includePatterns: z
        .array(z.string())
        .optional()
        .describe('URL patterns to include (glob-style). If set, only matching URLs are crawled.'),
      excludePatterns: z
        .array(z.string())
        .optional()
        .describe('URL patterns to exclude (glob-style).'),
    }),
    execute: async (input): Promise<string> => {
      let manager: BrowserManager | undefined
      try {
        const session = await createBrowserSession(config)
        manager = session.manager

        const crawlOpts: Partial<CrawlOptions> = {
          ...config.crawlOptions,
          ...(input.maxPages !== undefined ? { maxPages: input.maxPages } : {}),
          ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
          ...(input.includePatterns !== undefined
            ? { includePatterns: input.includePatterns }
            : {}),
          ...(input.excludePatterns !== undefined
            ? { excludePatterns: input.excludePatterns }
            : {}),
        }

        const crawler = new PageCrawler(session.context, crawlOpts)
        const results: Array<{
          url: string
          title: string
          linkCount: number
          formCount: number
          elementCount: number
        }> = []

        for await (const page of crawler.crawl(input.startUrl)) {
          results.push({
            url: page.url,
            title: page.title,
            linkCount: page.links.length,
            formCount: page.forms.length,
            elementCount: page.interactiveElements.length,
          })
        }

        return truncate(JSON.stringify(results, null, 2), MAX_RESULT_LENGTH)
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Unknown error during site crawl'
        return `Error: ${message}`
      } finally {
        if (manager) {
          await manager.close()
        }
      }
    },
    toModelOutput: (output: string): string => output,
  })

  // -------------------------------------------------------------------------
  // Tool 2: captureScreenshotTool
  // -------------------------------------------------------------------------

  const captureScreenshotTool = createForgeTool({
    id: 'browser-capture-screenshot',
    description:
      'Capture a screenshot of a web page at the given URL. Returns the screenshot as a base64-encoded JPEG string.',
    inputSchema: z.object({
      url: z.string().url().describe('The URL of the page to capture'),
      fullPage: z
        .boolean()
        .optional()
        .describe('Whether to capture the full scrollable page (default: true)'),
    }),
    execute: async (input): Promise<string> => {
      let manager: BrowserManager | undefined
      try {
        const session = await createBrowserSession(config)
        manager = session.manager

        const page = await session.context.newPage()
        try {
          await page.goto(input.url, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          })
          // Wait for content to settle
          await page.waitForLoadState('networkidle').catch(() => {
            // networkidle may not fire for SPAs with persistent connections
          })

          const result = await captureScreenshot(page, input.fullPage ?? true)
          const base64 = result.buffer.toString('base64')

          return JSON.stringify({
            base64,
            mimeType: result.mimeType,
            width: result.width,
            height: result.height,
          })
        } finally {
          await page.close()
        }
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Unknown error capturing screenshot'
        return `Error: ${message}`
      } finally {
        if (manager) {
          await manager.close()
        }
      }
    },
    toModelOutput: (output: string): string => {
      if (output.startsWith('Error:')) return output
      return 'Screenshot captured successfully. Base64 image data returned.'
    },
  })

  // -------------------------------------------------------------------------
  // Tool 3: extractFormsTool
  // -------------------------------------------------------------------------

  const extractFormsTool = createForgeTool({
    id: 'browser-extract-forms',
    description:
      'Extract all HTML forms from a web page, including their fields, actions, methods, labels, and validation attributes.',
    inputSchema: z.object({
      url: z.string().url().describe('The URL of the page to extract forms from'),
    }),
    execute: async (input): Promise<string> => {
      let manager: BrowserManager | undefined
      try {
        const session = await createBrowserSession(config)
        manager = session.manager

        const page = await session.context.newPage()
        try {
          await page.goto(input.url, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          })
          await page.waitForLoadState('networkidle').catch(() => {
            // networkidle may not fire for SPAs with persistent connections
          })

          const forms = await extractForms(page)
          return truncate(JSON.stringify(forms, null, 2), MAX_RESULT_LENGTH)
        } finally {
          await page.close()
        }
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Unknown error extracting forms'
        return `Error: ${message}`
      } finally {
        if (manager) {
          await manager.close()
        }
      }
    },
    toModelOutput: (output: string): string => output,
  })

  // -------------------------------------------------------------------------
  // Tool 4: extractElementsTool
  // -------------------------------------------------------------------------

  const extractElementsTool = createForgeTool({
    id: 'browser-extract-elements',
    description:
      'Extract all interactive elements (buttons, links, tabs, checkboxes, etc.) from a web page with their roles, labels, and ARIA attributes.',
    inputSchema: z.object({
      url: z.string().url().describe('The URL of the page to extract elements from'),
    }),
    execute: async (input): Promise<string> => {
      let manager: BrowserManager | undefined
      try {
        const session = await createBrowserSession(config)
        manager = session.manager

        const page = await session.context.newPage()
        try {
          await page.goto(input.url, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          })
          await page.waitForLoadState('networkidle').catch(() => {
            // networkidle may not fire for SPAs with persistent connections
          })

          const elements = await extractInteractiveElements(page)
          return truncate(JSON.stringify(elements, null, 2), MAX_RESULT_LENGTH)
        } finally {
          await page.close()
        }
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : 'Unknown error extracting elements'
        return `Error: ${message}`
      } finally {
        if (manager) {
          await manager.close()
        }
      }
    },
    toModelOutput: (output: string): string => output,
  })

  // -------------------------------------------------------------------------
  // Tool 5: extractAccessibilityTreeTool
  // -------------------------------------------------------------------------

  const extractAccessibilityTreeTool = createForgeTool({
    id: 'browser-extract-a11y-tree',
    description:
      'Extract the accessibility tree from a web page, returning a hierarchical structure of ARIA roles, names, states, and properties.',
    inputSchema: z.object({
      url: z.string().url().describe('The URL of the page to extract the accessibility tree from'),
    }),
    execute: async (input): Promise<string> => {
      let manager: BrowserManager | undefined
      try {
        const session = await createBrowserSession(config)
        manager = session.manager

        const page = await session.context.newPage()
        try {
          await page.goto(input.url, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000,
          })
          await page.waitForLoadState('networkidle').catch(() => {
            // networkidle may not fire for SPAs with persistent connections
          })

          const tree = await extractAccessibilityTree(page)
          return truncate(JSON.stringify(tree, null, 2), MAX_RESULT_LENGTH)
        } finally {
          await page.close()
        }
      } catch (err: unknown) {
        const message =
          err instanceof Error
            ? err.message
            : 'Unknown error extracting accessibility tree'
        return `Error: ${message}`
      } finally {
        if (manager) {
          await manager.close()
        }
      }
    },
    toModelOutput: (output: string): string => output,
  })

  return [
    crawlSiteTool,
    captureScreenshotTool,
    extractFormsTool,
    extractElementsTool,
    extractAccessibilityTreeTool,
  ]
}
