import type { AgentPreset, PresetRuntimeDeps } from './types.js'
import { BUILT_IN_PRESETS } from './built-in.js'

/**
 * Typed return value from `buildConfigFromPreset`.
 *
 * Covers all fields the factory populates --- callers can cast or narrow
 * further before passing to `new DzupAgent(...)`.
 */
export interface PresetConfig {
  id: string
  name: string
  instructions: string
  model: unknown
  tools: unknown[] | undefined
  memory: unknown | undefined
  memoryProfile: 'minimal' | 'balanced' | 'memory-heavy' | undefined
  eventBus: unknown | undefined
  guardrails: {
    maxIterations: number
    maxTokens: number | undefined
    maxCostCents: number | undefined
  }
  /** Self-learning config derived from preset.selfCorrection */
  selfLearning: { enabled: boolean; maxIterations: number | undefined } | undefined
  /** Hint for downstream model selection */
  defaultModelTier: string | undefined
}

/**
 * Create a DzupAgent configuration object from a preset and runtime dependencies.
 * Returns a config object compatible with DzupAgent constructor.
 */
export function buildConfigFromPreset(
  preset: AgentPreset,
  deps: PresetRuntimeDeps,
): PresetConfig {
  const instructions = deps.overrides?.instructions ?? preset.instructions
  const guardrails = { ...preset.guardrails, ...deps.overrides?.guardrails }
  const memoryProfile = deps.overrides?.memoryProfile ?? preset.memoryProfile

  // Filter tools by preset.toolNames if tools provided
  let tools = deps.tools
  if (tools && preset.toolNames.length > 0) {
    tools = tools.filter((t: unknown) => {
      const tool = t as { name?: string }
      return tool.name ? preset.toolNames.includes(tool.name) : true
    })
  }

  // Map selfCorrection → selfLearning (overrides take precedence)
  let selfLearning: PresetConfig['selfLearning']
  if (deps.overrides?.selfLearning) {
    selfLearning = {
      enabled: deps.overrides.selfLearning.enabled ?? false,
      maxIterations: deps.overrides.selfLearning.maxIterations,
    }
  } else if (preset.selfCorrection?.enabled) {
    selfLearning = {
      enabled: true,
      maxIterations: preset.selfCorrection.maxReflectionIterations,
    }
  }

  return {
    id: `preset-${preset.name}-${Date.now()}`,
    name: preset.name,
    instructions,
    model: deps.model,
    tools,
    memory: deps.memory,
    memoryProfile,
    eventBus: deps.eventBus,
    guardrails: {
      maxIterations: guardrails.maxIterations,
      maxTokens: guardrails.maxTokens,
      maxCostCents: guardrails.maxCostCents,
    },
    selfLearning,
    defaultModelTier: preset.defaultModelTier,
  }
}

/** Registry of available presets */
export class PresetRegistry {
  private presets = new Map<string, AgentPreset>()

  register(preset: AgentPreset): void {
    this.presets.set(preset.name, preset)
  }

  get(name: string): AgentPreset | undefined {
    return this.presets.get(name)
  }

  list(): AgentPreset[] {
    return Array.from(this.presets.values())
  }

  listNames(): string[] {
    return Array.from(this.presets.keys())
  }
}

/** Global preset registry with built-in presets auto-registered */
export function createDefaultPresetRegistry(): PresetRegistry {
  const registry = new PresetRegistry()
  for (const preset of BUILT_IN_PRESETS) {
    registry.register(preset)
  }
  return registry
}
