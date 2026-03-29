import type { AgentPreset, PresetRuntimeDeps } from './types.js'

/**
 * Create a DzipAgent configuration object from a preset and runtime dependencies.
 * Returns a config object compatible with DzipAgent constructor.
 */
export function buildConfigFromPreset(
  preset: AgentPreset,
  deps: PresetRuntimeDeps,
): Record<string, unknown> {
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

/** Global preset registry with built-in presets */
export function createDefaultPresetRegistry(): PresetRegistry {
  const registry = new PresetRegistry()
  return registry
}
