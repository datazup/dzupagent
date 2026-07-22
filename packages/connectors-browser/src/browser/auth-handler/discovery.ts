import type { Page } from "playwright";
import { LOGIN_ENTRY_SELECTORS, LOGIN_TIMEOUT } from "./selectors.js";
import { waitForLoginNavigationReady } from "./readiness.js";

/**
 * Login-entry discovery and SSO-entry strategy: decide whether the current
 * page is a login form, follow the most likely sign-in link, and click an
 * explicit SSO entry when present. Extracted from the former monolithic
 * auth-handler.ts (ARCH-M-06 decomposition).
 */

/**
 * Detect if a page is a login page by checking for password fields.
 */
export async function isLoginPage(page: Page): Promise<boolean> {
  const passwordFields = await page.locator('input[type="password"]').count();
  return passwordFields > 0;
}

/**
 * Click an explicit SSO entry ("Continue with single sign-on", an
 * SSO-marked button/link) on the current login page, if one exists.
 * Word-bounded matching so "SSO" never matches "lessons"/"associated",
 * and provider-branded social buttons ("Continue with Google") are
 * deliberately NOT matched — scanner credentials are first-party.
 * Returns whether an entry was clicked (page then settled).
 */
export async function enterSsoProvider(page: Page): Promise<boolean> {
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
    await waitForLoginNavigationReady(page);
    return true;
  }
  return false;
}

/**
 * Discover the login page starting from the current page.
 *
 * If the current page already shows a login form, returns true without
 * navigating. Otherwise clicks the most likely sign-in link/button and
 * re-checks. Returns false when no login entry can be found.
 */
export async function discoverLoginEntry(page: Page): Promise<boolean> {
  // Two passes: SPAs often mount an app shell first (satisfying DOM readiness)
  // and only then run an auth check that client-side
  // redirects to the real login route. A single immediate inspection races
  // that redirect and reports LOGIN_PAGE_NOT_FOUND on a skeleton page.
  for (let pass = 0; pass < 2; pass++) {
    if (pass > 0) {
      await page.waitForTimeout(2_000);
      await waitForLoginNavigationReady(page);
    }

    if (await isLoginPage(page)) return true;

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
      if (await enterSsoProvider(page)) return isLoginPage(page);
      continue;
    }

    await candidate.click();
    await waitForLoginNavigationReady(page);
    return isLoginPage(page);
  }
  return false;
}
