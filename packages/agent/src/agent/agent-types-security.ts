/**
 * Security/content-scanning slice of {@link DzupAgentConfig.security}.
 *
 * Extracted from the original `agent-types.ts` barrel — see that file for the
 * authoritative re-exports.
 */

/** Per-channel content-scanning policy mode. */
export type PromptInjectionMode = 'off' | 'warn' | 'block'

/** Per-channel PII scanning mode. */
export type PiiScanMode = 'off' | 'redact' | 'block'

/**
 * OWASP-aligned content scanning configuration (audit MC-01 / AG-08 / AG-09).
 *
 * Wires `@dzupagent/security`'s `ContentScanner` into the agent's run lifecycle:
 *
 * - `promptInjection: 'block'` — every incoming `HumanMessage` is scanned
 *   in `prepareRunState`. A finding aborts the run with
 *   `PromptInjectionBlockedError`.
 * - `promptInjection: 'warn'` — matched spans are rewritten with
 *   `[REDACTED-INJECTION]` before reaching the model.
 * - `promptInjection: 'off'` — no scanning (explicit compatibility opt-out).
 * - `pii: 'redact'` — final response content is sanitized before memory
 *   write-back so SSN / CC / IBAN / JWT / API-key values never land on disk.
 * - `pii: 'block'` — any PII finding fails the write-back step (still
 *   non-fatal to the run; failure is emitted on `eventBus`).
 * - `pii: 'off'` — no scanning (legacy behaviour).
 *
 * Omitting `promptInjection` defaults to `'warn'` so suspicious user input
 * is sanitized before model invocation without failing legacy flows.
 */
export interface SecurityConfig {
  promptInjection?: PromptInjectionMode
  pii?: PiiScanMode
  /** PII scanning applied to every tool result before it reaches the model. */
  piiToolResults?: PiiScanMode
  /** Prompt-injection scanning applied to every tool result. */
  promptInjectionToolResults?: PromptInjectionMode
}
