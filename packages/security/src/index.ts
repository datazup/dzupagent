/**
 * `@dzupagent/security` — OWASP-aligned prompt-injection and PII defense.
 *
 * Public surface:
 * - {@link PromptInjectionDetector} / {@link PromptInjectionBlockedError}
 *   — pattern-driven scanner for the OWASP LLM01 injection family.
 * - {@link PiiDetector} — regex-based PII detector with sanitization.
 * - {@link ContentScanner} — combined orchestrator wired into the agent
 *   run loop and finalizers.
 *
 * The package has zero runtime dependencies so it can be safely
 * consumed by every workspace package.
 *
 * @module @dzupagent/security
 */
export {
  INJECTION_PATTERNS,
  INJECTION_REDACTION,
  PromptInjectionDetector,
  PromptInjectionBlockedError,
} from "./prompt-injection/index.js";
export type {
  InjectionFinding,
  InjectionScanResult,
  InjectionVerdict,
} from "./prompt-injection/index.js";

export { PII_PATTERNS, PiiDetector } from "./pii/index.js";
export type {
  PiiCanonicalType,
  PiiDetailedScanResult,
  PiiMatch,
  PiiScanResult,
} from "./pii/index.js";

export {
  FixedWindowRateLimiter,
  KeyedTokenBucketRateLimiter,
} from "./rate-limit/index.js";
export type {
  FixedWindowRateLimiterConfig,
  KeyedTokenBucketConfig,
  TokenBucketConsumeResult,
} from "./rate-limit/index.js";

export { PromptInjectionGuard } from "./guardrails/index.js";
export type { GuardOptions, ScreenResult } from "./guardrails/index.js";

export { ContentScanner } from "./content-scanner.js";
export type {
  ContentScannerConfig,
  ContentScanResult,
  ContentScanVerdict,
  PromptInjectionMode,
  PiiMode,
} from "./content-scanner.js";

export type { SecurityPolicyConfig } from "./policy-config.js";

// Shared low-tier pattern DATA for the core content-sanitizer (Layer 1) and
// the memory-sanitizer. One source of truth prevents the two byte-identical
// copies from drifting (audit finding DZUPAGENT-CODE-H-03).
export {
  SANITIZER_INJECTION_PATTERNS,
  SANITIZER_EXFILTRATION_PATTERNS,
  SANITIZER_INVISIBLE_UNICODE_PATTERN,
  SANITIZER_INVISIBLE_UNICODE_STRIP_PATTERN,
} from "./sanitizer-patterns.js";
export type { LabeledPattern } from "./sanitizer-patterns.js";
