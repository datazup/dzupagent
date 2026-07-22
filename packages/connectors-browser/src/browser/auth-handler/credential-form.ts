import type { Page } from "playwright";
import type { AuthCredentials } from "../../types.js";
import { LOGIN_TIMEOUT } from "./selectors.js";
import {
  waitForLoginComplete,
  waitForLoginNavigationReady,
  waitForSpaReady,
} from "./readiness.js";

/**
 * Credential-form authentication strategy: locate the username/password
 * fields, fill them, and submit. Handles both traditional form-based and SPA
 * login flows. Extracted from the former monolithic auth-handler.ts
 * (ARCH-M-06 decomposition).
 */

/**
 * Login using username/password credentials.
 * Handles both traditional form-based and SPA login flows:
 * - Waits for SPA hydration before interacting with forms
 * - Handles JS-based redirects after login
 * - Detects successful login via URL change or DOM indicators
 */
export async function loginWithCredentials(
  page: Page,
  creds: AuthCredentials
): Promise<void> {
  if (creds.loginUrl) {
    await page.goto(creds.loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await waitForLoginNavigationReady(page);
  }
  await fillAndSubmitLogin(page, creds);
}

/**
 * Fill and submit the login form on the current page. Does not navigate
 * to a login URL — callers position the page first.
 */
export async function fillAndSubmitLogin(
  page: Page,
  creds: AuthCredentials
): Promise<boolean> {
  // Wait for SPA hydration — login forms may not be interactive until JS loads
  await waitForSpaReady(page);

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
  const positiveSignal = await waitForLoginComplete(page, urlBeforeLogin);
  return positiveSignal;
}
