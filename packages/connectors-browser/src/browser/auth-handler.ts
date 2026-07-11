import type { Page, BrowserContext } from "playwright";
import type {
  AuthCredentials,
  BrowserAuthCookie,
  LoginFlowOptions,
  LoginFlowResult,
} from "../types.js";

/** Default timeout for login operations (15 seconds). */
const LOGIN_TIMEOUT = 15_000;

/**
 * Short post-navigation readiness bound. Login pages commonly keep polling or
 * websocket connections open, so network-idle is not a usable readiness
 * signal. DOM readiness plus deterministic login/SSO controls is sufficient
 * before the normal discovery checks take over.
 */
const LOGIN_NAVIGATION_READY_TIMEOUT = 5_000;

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

/**
 * Selectors used to discover a sign-in entry point on a landing page, in
 * priority order (most specific/explicit first). Checked one at a time —
 * NOT joined into a single combined-selector locator — so that a broad,
 * generic match (e.g. `a[href*="auth" i]`) can never win over an explicit
 * "Log in"/"Sign in" link just because it happens to render earlier in the
 * DOM.
 */
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
];

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
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await this.waitForLoginNavigationReady(page);
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

    // Let a cross-document redirect or SPA render expose its controls without
    // requiring polling/websocket traffic to become idle.
    await this.waitForLoginNavigationReady(page);

    // Additional wait for SPA re-render after auth state change
    await page.waitForTimeout(1000);

    return sawPositiveSignal;
  }

  /**
   * Wait for SPA frameworks to hydrate and become interactive.
   * Detects Vue, React, Angular, and Svelte applications.
   */
  private async waitForSpaReady(
    page: Page,
    timeout = 10_000
  ): Promise<void> {
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
        undefined,
        { timeout }
      );
    } catch {
      // Timeout waiting for SPA — continue anyway (might be SSR)
    }
  }

  /**
   * Wait briefly for a login navigation to become inspectable. This deliberately
   * avoids `networkidle`: authentication pages often maintain persistent
   * traffic. The readiness signals only end the wait; the deterministic form,
   * login-entry, and SSO selectors still decide what action is allowed.
   */
  private async waitForLoginNavigationReady(page: Page): Promise<void> {
    await page
      .waitForLoadState("domcontentloaded", {
        timeout: LOGIN_NAVIGATION_READY_TIMEOUT,
      })
      .catch(() => {
        // Same-document SPA transitions do not emit a new load state.
      });

    await page
      .waitForFunction(
        () => {
          if (document.readyState === "complete") return true;
          if (document.querySelector('input[type="password"]')) return true;
          if (
            document.querySelector(
              '[data-test*="login" i], [data-testid*="login" i], [data-test*="signin" i], [data-testid*="signin" i], [data-test*="sso" i], [data-testid*="sso" i]'
            )
          ) {
            return true;
          }

          return Array.from(document.querySelectorAll("a, button")).some(
            (element) =>
              /^(log\s*in|login|sign\s*in|continue with single sign[- ]?on|sso)$/i.test(
                element.textContent?.trim() ?? ""
              )
          );
        },
        undefined,
        { timeout: LOGIN_NAVIGATION_READY_TIMEOUT }
      )
      .catch(() => {
        // Discovery performs a second bounded pass for delayed SPA redirects.
      });
  }

  /**
   * Set cookies on a browser context for authenticated access.
   */
  async loginWithCookies(
    context: BrowserContext,
    cookies: BrowserAuthCookie[]
  ): Promise<void> {
    await context.addCookies(
      cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path ?? "/",
        secure: c.secure ?? true,
        httpOnly: c.httpOnly ?? true,
        sameSite: c.sameSite ?? "Lax",
        ...(c.expires !== undefined ? { expires: c.expires } : {}),
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
    // Two passes: SPAs often mount an app shell first (satisfying DOM readiness)
    // and only then run an auth check that client-side
    // redirects to the real login route. A single immediate inspection races
    // that redirect and reports LOGIN_PAGE_NOT_FOUND on a skeleton page.
    for (let pass = 0; pass < 2; pass++) {
      if (pass > 0) {
        await page.waitForTimeout(2_000);
        await this.waitForLoginNavigationReady(page);
      }

      if (await this.isLoginPage(page)) return true;

      let candidate = null;
      for (const selector of LOGIN_ENTRY_SELECTORS) {
        const locator = page.locator(selector).first();
        if ((await locator.count()) > 0) {
          candidate = locator;
          break;
        }
      }
      if (!candidate) {
        // SSO-only login pages expose no password form and no "Log in" link —
        // just an SSO entry button. Enter SSO and check the IdP for a form.
        if (await this.enterSsoProvider(page)) return this.isLoginPage(page);
        continue;
      }

      await candidate.click();
      await this.waitForLoginNavigationReady(page);
      return this.isLoginPage(page);
    }
    return false;
  }

  /**
   * Built-in resolver for account/tenant-picker interstitials: a group of
   * radio options plus an explicit Continue/Next-style button (the pattern
   * IdPs use for "select your organisation" after credential submit).
   *
   * Acts only when BOTH the options and the button are present — pages that
   * merely re-show the login form (wrong credentials) or show an error never
   * match, so they still fail as LOGIN_FAILED. Picks the option whose
   * accessible name matches `accountHint` (case-insensitive substring), else
   * the first option. Returns whether an action was performed.
   */
  private async resolveAccountPickerInterstitial(
    page: Page,
    accountHint?: string
  ): Promise<boolean> {
    const options = page.locator('input[type="radio"], [role="radio"]');
    if ((await options.count()) === 0) return false;

    // Explicit continue-style button, exact accessible name only — a broad
    // `:has-text("Continue")` would also match SSO buttons like
    // "Continue with Google", and a bare `button[type="submit"]` fallback
    // could re-click the credential submit button and loop.
    const continueButton = page
      .getByRole("button", { name: /^(continue|next|proceed|select|choose)$/i })
      .first();
    if ((await continueButton.count()) === 0) return false;

    let choice = options.first();
    if (accountHint) {
      const hinted = page
        .getByRole("radio", { name: accountHint, exact: false })
        .first();
      if ((await hinted.count()) > 0) choice = hinted;
    }

    try {
      await choice.click({ timeout: LOGIN_TIMEOUT });
      // Pickers commonly enable the button only after selection —
      // Playwright's click auto-waits for it to become enabled.
      await continueButton.click({ timeout: LOGIN_TIMEOUT });
      return true;
    } catch {
      // Option or button not actionable (hidden styled input, overlay…) —
      // report no action so the flow fails with an honest LOGIN_FAILED.
      return false;
    }
  }

  /**
   * Resolve post-credential interstitial screens until login verifies or no
   * resolver can act. Consults `opts.onInterstitial` first (custom/LLM-guided
   * resolver), falling back to the built-in account-picker heuristic.
   * Bounded by `maxInterstitialSteps` (default 3).
   */
  private async resolveInterstitials(
    page: Page,
    loginPageUrl: string,
    opts: LoginFlowOptions,
    recordOrigin: () => void
  ): Promise<{ success: boolean; stepsTaken: number }> {
    const maxSteps = opts.maxInterstitialSteps ?? 3;
    let stepsTaken = 0;

    for (let step = 0; step < maxSteps; step++) {
      const urlBeforeStep = page.url();

      let acted = false;
      if (opts.onInterstitial) {
        acted =
          (await opts.onInterstitial(page, {
            stepIndex: step,
            loginPageUrl,
            accountHint: opts.accountHint,
          })) === "acted";
      }
      if (!acted) {
        acted = await this.resolveAccountPickerInterstitial(
          page,
          opts.accountHint
        );
      }
      if (!acted) break;

      stepsTaken++;
      const sawPositiveSignal = await this.waitForLoginComplete(
        page,
        urlBeforeStep
      );
      recordOrigin();
      if (sawPositiveSignal && !(await this.isLoginPage(page))) {
        return { success: true, stepsTaken };
      }
    }
    return { success: false, stepsTaken };
  }

  /**
   * Read the visible error/alert text on the current page, if any — login
   * pages surface rejection reasons ("wrong password", "verify your email")
   * in an alert region. Used to enrich failure messages only.
   */
  private async readVisibleAlert(page: Page): Promise<string | null> {
    try {
      const alert = page
        .locator('[role="alert"], [aria-live="assertive"]')
        .first();
      if ((await alert.count()) === 0) return null;
      const text = (await alert.textContent())?.trim().replace(/\s+/g, " ");
      return text ? text.slice(0, 200) : null;
    } catch {
      return null;
    }
  }

  /**
   * Click an explicit SSO entry ("Continue with single sign-on", an
   * SSO-marked button/link) on the current login page, if one exists.
   * Word-bounded matching so "SSO" never matches "lessons"/"associated",
   * and provider-branded social buttons ("Continue with Google") are
   * deliberately NOT matched — scanner credentials are first-party.
   * Returns whether an entry was clicked (page then settled).
   */
  private async enterSsoProvider(page: Page): Promise<boolean> {
    const candidates = [
      page
        .locator("button, a")
        .filter({ hasText: /single sign[- ]?on|\bSSO\b/i })
        .first(),
      page.locator('[data-test*="sso" i], [data-testid*="sso" i]').first(),
    ];
    for (const candidate of candidates) {
      if ((await candidate.count()) === 0) continue;
      try {
        await candidate.click({ timeout: LOGIN_TIMEOUT });
      } catch {
        return false;
      }
      await this.waitForLoginNavigationReady(page);
      return true;
    }
    return false;
  }

  /**
   * Submit credentials on the current login page and verify the outcome,
   * resolving any post-credential interstitials. One bounded unit of work —
   * no navigation back to the entry URL.
   */
  private async submitAndVerify(
    page: Page,
    creds: AuthCredentials,
    opts: LoginFlowOptions,
    recordOrigin: () => void,
    loginPageUrl: string
  ): Promise<{ success: boolean; interstitialStepsTaken: number }> {
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
      return { success: true, interstitialStepsTaken: 0 };
    }

    // No direct success — the IdP may have interposed an interstitial
    // (account/tenant picker, consent). Try to resolve it before declaring
    // the attempt failed.
    const interstitial = await this.resolveInterstitials(
      page,
      loginPageUrl,
      opts,
      recordOrigin
    );
    return {
      success: interstitial.success,
      interstitialStepsTaken: interstitial.stepsTaken,
    };
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
    // The SSO pivot is tried at most once per flow — if the IdP also rejects
    // the credentials, retrying the pivot would just hammer shared auth.
    let ssoPivotUsed = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const entryUrl = opts.loginUrl ?? startUrl;
      await page.goto(entryUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await this.waitForLoginNavigationReady(page);
      recordOrigin();

      // Declared or not, `discoverLoginEntry` first checks whether the page
      // already shows a login form, then falls back to following a sign-in
      // link. For a declared loginUrl this doubles as recovery when the URL
      // is wrong/expired (404, error page) but still links to the real form;
      // without one, the target may bounce straight to a login/SSO wall.
      const onLoginPage = await this.discoverLoginEntry(page);
      recordOrigin();

      if (!onLoginPage) {
        const declaredHint = opts.loginUrl
          ? " The declared Login URL did not show a password field — verify it opens the login form directly."
          : "";
        return {
          success: false,
          finalUrl: page.url(),
          loginPageUrl: null,
          traversedOrigins: [...traversed],
          failureCode: "LOGIN_PAGE_NOT_FOUND",
          failureMessage: `Scanner login page not found: no login form at ${entryUrl} and no sign-in link discovered.${declaredHint}`,
        };
      }
      let loginPageUrl = page.url();

      let outcome = await this.submitAndVerify(
        page,
        creds,
        opts,
        recordOrigin,
        loginPageUrl
      );

      // SSO pivot: the app's local login form rejected the credentials, but
      // the login page offers an explicit SSO entry — the credentials likely
      // belong to the identity provider. Enter SSO and log in there.
      if (
        !outcome.success &&
        !ssoPivotUsed &&
        (await this.isLoginPage(page)) &&
        (await this.enterSsoProvider(page))
      ) {
        ssoPivotUsed = true;
        recordOrigin();
        if (await this.isLoginPage(page)) {
          loginPageUrl = page.url();
          outcome = await this.submitAndVerify(
            page,
            creds,
            opts,
            recordOrigin,
            loginPageUrl
          );
        }
      }

      if (outcome.success) {
        return {
          success: true,
          finalUrl: page.url(),
          loginPageUrl,
          traversedOrigins: [...traversed],
          interstitialStepsTaken: outcome.interstitialStepsTaken,
        };
      }

      const visibleAlert = await this.readVisibleAlert(page);
      const alertSuffix = visibleAlert
        ? ` The login page reported: "${visibleAlert}"`
        : "";
      lastFailure = {
        success: false,
        finalUrl: page.url(),
        loginPageUrl,
        traversedOrigins: [...traversed],
        failureCode: "LOGIN_FAILED",
        failureMessage:
          (outcome.interstitialStepsTaken > 0
            ? `Scanner login failed: credentials were submitted but the flow stalled on an intermediate step after ${outcome.interstitialStepsTaken} resolved interstitial(s) (attempt ${attempt}/${maxAttempts}).`
            : `Scanner login failed: still on a login page after submitting credentials (attempt ${attempt}/${maxAttempts}).`) +
          alertSuffix,
        interstitialStepsTaken: outcome.interstitialStepsTaken,
      };
    }
    // Loop ran at least once (maxAttempts >= 1), so lastFailure is set.
    return lastFailure as LoginFlowResult;
  }
}
