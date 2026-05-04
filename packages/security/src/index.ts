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
} from './prompt-injection/index.js'
export type {
  InjectionFinding,
  InjectionScanResult,
  InjectionVerdict,
} from './prompt-injection/index.js'

export { PII_PATTERNS, PiiDetector } from './pii/index.js'
export type { PiiScanResult } from './pii/index.js'

export { ContentScanner } from './content-scanner.js'
export type {
  ContentScannerConfig,
  ContentScanResult,
  ContentScanVerdict,
  PromptInjectionMode,
  PiiMode,
} from './content-scanner.js'
