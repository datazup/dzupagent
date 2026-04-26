/**
 * Skill capability matrix builder.
 *
 * Evaluates an AdapterSkillBundle against all registered providers
 * and produces a per-provider capability status matrix showing which
 * features are active, degraded, dropped, or unsupported.
 */

import type {
  AdapterProviderId,
  CapabilityStatus,
  ProviderCapabilityRow,
  SkillCapabilityMatrix,
} from '@dzupagent/adapter-types'
import type { AdapterSkillBundle } from './adapter-skill-types.js'
import { AdapterSkillRegistry, createDefaultSkillRegistry } from './adapter-skill-registry.js'

export type { CapabilityStatus, ProviderCapabilityRow, SkillCapabilityMatrix }

/**
 * Provider capability rules.
 *
 * - `claude`: full support (including budgetLimit)
 * - `codex`: everything except budgetLimit
 * - `gemini-sdk`: has tool call support (supportsToolCalls: true), so treat
 *    toolBindings as active, but approvalMode/networkPolicy/budgetLimit dropped
 * - CLI providers (gemini, qwen, crush, goose, openrouter): systemPrompt only;
 *    all other capabilities dropped
 *
 * Note: gemini and goose CLI compilers report toolBindings as a supported
 * feature, but for the capability matrix we follow the design doc rules
 * that classify all CLI providers as having toolBindings "dropped".
 */
const PROVIDER_CAPABILITIES: Record<
  AdapterProviderId,
  {
    toolBindings: CapabilityStatus
    approvalMode: CapabilityStatus
    networkPolicy: CapabilityStatus
    budgetLimit: CapabilityStatus
  }
> = {
  claude: { toolBindings: 'active', approvalMode: 'active', networkPolicy: 'active', budgetLimit: 'active' },
  codex: { toolBindings: 'active', approvalMode: 'active', networkPolicy: 'active', budgetLimit: 'dropped' },
  'gemini-sdk': { toolBindings: 'active', approvalMode: 'dropped', networkPolicy: 'dropped', budgetLimit: 'dropped' },
  gemini: { toolBindings: 'dropped', approvalMode: 'dropped', networkPolicy: 'dropped', budgetLimit: 'dropped' },
  qwen: { toolBindings: 'dropped', approvalMode: 'dropped', networkPolicy: 'dropped', budgetLimit: 'dropped' },
  crush: { toolBindings: 'dropped', approvalMode: 'dropped', networkPolicy: 'dropped', budgetLimit: 'dropped' },
  goose: { toolBindings: 'dropped', approvalMode: 'dropped', networkPolicy: 'dropped', budgetLimit: 'dropped' },
  openrouter: { toolBindings: 'dropped', approvalMode: 'dropped', networkPolicy: 'dropped', budgetLimit: 'dropped' },
  openai: { toolBindings: 'dropped', approvalMode: 'dropped', networkPolicy: 'dropped', budgetLimit: 'dropped' },
}

type CapabilityKey = 'toolBindings' | 'approvalMode' | 'networkPolicy' | 'budgetLimit'

/**
 * Determine whether the bundle actually uses a given capability,
 * so we can distinguish 'dropped' (bundle uses it but provider ignores it)
 * from 'unsupported' (provider can never support it, regardless of bundle).
 *
 * For the current design, we always report the provider's static status
 * from the capability map. The 'unsupported' status is reserved for future
 * use when dynamic capability detection is added.
 */
function deriveCapabilityStatus(
  providerStatus: CapabilityStatus,
): CapabilityStatus {
  return providerStatus
}

export class SkillCapabilityMatrixBuilder {
  private readonly registry: AdapterSkillRegistry

  /**
   * Construct the builder with an explicit registry, or pass nothing to
   * auto-populate a default registry that contains every built-in skill
   * compiler (useful for CLI tools & ad-hoc capability inspection).
   */
  constructor(registry?: AdapterSkillRegistry) {
    this.registry = registry ?? createDefaultSkillRegistry()
  }

  /**
   * Build a capability matrix for a single bundle across all
   * providers registered in the registry.
   */
  buildForSkill(bundle: AdapterSkillBundle): SkillCapabilityMatrix {
    const providers: Partial<Record<AdapterProviderId, ProviderCapabilityRow>> = {}

    for (const providerId of this.registry.listProviders()) {
      const caps = PROVIDER_CAPABILITIES[providerId]
      if (!caps) continue

      // Compile and validate to collect warnings
      const compiled = this.registry.compile(bundle, providerId)
      const compiler = this.registry.getCompiler(providerId)
      const warnings: string[] = []

      if (compiler) {
        const validationResult = compiler.validate(compiled)
        if (validationResult.errors) {
          warnings.push(...validationResult.errors)
        }
      }

      // Add warnings for dropped capabilities that the bundle actually requests
      const capKeys: CapabilityKey[] = ['toolBindings', 'approvalMode', 'networkPolicy', 'budgetLimit']
      for (const key of capKeys) {
        if (caps[key] === 'dropped' && this.bundleUsesCapability(bundle, key)) {
          const existing = warnings.find((w) => w.includes(key))
          if (!existing) {
            warnings.push(`Provider '${providerId}' does not support ${key} — capability dropped`)
          }
        }
      }

      providers[providerId] = {
        systemPrompt: 'active',
        toolBindings: deriveCapabilityStatus(caps.toolBindings),
        approvalMode: deriveCapabilityStatus(caps.approvalMode),
        networkPolicy: deriveCapabilityStatus(caps.networkPolicy),
        budgetLimit: deriveCapabilityStatus(caps.budgetLimit),
        warnings,
      }
    }

    return {
      skillId: bundle.bundleId,
      skillName: bundle.skillSetId,
      providers,
    }
  }

  /**
   * Build capability matrices for multiple bundles.
   */
  buildForAll(bundles: AdapterSkillBundle[]): SkillCapabilityMatrix[] {
    return bundles.map((b) => this.buildForSkill(b))
  }

  private bundleUsesCapability(bundle: AdapterSkillBundle, key: CapabilityKey): boolean {
    switch (key) {
      case 'toolBindings':
        return bundle.toolBindings.length > 0
      case 'approvalMode':
        return bundle.constraints.approvalMode !== undefined
      case 'networkPolicy':
        return bundle.constraints.networkPolicy !== undefined
      case 'budgetLimit':
        return bundle.constraints.maxBudgetUsd !== undefined
      default:
        return false
    }
  }
}
