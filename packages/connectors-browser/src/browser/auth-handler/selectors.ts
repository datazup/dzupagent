/**
 * Selector catalogues and timeout bounds shared across the login-flow leaf
 * modules. Pure data — no behaviour. Extracted from the former monolithic
 * auth-handler.ts as part of the ARCH-M-06 god-module decomposition.
 */

/** Default timeout for login operations (15 seconds). */
export const LOGIN_TIMEOUT = 15_000;

/**
 * Short post-navigation readiness bound. Login pages commonly keep polling or
 * websocket connections open, so network-idle is not a usable readiness
 * signal. DOM readiness plus deterministic login/SSO controls is sufficient
 * before the normal discovery checks take over.
 */
export const LOGIN_NAVIGATION_READY_TIMEOUT = 5_000;

/** Common selectors for detecting post-login state. */
export const POST_LOGIN_INDICATORS = [
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
export const LOGIN_ENTRY_SELECTORS = [
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
