import type { Page, BrowserContext } from "playwright";
import type {
  AuthCredentials,
  BrowserAuthCookie,
  LoginFlowOptions,
  LoginFlowResult,
} from "../types.js";
import { loginWithCredentials } from "./auth-handler/credential-form.js";
import { loginWithCookies } from "./auth-handler/cookies.js";
import { discoverLoginEntry, isLoginPage } from "./auth-handler/discovery.js";
import { performLogin } from "./auth-handler/perform-login.js";

/**
 * Browser login-flow façade. Composes the per-concern leaf modules under
 * ./auth-handler/ into the stable public surface consumed by
 * browser-connector.ts and the @dzupagent/connectors-browser root barrel.
 *
 * The implementation was decomposed (ARCH-M-06 / MJ-01) from a single 670-LOC
 * god-module that fused three auth strategies (credential-form, cookie, SSO
 * pivot), post-credential interstitial resolution, and low-level SPA/navigation
 * readiness plumbing. Each concern now lives in its own leaf module:
 *   - selectors.ts       — selector catalogues + timeout bounds
 *   - readiness.ts       — SPA-hydration / navigation-ready / login-complete waits
 *   - credential-form.ts — username/password fill + submit strategy
 *   - cookies.ts         — cookie-seeding strategy
 *   - discovery.ts       — login-entry discovery + SSO entry
 *   - interstitials.ts   — account-picker / consent resolution + alert read
 *   - perform-login.ts   — full-flow orchestration (submit → verify → SSO pivot)
 *
 * This class is a thin delegator: signatures and behaviour are unchanged.
 */
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
    return loginWithCredentials(page, creds);
  }

  /**
   * Set cookies on a browser context for authenticated access.
   */
  async loginWithCookies(
    context: BrowserContext,
    cookies: BrowserAuthCookie[]
  ): Promise<void> {
    return loginWithCookies(context, cookies);
  }

  /**
   * Detect if a page is a login page by checking for password fields.
   */
  async isLoginPage(page: Page): Promise<boolean> {
    return isLoginPage(page);
  }

  /**
   * Discover the login page starting from the current page.
   *
   * If the current page already shows a login form, returns true without
   * navigating. Otherwise clicks the most likely sign-in link/button and
   * re-checks. Returns false when no login entry can be found.
   */
  async discoverLoginEntry(page: Page): Promise<boolean> {
    return discoverLoginEntry(page);
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
    return performLogin(page, startUrl, creds, opts);
  }
}
