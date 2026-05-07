/**
 * Shared test helpers for the @dzupagent/connectors-browser package.
 *
 * All factories return properly-typed objects so test files never need
 * `as never` or `as unknown as T` casts.
 *
 * These mocks represent the subset of the Playwright Page / BrowserContext
 * APIs exercised by the browser connector tests. They are typed using the
 * Playwright types so assignments are checked by TypeScript.
 */
import { vi } from 'vitest'
import type { Page, BrowserContext } from 'playwright'

// ---------------------------------------------------------------------------
// Page mock helpers
// ---------------------------------------------------------------------------

/**
 * Shape of the locator returned by `page.locator()`.
 * This is the subset the auth-handler and extraction tests exercise.
 */
export interface MockLocator {
  first: ReturnType<typeof vi.fn>
  click: ReturnType<typeof vi.fn>
  fill: ReturnType<typeof vi.fn>
  count: ReturnType<typeof vi.fn>
}

function makeLocator(overrides: Partial<MockLocator> = {}): MockLocator {
  return {
    first: vi.fn().mockReturnThis(),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0),
    ...overrides,
  }
}

/**
 * Returns a minimal Playwright Page mock together with its locator instance.
 *
 * Typed as `Page` so it can be passed to production functions without casts.
 */
export function makeMockPage(overrides: Partial<Page> = {}): {
  page: Page
  locatorInstance: MockLocator
} {
  const locatorInstance = makeLocator()

  const page = {
    url: vi.fn().mockReturnValue('https://example.com/login'),
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue(locatorInstance),
    evaluate: vi.fn(async <T>(fn: () => T | Promise<T>) => fn()),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('screenshot')),
    viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
    ...overrides,
  } as unknown as Page

  return { page, locatorInstance }
}

// ---------------------------------------------------------------------------
// BrowserContext mock helper
// ---------------------------------------------------------------------------

/**
 * Returns a minimal Playwright BrowserContext mock.
 *
 * Typed as `BrowserContext` so it can be passed to production functions
 * without casts.
 */
export function makeMockContext(overrides: Partial<BrowserContext> = {}): BrowserContext {
  return {
    addCookies: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as BrowserContext
}

// ---------------------------------------------------------------------------
// Minimal evaluate-only page mock
// ---------------------------------------------------------------------------

/**
 * Returns a minimal page with only `evaluate()` wired — useful for
 * extraction tests that run functions in a simulated browser context.
 */
export function makeEvaluatePage(): Page {
  return {
    evaluate: vi.fn(async <T>(fn: () => T | Promise<T>) => fn()),
  } as unknown as Page
}
