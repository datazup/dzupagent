import type { Page, BrowserContext } from "playwright";
import type {
  AuthCredentials,
  LoginFlowOptions,
  LoginFlowResult,
} from "../types.js";

/** Default timeout for login operations (15 seconds). */
const LOGIN_TIMEOUT = 15_000;

/** Common selectors for detecting post-login state. */
const POST_LOGIN_INDICATORS = [
  // Common dashboard/home page elements
  "nav",
  '[role="navigation"]',
  '[data-testid="sidebar"]',
  // User menu indicators
  '[aria-label="User menu"]',
  '[data-testid="user-menu"]',
  'button:has-text("Logout")',
  'button:has-text("Sign out")',
  'a:has-text("Logout")',
  'a:has-text("Sign out")',
  // Avatar / user info
  '[class*="avatar"]',
  '[class*="user-info"]',
];

/** Selectors used to discover a sign-in entry point on a landing page. */
const LOGIN_ENTRY_SELECTORS = [
  'a:has-text("Log in")',
  'a:has-text("Login")',
  'a:has-text("Sign in")',
  'a:has-text("Sign In")',
  'button:has-text("Log in")',
  'button:has-text("Login")',
  'button:has-text("Sign in")',
  'a[href*="login" i]',
  'a[href*="signin" i]',
  'a[href*="sign-in" i]',
  'a[href*="auth" i]',
  '[data-testid*="login" i]',
  '[data-testid*="signin" i]',
].join(", ");

export class AuthHandler {
  /**
   * Login using username/password credentials.
   * Handles both traditional form-based and SPA login flows:
   * - Waits for SPA hydration before interacting with forms
   * - Handles JS-based redirects after login
   * - Detects successful login via URL change or DOM indicators
   */
  async loginWithCredentials(
    page: Page,
    creds: AuthCredentials
  ): Promise<void> {
    if (creds.loginUrl) {
      await page.goto(creds.loginUrl, {
        waitUntil: "networkidle",
        timeout: 30_000,
      });
    }
    await this.fillAndSubmitLogin(page, creds);
  }

  /**
   * Fill and submit the login form on the current page. Does not navigate
   * to a login URL — callers position the page first.
   */
  private async fillAndSubmitLogin(
    page: Page,
    creds: AuthCredentials
  ): Promise<boolean> {
    // Wait for SPA hydration — login forms may not be interactive until JS loads
    await this.waitForSpaReady(page);

    // Find username/email field
    const usernameSelector =
      creds.usernameSelector ??
      'input[type="email"], input[name="email"], input[name="username"], input[type="text"][autocomplete="username"], input[type="text"][name="identifier"]';
    // Find password field
    const passwordSelector = creds.passwordSelector ?? 'input[type="password"]';

    // Wait for form fields to be visible and interactable
    await page.waitForSelector(usernameSelector, {
      state: "visible",
      timeout: LOGIN_TIMEOUT,
    });
    await page.waitForSelector(passwordSelector, {
      state: "visible",
      timeout: LOGIN_TIMEOUT,
    });

    // Clear fields first (some SPAs pre-fill values)
    const usernameField = page.locator(usernameSelector).first();
    const passwordField = page.locator(passwordSelector).first();

    await usernameField.click();
    await usernameField.fill("");
    await usernameField.fill(creds.username);

    await passwordField.click();
    await passwordField.fill("");
    await passwordField.fill(creds.password);

    // Capture current URL for redirect detection
    const urlBeforeLogin = page.url();

    // Find and click submit button (expanded selectors for SPA frameworks)
    const submitButton = page.locator(
      [
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
      ].join(", ")
    );

    await submitButton.first().click();

    // Wait for login to complete — use multiple strategies
    const positiveSignal = await this.waitForLoginComplete(
      page,
      urlBeforeLogin
    );
    return positiveSignal;
  }

  /**
   * Wait for login to complete using multiple detection strategies.
   * SPAs may use URL changes, DOM updates, or token storage.
   *
   * Returns whether a positive success signal (URL change or a post-login DOM
   * indicator) actually fired. Absence of a password field alone is NOT proof
   * of success — interstitials like email verification, CAPTCHA, or an IdP
   * error page also lack a password field, so callers must combine this with
   * `isLoginPage`.
   */
  private async waitForLoginComplete(
    page: Page,
    urlBeforeLogin: string
  ): Promise<boolean> {
    let sawPositiveSignal = false;
    try {
      // Strategy 1: Wait for URL change (most common for SPAs)
      // Strategy 2: Wait for post-login DOM indicators
      await Promise.race([
        // Wait for URL to change (redirect to dashboard/home)
        (async () => {
          await page.waitForURL((url) => url.toString() !== urlBeforeLogin, {
            timeout: LOGIN_TIMEOUT,
          });
          sawPositiveSignal = true;
        })(),
        // Wait for a post-login indicator to appear
        (async () => {
          await page.waitForSelector(POST_LOGIN_INDICATORS.join(", "), {
            state: "visible",
            timeout: LOGIN_TIMEOUT,
          });
          sawPositiveSignal = true;
        })(),
      ]);
    } catch {
      // Both strategies timed out — no positive signal observed
    }

    // Always wait for network to settle after login
    await page.waitForLoadState("networkidle").catch(() => {
      // networkidle may not fire if there are persistent connections (websockets, polling)
    });

    // Additional wait for SPA re-render after auth state change
    await page.waitForTimeout(1000);

    return sawPositiveSignal;
  }

  /**
   * Wait for SPA frameworks to hydrate and become interactive.
   * Detects Vue, React, Angular, and Svelte applications.
   */
  private async waitForSpaReady(page: Page): Promise<void> {
    try {
      await page.waitForFunction(
        () => {
          // Vue 3: check if app is mounted
          const appEl =
            document.querySelector("#app") ??
            document.querySelector("[data-v-app]");
          if (appEl && "__vue_app__" in (appEl as object)) return true;

          // React: check for React root
          const rootEl = document.querySelector("#root");
          if (rootEl && "_reactRootContainer" in (rootEl as object))
            return true;
          if (document.querySelector("#__next")) return true;

          // Angular: check for ng-version
          if (document.querySelector("[ng-version]")) return true;

          // Generic: if document has completed loading and there are interactive elements
          if (document.readyState === "complete") {
            const forms = document.querySelectorAll("form");
            const inputs = document.querySelectorAll(
              'input, button[type="submit"]'
            );
            if (forms.length > 0 || inputs.length > 0) return true;
          }

          return false;
        },
        { timeout: 10_000 }
      );
    } catch {
      // Timeout waiting for SPA — continue anyway (might be SSR)
    }
  }

  /**
   * Set cookies on a browser context for authenticated access.
   */
  async loginWithCookies(
    context: BrowserContext,
    cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path?: string | undefined;
    }>
  ): Promise<void> {
    await context.addCookies(
      cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path ?? "/",
      }))
    );
  }

  /**
   * Detect if a page is a login page by checking for password fields.
   */
  async isLoginPage(page: Page): Promise<boolean> {
    const passwordFields = await page.locator('input[type="password"]').count();
    return passwordFields > 0;
  }

  /**
   * Discover the login page starting from the current page.
   *
   * If the current page already shows a login form, returns true without
   * navigating. Otherwise clicks the most likely sign-in link/button and
   * re-checks. Returns false when no login entry can be found.
   */
  async discoverLoginEntry(page: Page): Promise<boolean> {
    if (await this.isLoginPage(page)) return true;

    const candidate = page.locator(LOGIN_ENTRY_SELECTORS).first();
    if ((await candidate.count()) === 0) return false;

    await candidate.click();
    await page.waitForLoadState("networkidle").catch(() => {
      // persistent connections may prevent networkidle — continue
    });
    await this.waitForSpaReady(page);
    return this.isLoginPage(page);
  }

  /**
   * Full login flow: position on the login page (declared or discovered,
   * following any SSO redirects the target issues), fill + submit, verify.
   *
   * Bounded: at most `maxAttempts` (default 2) full attempts; each attempt is
   * bounded by the existing navigation/login timeouts. Never loops on failure —
   * repeated failed logins against shared auth risk lockout/rate-limiting.
   *
   * Never throws for login-level failures; returns `success: false` with a
   * stable failureCode/failureMessage instead. Infra errors still propagate.
   */
  async performLogin(
    page: Page,
    startUrl: string,
    creds: AuthCredentials,
    opts: LoginFlowOptions = {}
  ): Promise<LoginFlowResult> {
    const maxAttempts = opts.maxAttempts ?? 2;
    const traversed = new Set<string>();
    const recordOrigin = (): void => {
      try {
        traversed.add(new URL(page.url()).origin);
      } catch {
        // about:blank / invalid — ignore
      }
    };

    let lastFailure: LoginFlowResult | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const entryUrl = opts.loginUrl ?? startUrl;
      await page.goto(entryUrl, { waitUntil: "networkidle", timeout: 30_000 });
      recordOrigin();

      // Declared loginUrl: trust it but confirm a form is present.
      // No loginUrl: the target may bounce straight to a login/SSO wall
      // (common SSO case), else discover a sign-in link on the landing page.
      const onLoginPage = opts.loginUrl
        ? await this.isLoginPage(page)
        : await this.discoverLoginEntry(page);
      recordOrigin();

      if (!onLoginPage) {
        return {
          success: false,
          finalUrl: page.url(),
          loginPageUrl: null,
          traversedOrigins: [...traversed],
          failureCode: "LOGIN_PAGE_NOT_FOUND",
          failureMessage: `Scanner login page not found: no login form at ${entryUrl} and no sign-in link discovered.`,
        };
      }
      const loginPageUrl = page.url();

      const sawPositiveSignal = await this.fillAndSubmitLogin(page, {
        ...creds,
        loginUrl: undefined,
      });
      recordOrigin();

      // Success requires BOTH a positive signal (URL change or post-login DOM
      // indicator) AND the absence of a password field. Absence alone would
      // misclassify password-field-free interstitials (email verification,
      // CAPTCHA, IdP error pages) as successful logins.
      if (sawPositiveSignal && !(await this.isLoginPage(page))) {
        return {
          success: true,
          finalUrl: page.url(),
          loginPageUrl,
          traversedOrigins: [...traversed],
        };
      }

      lastFailure = {
        success: false,
        finalUrl: page.url(),
        loginPageUrl,
        traversedOrigins: [...traversed],
        failureCode: "LOGIN_FAILED",
        failureMessage: `Scanner login failed: still on a login page after submitting credentials (attempt ${attempt}/${maxAttempts}).`,
      };
    }
    // Loop ran at least once (maxAttempts >= 1), so lastFailure is set.
    return lastFailure as LoginFlowResult;
  }
}
