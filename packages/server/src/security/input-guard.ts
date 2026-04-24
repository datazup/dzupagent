/**
 * InputGuard — prompt-injection defense pipeline for HTTP run creation.
 *
 * Scans untrusted run inputs at the HTTP boundary / pre-execute hook so that
 * obviously malicious or policy-violating payloads are rejected (or their
 * sensitive fragments redacted) before they reach the agent tool loop.
 *
 * The guard wraps two existing core primitives:
 *
 * 1. {@link createSafetyMonitor} — provides the built-in `prompt_injection`,
 *    `secret_leak`, and `escalation` rules. Any violation whose `action` is
 *    `'block'` or `'kill'` (severity `critical`/`emergency`) causes the input
 *    to be rejected with `{ allowed: false, reason }`.
 * 2. {@link detectPII} — when `redactPii` is enabled, the raw string form of
 *    the input is passed through the PII redactor and the redacted value is
 *    returned via `redactedInput`. Callers are expected to overwrite the run
 *    input with `redactedInput` before persistence/dispatch.
 *
 * A hard ceiling on the serialized input length (`maxInputLength`, default
 * 50_000 chars) is enforced first — oversized payloads are rejected without
 * running the full scanner pipeline, keeping CPU bounded under abuse.
 */

import { createSafetyMonitor, detectPII } from '@dzupagent/core'
import type { SafetyMonitor, SafetyViolation } from '@dzupagent/core'

/** Default maximum serialized input length (characters). */
export const DEFAULT_MAX_INPUT_LENGTH = 50_000

export interface InputGuardConfig {
  /**
   * Maximum serialized input length in characters. Inputs whose JSON
   * representation exceeds this are rejected without scanning.
   * @default 50_000
   */
  maxInputLength?: number
  /**
   * Whether to run the PII detector and surface `redactedInput`. When false,
   * `redactedInput` is never populated (raw input flows through unchanged).
   * @default true
   */
  redactPii?: boolean
  /**
   * Optional injected {@link SafetyMonitor}. Useful for tests or hosts that
   * want to share a single monitor with the event-bus-attached instance.
   * Defaults to a fresh monitor with built-in rules only.
   */
  safetyMonitor?: SafetyMonitor
}

export interface InputGuardResult {
  /** True if the input is allowed to proceed. When false, `reason` is set. */
  allowed: boolean
  /** Human-readable reason for rejection. Only set when `allowed === false`. */
  reason?: string
  /**
   * Sanitized input with PII placeholders substituted. Only set when
   * `redactPii` is enabled and at least one PII match was found.
   * Callers should replace `run.input` with this value before dispatch.
   */
  redactedInput?: unknown
  /** All safety violations observed during the scan (block + log tiers). */
  violations?: SafetyViolation[]
}

export interface InputGuard {
  /**
   * Scan an incoming run input. Returns a decision plus optional redacted
   * payload. This method never throws — any internal failure surfaces as
   * `{ allowed: true }` so misconfiguration never blocks the fleet.
   */
  scan(input: unknown): Promise<InputGuardResult>
}

/**
 * Serialize an arbitrary input to a scannable string. Strings pass through;
 * everything else is JSON-stringified. Falls back to `String(input)` if the
 * value is non-serializable (circular refs, BigInts, …).
 */
function stringifyInput(input: unknown): string {
  if (typeof input === 'string') return input
  if (input === undefined || input === null) return ''
  try {
    return JSON.stringify(input) ?? ''
  } catch {
    return String(input)
  }
}

/**
 * Walk a JSON-compatible value tree, replacing every string with the result
 * of `mapStr`. Non-string leaves are returned unchanged. Objects and arrays
 * are shallow-copied so the original input is never mutated.
 */
function mapStrings(value: unknown, mapStr: (s: string) => string): unknown {
  if (typeof value === 'string') return mapStr(value)
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, mapStr))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = mapStrings(v, mapStr)
    }
    return out
  }
  return value
}

/**
 * Create an {@link InputGuard} that combines length, injection, and PII
 * checks into a single `scan()` call suitable for the HTTP pre-dispatch
 * boundary.
 */
export function createInputGuard(config?: InputGuardConfig): InputGuard {
  const maxInputLength = config?.maxInputLength ?? DEFAULT_MAX_INPUT_LENGTH
  const redactPii = config?.redactPii ?? true
  // A dedicated monitor — not attached to any event bus so scans don't emit
  // events into the runtime. Hosts can inject a shared monitor via config.
  const monitor = config?.safetyMonitor ?? createSafetyMonitor()

  return {
    async scan(input: unknown): Promise<InputGuardResult> {
      const serialized = stringifyInput(input)

      // --- 1. Length guard (cheap, runs first) ---
      if (serialized.length > maxInputLength) {
        return {
          allowed: false,
          reason: `Input exceeds max length of ${maxInputLength} characters (got ${serialized.length})`,
        }
      }

      // --- 2. Injection / secret / escalation scan ---
      // Scan the serialized form so nested string fields are covered.
      let violations: SafetyViolation[] = []
      try {
        violations = monitor.scanContent(serialized, { source: 'input-guard' })
      } catch {
        // Scanner failure must not take down the pipeline — fall through.
        violations = []
      }

      const blocking = violations.find(
        (v) => v.action === 'block' || v.action === 'kill',
      )
      if (blocking) {
        return {
          allowed: false,
          reason: `${blocking.category}: ${blocking.message}`,
          violations,
        }
      }

      // --- 3. PII redaction (best-effort) ---
      let redactedInput: unknown
      if (redactPii) {
        let sawPII = false
        const redact = (s: string): string => {
          const result = detectPII(s)
          if (result.hasPII) {
            sawPII = true
            return result.redacted
          }
          return s
        }
        const redactedCandidate =
          typeof input === 'string'
            ? redact(input)
            : mapStrings(input, redact)
        if (sawPII) {
          redactedInput = redactedCandidate
        }
      }

      return {
        allowed: true,
        ...(redactedInput !== undefined ? { redactedInput } : {}),
        ...(violations.length > 0 ? { violations } : {}),
      }
    },
  }
}
