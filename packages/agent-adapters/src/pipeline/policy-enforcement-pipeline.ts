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
   * Apply policy overrides to an AgentInput and the target adapter.
   *
   * No-op when no policy is supplied or no adapters are registered.
   */
  applyPolicyOverrides(
    input: AgentInput,
    preferredProvider: AdapterProviderId | undefined,
    activePolicy: AdapterPolicy | undefined,
  ): void {
    if (!activePolicy) return

    if (!preferredProvider) {
      throw new ForgeError({
        code: 'ADAPTER_EXECUTION_FAILED',
        message:
          'Per-run policy requires an explicit provider. ' +
          'Set preferredProvider/provider so policy is compiled for the routed provider.',
        recoverable: false,
        context: {
          source: 'PolicyEnforcementPipeline.applyPolicyOverrides',
          providerSelection: 'auto',
        },
      })
    }

    const targetProvider = preferredProvider
    if (!targetProvider) return

    if (!this._registry.get(targetProvider)) {
      throw new ForgeError({
        code: 'ADAPTER_EXECUTION_FAILED',
        message: `Cannot apply policy: provider '${targetProvider}' is not registered`,
        recoverable: false,
        context: {
          source: 'PolicyEnforcementPipeline.applyPolicyOverrides',
          providerId: targetProvider,
        },
      })
    }

    const compiled = this.compileWithConformance(targetProvider, activePolicy)
    // Execution-scoped policy application: avoid mutating shared adapter instances.
    if (Object.keys(compiled.config).length > 0) {
      input.options = { ...input.options, ...compiled.config }
    }
    if (Object.keys(compiled.inputOptions).length > 0) {
      input.options = { ...input.options, ...compiled.inputOptions }
    }
    if (hasGuardrailHints(compiled.guardrails)) {
      input.options = {
        ...input.options,
        [POLICY_GUARDRAILS_OPTION_KEY]: { ...compiled.guardrails },
      }
    }
    if (compiled.guardrails.maxIterations !== undefined && input.maxTurns === undefined) {
      input.maxTurns = compiled.guardrails.maxIterations
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
