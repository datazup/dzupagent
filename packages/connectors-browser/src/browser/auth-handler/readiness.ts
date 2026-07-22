import type { Page } from "playwright";
import {
  LOGIN_NAVIGATION_READY_TIMEOUT,
  LOGIN_TIMEOUT,
  POST_LOGIN_INDICATORS,
} from "./selectors.js";

/**
 * Low-level browser-driver readiness plumbing for the login flow. These
 * helpers decide only *when* the page is inspectable; the deterministic form,
 * login-entry, and SSO selectors decide *what* action is allowed. Extracted
 * from the former monolithic auth-handler.ts (ARCH-M-06 decomposition).
 */

/**
 * Wait for SPA frameworks to hydrate and become interactive.
 * Detects Vue, React, Angular, and Svelte applications.
 */
export async function waitForSpaReady(
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
        if (rootEl && "_reactRootContainer" in (rootEl as object)) return true;
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
export async function waitForLoginNavigationReady(page: Page): Promise<void> {
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
 * Wait for login to complete using multiple detection strategies.
 * SPAs may use URL changes, DOM updates, or token storage.
 *
 * Returns whether a positive success signal (URL change or a post-login DOM
 * indicator) actually fired. Absence of a password field alone is NOT proof
 * of success — interstitials like email verification, CAPTCHA, or an IdP
 * error page also lack a password field, so callers must combine this with
 * `isLoginPage`.
 */
export async function waitForLoginComplete(
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
  await waitForLoginNavigationReady(page);

  // Additional wait for SPA re-render after auth state change
  await page.waitForTimeout(1000);

  return sawPositiveSignal;
}
