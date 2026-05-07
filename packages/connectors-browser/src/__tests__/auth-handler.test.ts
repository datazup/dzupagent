import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Page } from 'playwright'
import { AuthHandler } from '../browser/auth-handler.js'
import { makeMockPage, makeMockContext } from './test-utils.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AuthHandler', () => {
  describe('loginWithCredentials', () => {
    it('navigates to loginUrl when provided', async () => {
      const { page } = makeMockPage()
      const handler = new AuthHandler()

      await handler.loginWithCredentials(page, {
        loginUrl: 'https://example.com/auth',
        username: 'user',
        password: 'pass',
      })

      expect(vi.mocked(page.goto)).toHaveBeenCalledWith(
        'https://example.com/auth',
        expect.objectContaining({ waitUntil: 'networkidle' }),
      )
    })

    it('does not navigate when loginUrl is not provided', async () => {
      const { page } = makeMockPage()
      const handler = new AuthHandler()

      await handler.loginWithCredentials(page, {
        username: 'user',
        password: 'pass',
      })

      expect(vi.mocked(page.goto)).not.toHaveBeenCalled()
    })

    it('waits for SPA hydration before interacting', async () => {
      const { page } = makeMockPage()
      const handler = new AuthHandler()

      await handler.loginWithCredentials(page, {
        username: 'user',
        password: 'pass',
      })

      expect(vi.mocked(page.waitForFunction)).toHaveBeenCalled()
    })

    it('waits for username and password selectors to be visible', async () => {
      const { page } = makeMockPage()
      const handler = new AuthHandler()

      await handler.loginWithCredentials(page, {
        username: 'user',
        password: 'pass',
      })

      // waitForSelector is called for username and password fields (at least 2 times)
      expect(vi.mocked(page.waitForSelector).mock.calls.length).toBeGreaterThanOrEqual(2)
      // One of the calls should be for the password selector
      expect(vi.mocked(page.waitForSelector)).toHaveBeenCalledWith(
        'input[type="password"]',
        expect.objectContaining({ state: 'visible' }),
      )
    })

    it('uses custom selectors when provided', async () => {
      const { page } = makeMockPage()
      const handler = new AuthHandler()

      await handler.loginWithCredentials(page, {
        username: 'user',
        password: 'pass',
        usernameSelector: '#my-email',
        passwordSelector: '#my-password',
      })

      expect(vi.mocked(page.waitForSelector)).toHaveBeenCalledWith(
        '#my-email',
        expect.objectContaining({ state: 'visible' }),
      )
      expect(vi.mocked(page.waitForSelector)).toHaveBeenCalledWith(
        '#my-password',
        expect.objectContaining({ state: 'visible' }),
      )
    })

    it('fills username and password fields', async () => {
      const { page, locatorInstance } = makeMockPage()
      const handler = new AuthHandler()

      await handler.loginWithCredentials(page, {
        username: 'testuser',
        password: 'testpass',
      })

      // fill is called: clear username, fill username, clear password, fill password
      const fillCalls = vi.mocked(locatorInstance.fill).mock.calls.map(
        (call: unknown[]) => call[0],
      )
      expect(fillCalls).toContain('testuser')
      expect(fillCalls).toContain('testpass')
    })

    it('clicks the submit button', async () => {
      const { page, locatorInstance } = makeMockPage()
      const handler = new AuthHandler()

      await handler.loginWithCredentials(page, {
        username: 'user',
        password: 'pass',
      })

      // locator is called for username, password, and submit button
      expect(vi.mocked(locatorInstance.first)).toHaveBeenCalled()
      expect(vi.mocked(locatorInstance.click)).toHaveBeenCalled()
    })
  })

  describe('loginWithCookies', () => {
    it('adds cookies to the browser context', async () => {
      const handler = new AuthHandler()
      const context = makeMockContext()

      await handler.loginWithCookies(context, [
        { name: 'session', value: 'abc123', domain: 'example.com' },
      ])

      expect(vi.mocked(context.addCookies)).toHaveBeenCalledWith([
        { name: 'session', value: 'abc123', domain: 'example.com', path: '/' },
      ])
    })

    it('uses custom path when provided', async () => {
      const handler = new AuthHandler()
      const context = makeMockContext()

      await handler.loginWithCookies(context, [
        { name: 'token', value: 'xyz', domain: 'example.com', path: '/api' },
      ])

      expect(vi.mocked(context.addCookies)).toHaveBeenCalledWith([
        { name: 'token', value: 'xyz', domain: 'example.com', path: '/api' },
      ])
    })

    it('handles multiple cookies', async () => {
      const handler = new AuthHandler()
      const context = makeMockContext()

      await handler.loginWithCookies(context, [
        { name: 'a', value: '1', domain: 'example.com' },
        { name: 'b', value: '2', domain: 'example.com' },
      ])

      const cookies = vi.mocked(context.addCookies).mock.calls[0]![0] as unknown[]
      expect(cookies).toHaveLength(2)
    })
  })

  describe('isLoginPage', () => {
    it('returns true when password fields exist', async () => {
      const { page } = makeMockPage({
        locator: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(1) }) as unknown as Page['locator'],
      })

      const handler = new AuthHandler()
      const result = await handler.isLoginPage(page)

      expect(result).toBe(true)
      expect(vi.mocked(page.locator)).toHaveBeenCalledWith('input[type="password"]')
    })

    it('returns false when no password fields exist', async () => {
      const { page } = makeMockPage({
        locator: vi.fn().mockReturnValue({ count: vi.fn().mockResolvedValue(0) }) as unknown as Page['locator'],
      })

      const handler = new AuthHandler()
      const result = await handler.isLoginPage(page)

      expect(result).toBe(false)
    })
  })
})
