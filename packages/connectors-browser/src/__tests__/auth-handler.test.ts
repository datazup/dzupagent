import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuthHandler } from '../browser/auth-handler.js'

function createMockPage(overrides: Record<string, unknown> = {}) {
  const locatorInstance = {
    first: vi.fn().mockReturnThis(),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0),
  }

  const page = {
    url: vi.fn().mockReturnValue('https://example.com/login'),
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForURL: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue(locatorInstance),
    ...overrides,
  }

  return { page, locatorInstance }
}

function createMockContext() {
  return {
    addCookies: vi.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AuthHandler', () => {
  describe('loginWithCredentials', () => {
    it('navigates to loginUrl when provided', async () => {
      const { page } = createMockPage()
      const handler = new AuthHandler()

      await handler.loginWithCredentials(page as never, {
        loginUrl: 'https://example.com/auth',
        username: 'user',
        password: 'pass',
      })

      expect(page.goto).toHaveBeenCalledWith(
        'https://example.com/auth',
        expect.objectContaining({ waitUntil: 'networkidle' }),
      )
    })

    it('does not navigate when loginUrl is not provided', async () => {
      const { page } = createMockPage()
      const handler = new AuthHandler()

      await handler.loginWithCredentials(page as never, {
        username: 'user',
        password: 'pass',
      })

      expect(page.goto).not.toHaveBeenCalled()
    })

    it('waits for SPA hydration before interacting', async () => {
      const { page } = createMockPage()
      const handler = new AuthHandler()

      await handler.loginWithCredentials(page as never, {
        username: 'user',
        password: 'pass',
      })

      expect(page.waitForFunction).toHaveBeenCalled()
    })

    it('waits for username and password selectors to be visible', async () => {
      const { page } = createMockPage()
      const handler = new AuthHandler()

      await handler.loginWithCredentials(page as never, {
        username: 'user',
        password: 'pass',
      })

      // waitForSelector is called for username and password fields (at least 2 times)
      expect(page.waitForSelector.mock.calls.length).toBeGreaterThanOrEqual(2)
      // One of the calls should be for the password selector
      expect(page.waitForSelector).toHaveBeenCalledWith(
        'input[type="password"]',
        expect.objectContaining({ state: 'visible' }),
      )
    })

    it('uses custom selectors when provided', async () => {
      const { page } = createMockPage()
      const handler = new AuthHandler()

      await handler.loginWithCredentials(page as never, {
        username: 'user',
        password: 'pass',
        usernameSelector: '#my-email',
        passwordSelector: '#my-password',
      })

      expect(page.waitForSelector).toHaveBeenCalledWith(
        '#my-email',
        expect.objectContaining({ state: 'visible' }),
      )
      expect(page.waitForSelector).toHaveBeenCalledWith(
        '#my-password',
        expect.objectContaining({ state: 'visible' }),
      )
    })

    it('fills username and password fields', async () => {
      const { page, locatorInstance } = createMockPage()
      const handler = new AuthHandler()

      await handler.loginWithCredentials(page as never, {
        username: 'testuser',
        password: 'testpass',
      })

      // fill is called: clear username, fill username, clear password, fill password
      const fillCalls = locatorInstance.fill.mock.calls.map(
        (call: unknown[]) => call[0],
      )
      expect(fillCalls).toContain('testuser')
      expect(fillCalls).toContain('testpass')
    })

    it('clicks the submit button', async () => {
      const { page, locatorInstance } = createMockPage()
      const handler = new AuthHandler()

      await handler.loginWithCredentials(page as never, {
        username: 'user',
        password: 'pass',
      })

      // locator is called for username, password, and submit button
      expect(locatorInstance.first).toHaveBeenCalled()
      expect(locatorInstance.click).toHaveBeenCalled()
    })
  })

  describe('loginWithCookies', () => {
    it('adds cookies to the browser context', async () => {
      const handler = new AuthHandler()
      const context = createMockContext()

      await handler.loginWithCookies(context as never, [
        { name: 'session', value: 'abc123', domain: 'example.com' },
      ])

      expect(context.addCookies).toHaveBeenCalledWith([
        { name: 'session', value: 'abc123', domain: 'example.com', path: '/' },
      ])
    })

    it('uses custom path when provided', async () => {
      const handler = new AuthHandler()
      const context = createMockContext()

      await handler.loginWithCookies(context as never, [
        { name: 'token', value: 'xyz', domain: 'example.com', path: '/api' },
      ])

      expect(context.addCookies).toHaveBeenCalledWith([
        { name: 'token', value: 'xyz', domain: 'example.com', path: '/api' },
      ])
    })

    it('handles multiple cookies', async () => {
      const handler = new AuthHandler()
      const context = createMockContext()

      await handler.loginWithCookies(context as never, [
        { name: 'a', value: '1', domain: 'example.com' },
        { name: 'b', value: '2', domain: 'example.com' },
      ])

      const cookies = context.addCookies.mock.calls[0]![0] as unknown[]
      expect(cookies).toHaveLength(2)
    })
  })

  describe('isLoginPage', () => {
    it('returns true when password fields exist', async () => {
      const locator = { count: vi.fn().mockResolvedValue(1) }
      const page = { locator: vi.fn().mockReturnValue(locator) }

      const handler = new AuthHandler()
      const result = await handler.isLoginPage(page as never)

      expect(result).toBe(true)
      expect(page.locator).toHaveBeenCalledWith('input[type="password"]')
    })

    it('returns false when no password fields exist', async () => {
      const locator = { count: vi.fn().mockResolvedValue(0) }
      const page = { locator: vi.fn().mockReturnValue(locator) }

      const handler = new AuthHandler()
      const result = await handler.isLoginPage(page as never)

      expect(result).toBe(false)
    })
  })
})
