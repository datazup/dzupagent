import type { Page, BrowserContext } from 'playwright'
import type { AuthCredentials } from '../types.js'

/** Default timeout for login operations (15 seconds). */
const LOGIN_TIMEOUT = 15_000

/** Common selectors for detecting post-login state. */
const POST_LOGIN_INDICATORS = [
  // Common dashboard/home page elements
  'nav', '[role="navigation"]', '[data-testid="sidebar"]',
  // User menu indicators
  '[aria-label="User menu"]', '[data-testid="user-menu"]',
  'button:has-text("Logout")', 'button:has-text("Sign out")',
  'a:has-text("Logout")', 'a:has-text("Sign out")',
  // Avatar / user info
  '[class*="avatar"]', '[class*="user-info"]',
]

export class AuthHandler {
  /**
   * Login using username/password credentials.
   * Handles both traditional form-based and SPA login flows:
   * - Waits for SPA hydration before interacting with forms
   * - Handles JS-based redirects after login
   * - Detects successful login via URL change or DOM indicators
   */
  async loginWithCredentials(page: Page, creds: AuthCredentials): Promise<void> {
    const loginUrl = creds.loginUrl ?? page.url()
    if (creds.loginUrl) {
      await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 30_000 })
    }

    // Wait for SPA hydration — login forms may not be interactive until JS loads
    await this.waitForSpaReady(page)

    // Find username/email field
    const usernameSelector = creds.usernameSelector
      ?? 'input[type="email"], input[name="email"], input[name="username"], input[type="text"][autocomplete="username"], input[type="text"][name="identifier"]'
    // Find password field
    const passwordSelector = creds.passwordSelector
      ?? 'input[type="password"]'

    // Wait for form fields to be visible and interactable
    await page.waitForSelector(usernameSelector, { state: 'visible', timeout: LOGIN_TIMEOUT })
    await page.waitForSelector(passwordSelector, { state: 'visible', timeout: LOGIN_TIMEOUT })

    // Clear fields first (some SPAs pre-fill values)
    const usernameField = page.locator(usernameSelector).first()
    const passwordField = page.locator(passwordSelector).first()

    await usernameField.click()
    await usernameField.fill('')
    await usernameField.fill(creds.username)

    await passwordField.click()
    await passwordField.fill('')
    await passwordField.fill(creds.password)

    // Capture current URL for redirect detection
    const urlBeforeLogin = page.url()

    // Find and click submit button (expanded selectors for SPA frameworks)
    const submitButton = page.locator([
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Sign in")',
      'button:has-text("Login")',
      'button:has-text("Submit")',
      'button:has-text("Continue")',
      '[data-testid="login-button"]',
      '[data-testid="submit-button"]',
      'form button:not([type="button"])',
    ].join(', '))

    await submitButton.first().click()

    // Wait for login to complete — use multiple strategies
    await this.waitForLoginComplete(page, urlBeforeLogin)
  }

  /**
   * Wait for login to complete using multiple detection strategies.
   * SPAs may use URL changes, DOM updates, or token storage.
   */
  private async waitForLoginComplete(page: Page, urlBeforeLogin: string): Promise<void> {
    try {
      // Strategy 1: Wait for URL change (most common for SPAs)
      // Strategy 2: Wait for post-login DOM indicators
      // Strategy 3: Wait for network idle (fallback)
      await Promise.race([
        // Wait for URL to change (redirect to dashboard/home)
        (async () => {
          await page.waitForURL((url) => url.toString() !== urlBeforeLogin, {
            timeout: LOGIN_TIMEOUT,
          })
        })(),
        // Wait for a post-login indicator to appear
        (async () => {
          await page.waitForSelector(POST_LOGIN_INDICATORS.join(', '), {
            state: 'visible',
            timeout: LOGIN_TIMEOUT,
          })
        })(),
      ])
    } catch {
      // Both strategies timed out — fall back to networkidle
    }

    // Always wait for network to settle after login
    await page.waitForLoadState('networkidle').catch(() => {
      // networkidle may not fire if there are persistent connections (websockets, polling)
    })

    // Additional wait for SPA re-render after auth state change
    await page.waitForTimeout(1000)
  }

  /**
   * Wait for SPA frameworks to hydrate and become interactive.
   * Detects Vue, React, Angular, and Svelte applications.
   */
  private async waitForSpaReady(page: Page): Promise<void> {
    try {
      await page.waitForFunction(() => {
        // Vue 3: check if app is mounted
        const appEl = document.querySelector('#app') ?? document.querySelector('[data-v-app]')
        if (appEl && '__vue_app__' in (appEl as never)) return true

        // React: check for React root
        const rootEl = document.querySelector('#root')
        if (rootEl && '_reactRootContainer' in (rootEl as never)) return true
        if (document.querySelector('#__next')) return true

        // Angular: check for ng-version
        if (document.querySelector('[ng-version]')) return true

        // Generic: if document has completed loading and there are interactive elements
        if (document.readyState === 'complete') {
          const forms = document.querySelectorAll('form')
          const inputs = document.querySelectorAll('input, button[type="submit"]')
          if (forms.length > 0 || inputs.length > 0) return true
        }

        return false
      }, { timeout: 10_000 })
    } catch {
      // Timeout waiting for SPA — continue anyway (might be SSR)
    }
  }

  /**
   * Set cookies on a browser context for authenticated access.
   */
  async loginWithCookies(
    context: BrowserContext,
    cookies: Array<{ name: string; value: string; domain: string; path?: string | undefined }>,
  ): Promise<void> {
    await context.addCookies(cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path ?? '/',
    })))
  }

  /**
   * Detect if a page is a login page by checking for password fields.
   */
  async isLoginPage(page: Page): Promise<boolean> {
    const passwordFields = await page.locator('input[type="password"]').count()
    return passwordFields > 0
  }
}
