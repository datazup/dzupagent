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
  type CompiledPolicyOverrides,
} from '../policy/policy-compiler.js'
import { PolicyConformanceChecker } from '../policy/policy-conformance.js'
import type { AdapterProviderId, AgentInput } from '../types.js'

export class PolicyEnforcementPipeline {
  private readonly _conformanceChecker: PolicyConformanceChecker

  constructor(
    private readonly _registry: ProviderAdapterRegistry,
    conformanceChecker?: PolicyConformanceChecker,
  ) {
    this._conformanceChecker = conformanceChecker ?? new PolicyConformanceChecker()
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

    if (!result.conformant) {
      const errorViolations = result.violations.filter((v) => v.severity === 'error')
      const details = errorViolations
        .map((v) => `  - ${v.field}: ${v.reason}`)
        .join('\n')
      throw new ForgeError({
        code: 'ADAPTER_EXECUTION_FAILED',
        message: `Policy conformance check failed for provider '${provider}':\n${details}`,
        recoverable: false,
        context: {
          source: 'PolicyEnforcementPipeline.compileWithConformance',
          providerId: provider,
          violationCount: errorViolations.length,
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

    const targetProvider = preferredProvider ?? this._registry.listAdapters()[0]
    if (!targetProvider) return

    const compiled = this.compileWithConformance(targetProvider, activePolicy)
    const adapter = this._registry.get(targetProvider)
    if (adapter) {
      adapter.configure(compiled.config)
    }
    if (Object.keys(compiled.inputOptions).length > 0) {
      input.options = { ...input.options, ...compiled.inputOptions }
    }
    if (compiled.guardrails.maxIterations !== undefined && input.maxTurns === undefined) {
      input.maxTurns = compiled.guardrails.maxIterations
    }
  }
}
