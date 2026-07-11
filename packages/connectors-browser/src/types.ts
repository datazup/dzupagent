import type { Page } from "playwright";

export interface CrawlOptions {
  maxPages: number;
  maxDepth: number;
  includePatterns?: string[] | undefined;
  excludePatterns?: string[] | undefined;
  waitForIdle?: number | undefined;
  sameOrigin?: boolean | undefined;
  allowedOrigins?: string[] | undefined;
  allowCrossOrigin?: boolean | undefined;
  navigationPolicy?: BrowserNavigationPolicy | undefined;
}

export interface BrowserNavigationPolicy {
  allowedProtocols?: string[] | undefined;
  allowedOrigins?: string[] | undefined;
  allowedHosts?: string[] | undefined;
  allowPrivateNetwork?: boolean | undefined;
  /**
   * Disable the DNS-resolved-IP SSRF check. The policy then validates only the
   * literal hostname/IP and any explicit allow/deny lists. Intended for tests or
   * constrained runtimes with no DNS; leave unset (DNS checks on) in production.
   */
  resolveDns?: boolean | undefined;
  /**
   * DNS lookup override for deterministic tests. Receives the (bracket-stripped)
   * hostname and must resolve to every address that hostname maps to, so the
   * policy can block when ANY resolved address is private/reserved
   * (DNS-rebinding defense).
   */
  lookup?:
    | ((hostname: string) => Promise<ReadonlyArray<NavigationResolvedAddress>>)
    | undefined;
}

export interface NavigationResolvedAddress {
  address: string;
  family?: number | undefined;
}

export interface CrawlResult {
  url: string;
  title: string;
  depth: number;
  links: string[];
  accessibilityTree: AccessibilityNode[];
  screenshot: Buffer;
  screenshotMimeType: string;
  forms: FormInfo[];
  interactiveElements: ElementInfo[];
  loadTimeMs: number;
}

export interface AccessibilityNode {
  role: string;
  name: string;
  value?: string | undefined;
  description?: string | undefined;
  depth: number;
  disabled?: boolean | undefined;
  checked?: boolean | undefined;
  expanded?: boolean | undefined;
  selected?: boolean | undefined;
  required?: boolean | undefined;
}

export interface FormInfo {
  action: string;
  method: string;
  fields: FormField[];
}

export interface FormField {
  name: string;
  type: string;
  label: string | null;
  placeholder: string | null;
  required: boolean;
  options?: string[] | undefined;
}

export interface ElementInfo {
  role: string;
  label: string;
  enabled: boolean;
  visible: boolean;
  location: string;
  ariaAttributes: Record<string, string>;
}

export interface AuthCredentials {
  loginUrl?: string | undefined;
  username: string;
  password: string;
  usernameSelector?: string | undefined;
  passwordSelector?: string | undefined;
}

export interface LoginInterstitialContext {
  /** Zero-based index of the interstitial step being resolved. */
  stepIndex: number;
  /** Login page the credentials were submitted on. */
  loginPageUrl: string;
  /** Operator hint for account/tenant pickers, when provided. */
  accountHint?: string | undefined;
}

/**
 * Resolver for post-credential interstitial screens (account/tenant pickers,
 * consent prompts). Returns "acted" after performing exactly one page action
 * (the flow then re-verifies login), or "skip" to let the built-in
 * account-picker heuristic try. Must never submit credentials itself.
 */
export type LoginInterstitialResolver = (
  page: Page,
  ctx: LoginInterstitialContext
) => Promise<"acted" | "skip">;

export interface LoginFlowOptions {
  /** Operator-declared login page; skips discovery when set. */
  loginUrl?: string | undefined;
  /** Total login attempts (default 2 — one retry; never hammer shared auth). */
  maxAttempts?: number | undefined;
  /**
   * Custom resolver consulted first on each post-credential interstitial
   * (e.g. an LLM-guided navigator). The built-in account-picker heuristic
   * runs when this is absent or returns "skip".
   */
  onInterstitial?: LoginInterstitialResolver | undefined;
  /** Max interstitial steps resolved after credential submit (default 3). */
  maxInterstitialSteps?: number | undefined;
  /**
   * Text identifying which account/tenant/organisation to pick on an
   * account-picker interstitial (matched case-insensitively against option
   * labels; first option is used when absent or unmatched).
   */
  accountHint?: string | undefined;
}

export interface LoginFlowResult {
  success: boolean;
  /** Where the browser landed after the flow (post-login page on success). */
  finalUrl: string;
  /** Login page actually used (discovered or declared); null if never found. */
  loginPageUrl: string | null;
  /** Origins traversed during the login transaction — logging/audit only.
   *  MUST NOT be fed into any crawl frontier / allowed-origins set. */
  traversedOrigins: string[];
  failureCode?: "LOGIN_PAGE_NOT_FOUND" | "LOGIN_FAILED" | undefined;
  failureMessage?: string | undefined;
  /** Post-credential interstitial steps resolved (0 = plain form login). */
  interstitialStepsTaken?: number | undefined;
}

export interface ScreenshotResult {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

export interface BrowserLaunchOptions {
  headless?: boolean | undefined;
  viewport?: { width: number; height: number } | undefined;
  proxy?: { server: string } | undefined;
}
