import type { Page } from "playwright";
import type {
  AuthCredentials,
  LoginFlowOptions,
  LoginFlowResult,
} from "../../types.js";
import { fillAndSubmitLogin } from "./credential-form.js";
import { waitForLoginNavigationReady } from "./readiness.js";
import {
  discoverLoginEntry,
  enterSsoProvider,
  isLoginPage,
} from "./discovery.js";
import { readVisibleAlert, resolveInterstitials } from "./interstitials.js";

/**
 * Full login-flow orchestration: position on the login page, submit + verify,
 * resolve interstitials, and pivot to SSO on local-credential rejection.
 * Extracted from the former monolithic auth-handler.ts (ARCH-M-06
 * decomposition).
 */

/**
 * Submit credentials on the current login page and verify the outcome,
 * resolving any post-credential interstitials. One bounded unit of work —
 * no navigation back to the entry URL.
 */
async function submitAndVerify(
  page: Page,
  creds: AuthCredentials,
  opts: LoginFlowOptions,
  recordOrigin: () => void,
  loginPageUrl: string
): Promise<{ success: boolean; interstitialStepsTaken: number }> {
  const sawPositiveSignal = await fillAndSubmitLogin(page, {
    ...creds,
    loginUrl: undefined,
  });
  recordOrigin();

  // Success requires BOTH a positive signal (URL change or post-login DOM
  // indicator) AND the absence of a password field. Absence alone would
  // misclassify password-field-free interstitials (email verification,
  // CAPTCHA, IdP error pages) as successful logins.
  if (sawPositiveSignal && !(await isLoginPage(page))) {
    return { success: true, interstitialStepsTaken: 0 };
  }

  // No direct success — the IdP may have interposed an interstitial
  // (account/tenant picker, consent). Try to resolve it before declaring
  // the attempt failed.
  const interstitial = await resolveInterstitials(
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
export async function performLogin(
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
    await waitForLoginNavigationReady(page);
    recordOrigin();

    // Declared or not, `discoverLoginEntry` first checks whether the page
    // already shows a login form, then falls back to following a sign-in
    // link. For a declared loginUrl this doubles as recovery when the URL
    // is wrong/expired (404, error page) but still links to the real form;
    // without one, the target may bounce straight to a login/SSO wall.
    const onLoginPage = await discoverLoginEntry(page);
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

    let outcome = await submitAndVerify(
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
      (await isLoginPage(page)) &&
      (await enterSsoProvider(page))
    ) {
      ssoPivotUsed = true;
      recordOrigin();
      if (await isLoginPage(page)) {
        loginPageUrl = page.url();
        outcome = await submitAndVerify(
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

    const visibleAlert = await readVisibleAlert(page);
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
