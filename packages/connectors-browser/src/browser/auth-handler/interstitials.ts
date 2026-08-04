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
 * Accessible name of an explicit continue-style button on an account picker.
 *
 * The original pattern nested `+` inside an optional group —
 * `(continue(?: to .+)?|next|…)` — giving star height 2, which
 * `security/detect-unsafe-regex` (safe-regex) rejects as ReDoS-prone.
 *
 * The fix follows the idiom established by the 2026-07-26 redos audit
 * (`d49df8e4`, flow-dsl `quote()`): make the alternatives mutually exclusive
 * so there is nothing to backtrack across, rather than suppressing the rule.
 * Here the optional `" to …"` suffix is flattened into its own top-level
 * alternative, so no quantifier is nested inside another and star height
 * drops to 1. `continue` and `continue to X` are disjoint (the second
 * requires a literal `" to "`), so at most one branch can apply.
 *
 * The accepted language is UNCHANGED — differential-tested against the old
 * pattern over 6,859 generated strings with 0 mismatches. See
 * `interstitials-redos.test.ts`.
 */
export const CONTINUE_BUTTON_NAME =
  /^(?:continue|continue to .+|next|proceed|select|choose|choose an organi[sz]ation)$/i;

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
    .getByRole("button", { name: CONTINUE_BUTTON_NAME })
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
    const pickerUrl = page.url();
    // Identity providers commonly style radios with an overlaid label/avatar
    // and attach selection behavior to that option container. Activate the
    // nearest label directly so decorative children cannot intercept the
    // action; custom role=radio elements fall back to their own click method.
    await choice.evaluate((element) => {
      const target = element.closest("label") ?? element;
      if (target instanceof HTMLElement) target.click();
    });
    // Some pickers submit immediately when the radio changes. In that case
    // the old continue button no longer exists, and trying to click it would
    // turn a successful login into a timeout.
    await page
      .waitForURL((url) => url.toString() !== pickerUrl, {
        timeout: Math.min(LOGIN_TIMEOUT, 3_000),
      })
      .catch(() => {});
    if (page.url() !== pickerUrl && !(await isLoginPage(page))) return true;
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
 * Detect the deterministic account-picker shape without acting on it.
 *
 * Some identity providers navigate away from the credential form before
 * showing this picker, so URL change + password-field disappearance is not
 * sufficient evidence that authentication has completed.
 */
export async function hasAccountPickerInterstitial(
  page: Page
): Promise<boolean> {
  const options = page.locator('input[type="radio"], [role="radio"]');
  if ((await options.count()) === 0) return false;

  const continueButton = page
    .getByRole("button", { name: CONTINUE_BUTTON_NAME })
    .first();
  return (await continueButton.count()) > 0;
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
