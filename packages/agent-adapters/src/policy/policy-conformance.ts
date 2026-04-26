/**
 * PolicyConformanceChecker -- validates that a compiled policy is compatible
 * with the target provider's known capabilities.
 *
 * Catches mismatches early (before execution) so callers get actionable
 * violations rather than opaque runtime failures.
 *
 * @example
 * ```ts
 * const checker = new PolicyConformanceChecker()
 * const result = checker.check('openrouter', policy, compiled)
 * if (!result.conformant) {
 *   for (const v of result.violations) console.error(v.field, v.reason)
 * }
 * ```
 */

import type { AdapterProviderId } from '../types.js'
import type { AdapterPolicy, CompiledPolicyOverrides } from './policy-compiler.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Severity of a conformance violation. */
export type PolicyViolationSeverity = 'error' | 'warning'

/** A single conformance violation. */
export interface PolicyViolation {
  /** The policy field that is non-conformant (e.g. 'sandboxMode'). */
  field: string
  /** Human-readable explanation of the violation. */
  reason: string
  /** Whether this should block execution ('error') or just inform ('warning'). */
  severity: PolicyViolationSeverity
}

/** Result of a conformance check. */
export interface PolicyConformanceResult {
  /** True when there are zero error-severity violations. */
  conformant: boolean
  /** All detected violations (both error and warning). */
  violations: PolicyViolation[]
  /** Informational messages that are not violations. */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Provider capability map
// ---------------------------------------------------------------------------

interface ProviderCapabilities {
  supportsSandbox: boolean
  supportsNetworkToggle: boolean
  supportsApproval: boolean
  supportsToolAllowlist: boolean
  supportsToolBlocklist: boolean
  supportsBudget: boolean
  supportsMaxTurns: boolean
  supportsStructuredOutput: boolean
}

const PROVIDER_CAPABILITIES: Record<AdapterProviderId, ProviderCapabilities> = {
  claude: {
    supportsSandbox: true,
    supportsNetworkToggle: false,
    supportsApproval: true,
    supportsToolAllowlist: false,
    supportsToolBlocklist: false,
    supportsBudget: true,
    supportsMaxTurns: true,
    supportsStructuredOutput: false,
  },
  codex: {
    supportsSandbox: true,
    supportsNetworkToggle: true,
    supportsApproval: true,
    supportsToolAllowlist: false,
    supportsToolBlocklist: false,
    supportsBudget: false,
    supportsMaxTurns: true,
    supportsStructuredOutput: false,
  },
  gemini: {
    supportsSandbox: true,
    supportsNetworkToggle: false,
    supportsApproval: false,
    supportsToolAllowlist: false,
    supportsToolBlocklist: false,
    supportsBudget: false,
    supportsMaxTurns: true,
    supportsStructuredOutput: false,
  },
  'gemini-sdk': {
    supportsSandbox: false,
    supportsNetworkToggle: false,
    supportsApproval: false,
    supportsToolAllowlist: false,
    supportsToolBlocklist: false,
    supportsBudget: false,
    supportsMaxTurns: false,
    supportsStructuredOutput: false,
  },
  qwen: {
    supportsSandbox: true,
    supportsNetworkToggle: false,
    supportsApproval: false,
    supportsToolAllowlist: false,
    supportsToolBlocklist: false,
    supportsBudget: false,
    supportsMaxTurns: true,
    supportsStructuredOutput: false,
  },
  crush: {
    supportsSandbox: true,
    supportsNetworkToggle: false,
    supportsApproval: false,
    supportsToolAllowlist: false,
    supportsToolBlocklist: false,
    supportsBudget: false,
    supportsMaxTurns: true,
    supportsStructuredOutput: false,
  },
  goose: {
    supportsSandbox: true,
    supportsNetworkToggle: false,
    supportsApproval: false,
    supportsToolAllowlist: false,
    supportsToolBlocklist: false,
    supportsBudget: false,
    supportsMaxTurns: true,
    supportsStructuredOutput: false,
  },
  openrouter: {
    supportsSandbox: false,
    supportsNetworkToggle: false,
    supportsApproval: false,
    supportsToolAllowlist: false,
    supportsToolBlocklist: false,
    supportsBudget: false,
    supportsMaxTurns: true,
    supportsStructuredOutput: false,
  },
  openai: {
    supportsSandbox: false,
    supportsNetworkToggle: false,
    supportsApproval: false,
    supportsToolAllowlist: false,
    supportsToolBlocklist: false,
    supportsBudget: false,
    supportsMaxTurns: true,
    supportsStructuredOutput: false,
  },
}

// ---------------------------------------------------------------------------
// PolicyConformanceChecker
// ---------------------------------------------------------------------------

/**
 * Validates that an {@link AdapterPolicy} and its compiled overrides
 * are compatible with the target provider's known capabilities.
 */
export class PolicyConformanceChecker {
  /**
   * Check conformance of a policy against a provider.
   *
   * @param provider - Target provider ID
   * @param policy   - The original policy declaration
   * @param _compiled - The compiled overrides (reserved for future field-level checks)
   * @returns Conformance result with violations and warnings
   */
  check(
    provider: AdapterProviderId,
    policy: AdapterPolicy,
    _compiled: CompiledPolicyOverrides,
  ): PolicyConformanceResult {
    const caps = PROVIDER_CAPABILITIES[provider]
    const violations: PolicyViolation[] = []
    const warnings: string[] = []

    // --- sandboxMode ---
    if (policy.sandboxMode !== undefined && !caps.supportsSandbox) {
      violations.push({
        field: 'sandboxMode',
        reason: `Provider '${provider}' does not support sandbox mode. Requested '${policy.sandboxMode}' will be ignored.`,
        severity: 'error',
      })
    }

    // --- networkAccess ---
    if (policy.networkAccess !== undefined && !caps.supportsNetworkToggle) {
      if (policy.networkAccess === false) {
        violations.push({
          field: 'networkAccess',
          reason: `Provider '${provider}' does not support disabling network access. The agent may still make network requests.`,
          severity: 'warning',
        })
      } else {
        warnings.push(
          `Provider '${provider}' does not have a network toggle; network access is always enabled.`,
        )
      }
    }

    // --- approvalRequired ---
    if (policy.approvalRequired && !caps.supportsApproval) {
      violations.push({
        field: 'approvalRequired',
        reason: `Provider '${provider}' does not support native approval gates. Use the OrchestratorFacade approval gate instead.`,
        severity: 'warning',
      })
    }

    // --- allowedTools ---
    if (policy.allowedTools && policy.allowedTools.length > 0 && !caps.supportsToolAllowlist) {
      violations.push({
        field: 'allowedTools',
        reason: `Provider '${provider}' does not support tool allowlists. The allowedTools policy cannot be enforced at the provider level.`,
        severity: 'warning',
      })
    }

    // --- blockedTools ---
    if (policy.blockedTools && policy.blockedTools.length > 0 && !caps.supportsToolBlocklist) {
      // Blocked tools can still be enforced through guardrails, so this is a warning
      violations.push({
        field: 'blockedTools',
        reason: `Provider '${provider}' does not support native tool blocklists. Enforcement will rely on guardrail middleware.`,
        severity: 'warning',
      })
    }

    // --- maxBudgetUsd ---
    if (policy.maxBudgetUsd !== undefined && !caps.supportsBudget) {
      violations.push({
        field: 'maxBudgetUsd',
        reason: `Provider '${provider}' does not support native budget limits. Enforcement will rely on cost-tracking middleware.`,
        severity: 'warning',
      })
    }

    // --- maxTurns ---
    if (policy.maxTurns !== undefined && !caps.supportsMaxTurns) {
      violations.push({
        field: 'maxTurns',
        reason: `Provider '${provider}' does not support turn limits. The maxTurns policy cannot be enforced at the provider level.`,
        severity: 'error',
      })
    }

    // --- Cross-field: conflicting allowedTools + blockedTools ---
    if (
      policy.allowedTools &&
      policy.allowedTools.length > 0 &&
      policy.blockedTools &&
      policy.blockedTools.length > 0
    ) {
      const overlap = policy.allowedTools.filter((t) => policy.blockedTools!.includes(t))
      if (overlap.length > 0) {
        violations.push({
          field: 'allowedTools+blockedTools',
          reason: `Tools [${overlap.join(', ')}] appear in both allowedTools and blockedTools.`,
          severity: 'error',
        })
      }
    }

    const conformant = violations.every((v) => v.severity !== 'error')

    return { conformant, violations, warnings }
  }
}
