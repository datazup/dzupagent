/**
 * PolicyEnforcementPipeline — extracted from OrchestratorFacade.
 *
 * Responsibilities:
 *  - Compile per-provider policies with conformance checking
 *  - Apply policy overrides to AgentInput / adapter configuration
 *
 * The pipeline is stateless across calls; instances hold their dependencies
 * (registry + conformance checker) and reuse them across runs.
 */

import { ForgeError } from '@dzupagent/core/events'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import {
  compilePolicyForProvider,
  type AdapterPolicy,
  type CompiledGuardrailHints,
  type CompiledPolicyOverrides,
} from '../policy/policy-compiler.js'
import { PolicyConformanceChecker } from '../policy/policy-conformance.js'
import type { AdapterProviderId, AgentInput } from '../types.js'

export type PolicyConformanceMode = 'strict' | 'warn-only'
export const POLICY_GUARDRAILS_OPTION_KEY = '__policyGuardrails'
export const POLICY_ACTIVE_OPTION_KEY = '__activePolicy'
export const POLICY_CONFORMANCE_MODE_OPTION_KEY = '__policyConformanceMode'

export class PolicyEnforcementPipeline {
  private readonly _conformanceChecker: PolicyConformanceChecker
  private readonly _conformanceMode: PolicyConformanceMode

  constructor(
    private readonly _registry: ProviderAdapterRegistry,
    conformanceChecker?: PolicyConformanceChecker,
    conformanceMode: PolicyConformanceMode = 'strict',
  ) {
    this._conformanceChecker = conformanceChecker ?? new PolicyConformanceChecker()
    this._conformanceMode = conformanceMode
  }

  /**
   * Compile policy for a provider and run conformance check.
   * Throws on error-severity violations.
   */
  compileWithConformance(
    provider: AdapterProviderId,
    policy: AdapterPolicy,
  ): CompiledPolicyOverrides {
    const compiled = compilePolicyForProvider(provider, policy)
    const result = this._conformanceChecker.check(provider, policy, compiled)

    const blockingViolations = this._conformanceMode === 'strict'
      ? result.violations
      : result.violations.filter((v) => v.severity === 'error')

    if (blockingViolations.length > 0) {
      const details = blockingViolations
        .map((v) => `  - ${v.field}: ${v.reason}`)
        .join('\n')
      throw new ForgeError({
        code: 'ADAPTER_EXECUTION_FAILED',
        message: `Policy conformance check failed for provider '${provider}':\n${details}`,
        recoverable: false,
        context: {
          source: 'PolicyEnforcementPipeline.compileWithConformance',
          providerId: provider,
          violationCount: blockingViolations.length,
          conformanceMode: this._conformanceMode,
        },
      })
    }

    return compiled
  }

  /**
   * Attach per-run policy context to AgentInput.
   *
   * Router-level attempt projection is canonical; this prepare-stage step
   * only stores typed policy metadata and guardrail hints for downstream
   * projection/wrapping. Legacy option keys are mirrored temporarily for
   * backward compatibility.
   */
  applyPolicyOverrides(
    input: AgentInput,
    preferredProvider: AdapterProviderId | undefined,
    activePolicy: AdapterPolicy | undefined,
  ): void {
    if (!activePolicy) return
    if (preferredProvider && !this._registry.get(preferredProvider)) {
      throw new ForgeError({
        code: 'ADAPTER_EXECUTION_FAILED',
        message: `Cannot apply policy: provider '${preferredProvider}' is not registered`,
        recoverable: false,
        context: {
          source: 'PolicyEnforcementPipeline.applyPolicyOverrides',
          providerId: preferredProvider,
        },
      })
    }

    const guardrails = extractGuardrailHints(activePolicy)

    input.policyContext = {
      ...(input.policyContext ?? {}),
      activePolicy: { ...activePolicy },
      conformanceMode: this._conformanceMode,
      ...(hasGuardrailHints(guardrails) ? { projectedGuardrails: { ...guardrails } } : {}),
    }

    // Compatibility transport for external callers still wiring option keys.
    input.options = {
      ...(input.options ?? {}),
      [POLICY_ACTIVE_OPTION_KEY]: { ...activePolicy },
      [POLICY_CONFORMANCE_MODE_OPTION_KEY]: this._conformanceMode,
    }
    if (hasGuardrailHints(guardrails)) {
      input.options = {
        ...input.options,
        [POLICY_GUARDRAILS_OPTION_KEY]: { ...guardrails },
      }
    }
    if (guardrails.maxIterations !== undefined && input.maxTurns === undefined) {
      input.maxTurns = guardrails.maxIterations
    }
  }
}

function hasGuardrailHints(hints: CompiledGuardrailHints): boolean {
  return (
    hints.maxIterations !== undefined ||
    hints.maxCostCents !== undefined ||
    (hints.blockedTools !== undefined && hints.blockedTools.length > 0)
  )
}

function extractGuardrailHints(policy: AdapterPolicy): CompiledGuardrailHints {
  return {
    ...(policy.maxTurns !== undefined ? { maxIterations: policy.maxTurns } : {}),
    ...(policy.maxBudgetUsd !== undefined ? { maxCostCents: Math.round(policy.maxBudgetUsd * 100) } : {}),
    ...(policy.blockedTools && policy.blockedTools.length > 0 ? { blockedTools: [...policy.blockedTools] } : {}),
  }
}
