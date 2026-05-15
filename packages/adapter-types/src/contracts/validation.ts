/**
 * Pre-flight validation contract for adapter execution.
 *
 * A validator runs before an adapter starts a tool loop and gates execution
 * on a {@link ValidationResult}. Failures stop execution before any
 * write-tier action is taken; warnings are surfaced but execution proceeds.
 *
 * Implementations SHOULD be cheap (sub-50ms) — the validator runs on every
 * `execute()` call. Heavy or async checks belong in a guardrail, not a
 * pre-flight validator.
 */

import type { AgentInput } from './execution.js'
import type { AdapterProviderId } from './provider.js'

export type ValidationSeverity = 'error' | 'warning' | 'info'

export interface ValidationIssue {
  /** Stable identifier for this issue class (e.g. `budget.exhausted`, `tool.unavailable`). */
  code: string
  severity: ValidationSeverity
  message: string
  /** Optional structured detail attached to the issue (provider-specific). */
  detail?: Record<string, unknown>
}

export interface ValidationResult {
  /** True when no `error`-severity issues were raised. */
  ok: boolean
  issues: ValidationIssue[]
}

/**
 * Context passed to a validator. The provider runs validation before any
 * execution side effect, so the context only contains pre-execution state.
 */
export interface ValidationContext {
  providerId: AdapterProviderId
  /** Tenant scope for tenant-scoped guardrails (budget caps, RBAC). */
  tenantId?: string | undefined
  /** Skill IDs the caller intends to invoke; empty when no skills are bound. */
  skillIds?: string[] | undefined
  /** Tool names the caller has declared as required for this run. */
  requiredTools?: string[] | undefined
  /**
   * Free-form metadata for app-specific validators. The framework never reads
   * these fields; they exist so app-side validators can attach context
   * (room IDs, run IDs, role contracts) without widening the framework type.
   */
  metadata?: Record<string, unknown> | undefined
}

/**
 * Pre-flight validation contract. An adapter executes the validator before
 * starting its tool loop and aborts if the result is `ok: false`.
 *
 * Multiple validators can be composed via {@link composeValidators}.
 */
export interface ValidationContract {
  readonly name: string
  validate(input: AgentInput, context: ValidationContext): Promise<ValidationResult> | ValidationResult
}

/**
 * Compose multiple validators into a single one. All validators run; issues
 * are merged. The composed result is `ok` only when every contributing
 * validator returned `ok`.
 */
export function composeValidators(
  name: string,
  ...validators: ValidationContract[]
): ValidationContract {
  return {
    name,
    async validate(input, context) {
      const issues: ValidationIssue[] = []
      let ok = true
      for (const validator of validators) {
        const result = await validator.validate(input, context)
        if (!result.ok) ok = false
        if (result.issues.length > 0) issues.push(...result.issues)
      }
      return { ok, issues }
    },
  }
}

/** Convenience constructor for a passing result. */
export function passingResult(...issues: ValidationIssue[]): ValidationResult {
  return { ok: true, issues }
}

/** Convenience constructor for a failing result. Always includes at least one error. */
export function failingResult(error: ValidationIssue, ...rest: ValidationIssue[]): ValidationResult {
  return { ok: false, issues: [{ ...error, severity: 'error' }, ...rest] }
}
