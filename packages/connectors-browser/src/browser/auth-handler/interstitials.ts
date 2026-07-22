import type { Page } from "playwright";
import type { LoginFlowOptions } from "../../types.js";
import { LOGIN_TIMEOUT } from "./selectors.js";
import { waitForLoginComplete } from "./readiness.js";
import { isLoginPage } from "./discovery.js";

/**
 * Post-credential interstitial resolution: account/tenant pickers, consent
 * screens, and visible-alert extraction for failure enrichment. Extracted
 * from the former monolithic auth-handler.ts (ARCH-M-06 decomposition).
 */

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
export async function resolveAccountPickerInterstitial(
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
export async function resolveInterstitials(
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
      acted = await resolveAccountPickerInterstitial(page, opts.accountHint);
    }
    if (!acted) break;

    stepsTaken++;
    const sawPositiveSignal = await waitForLoginComplete(page, urlBeforeStep);
    recordOrigin();
    if (sawPositiveSignal && !(await isLoginPage(page))) {
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
export async function readVisibleAlert(page: Page): Promise<string | null> {
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
