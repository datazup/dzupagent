/**
 * Canonical security policy configuration shared by every consumer of
 * `@dzupagent/security`.
 *
 * Hosts ({@link ContentScanner}, the core `SafetyMonitor`, agent run loops,
 * connectors) MUST honour the same policy semantics so operators can reason
 * about a single policy surface regardless of where the scan happens.
 *
 * Policy semantics:
 * - `'off'` — skip the rule entirely. No scanning, no events.
 * - `promptInjection: 'warn'` / `pii: 'redact'` — detect and report at a
 *   reduced severity (`'medium'` / `'warning'`). Hosts SHOULD continue the
 *   run but MAY rewrite or annotate the offending content.
 * - `'block'` — detect and stop. Hosts MUST refuse to forward the content
 *   to the LLM or the user; severity is `'high'` / `'critical'`.
 *
 * `toolAbuse` and `escalation` are host-specific extensions that the
 * canonical scanner does not implement; they remain in the core monitor
 * but are surfaced here so a single object can drive the whole stack.
 */
export interface SecurityPolicyConfig {
  /** Prompt-injection scanning policy. */
  promptInjection: 'off' | 'warn' | 'block'
  /** PII scanning policy. */
  pii: 'off' | 'redact' | 'block'
  /**
   * Consecutive tool-error limit. Implemented by the core `SafetyMonitor`
   * rather than the canonical content scanner.
   */
  toolAbuse?: {
    maxCallsPerTool?: number
  }
  /** Privilege-escalation scanning policy. */
  escalation: 'off' | 'warn' | 'block'
}
