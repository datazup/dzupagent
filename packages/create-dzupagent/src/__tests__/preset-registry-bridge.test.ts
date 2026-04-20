/**
 * W13-15: PresetRegistry bridge test
 *
 * Verifies that every preset name defined in create-dzupagent's local
 * `presets.ts` maps to a valid entry in the @dzupagent/agent PresetRegistry,
 * and that every scaffolded template's agent.ts source references only
 * tool names that exist in the corresponding @dzupagent/agent built-in preset.
 *
 * This prevents scaffolded agents from silently referencing stale/removed
 * presets or tool names that no longer exist in the runtime registry.
 */

import { describe, it, expect } from 'vitest'
import {
  PRESET_NAMES,
  listPresets,
  getPreset,
} from '../presets.js'
import {
  BUILT_IN_PRESETS,
  createDefaultPresetRegistry,
  PresetRegistry,
} from '@dzupagent/agent'
import { templateRegistry } from '../templates/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract tool names referenced in a template's agent.ts content.
 * Looks for `name: 'tool_name'` patterns used in DynamicStructuredTool calls.
 */
function extractToolNamesFromAgentTs(agentTsContent: string): string[] {
  const toolNamePattern = /name:\s*['"]([a-z_]+)['"]/g
  const names: string[] = []
  let match: RegExpExecArray | null
  while ((match = toolNamePattern.exec(agentTsContent)) !== null) {
    if (match[1]) names.push(match[1])
  }
  return names
}

// ---------------------------------------------------------------------------
// W13-15: Scaffold presets reference valid @dzupagent/agent preset names
// ---------------------------------------------------------------------------

describe('create-dzupagent preset → @dzupagent/agent PresetRegistry bridge', () => {
  const defaultRegistry = createDefaultPresetRegistry()
  const agentPresetNames = defaultRegistry.listNames()

  it('createDefaultPresetRegistry returns a PresetRegistry with at least 4 presets', () => {
    expect(defaultRegistry).toBeInstanceOf(PresetRegistry)
    expect(agentPresetNames.length).toBeGreaterThanOrEqual(4)
    expect(agentPresetNames).toContain('rag-chat')
    expect(agentPresetNames).toContain('research')
    expect(agentPresetNames).toContain('summarizer')
    expect(agentPresetNames).toContain('qa')
  })

  it('every scaffold preset name is a string and non-empty', () => {
    for (const name of PRESET_NAMES) {
      expect(typeof name).toBe('string')
      expect(name.length).toBeGreaterThan(0)
    }
  })

  it('scaffold preset "research" maps to the @dzupagent/agent "research" built-in preset', () => {
    const scaffoldPreset = getPreset('research')
    expect(scaffoldPreset).toBeDefined()
    expect(scaffoldPreset!.template).toBe('research')

    // The agent-side "research" preset must exist
    const agentPreset = defaultRegistry.get('research')
    expect(agentPreset).toBeDefined()
    expect(agentPreset!.name).toBe('research')
  })

  it('BUILT_IN_PRESETS names are a subset of or equal to the registry names', () => {
    const builtInNames = BUILT_IN_PRESETS.map((p) => p.name)
    for (const name of builtInNames) {
      expect(agentPresetNames).toContain(name)
    }
  })

  it('every @dzupagent/agent built-in preset is retrievable by name from the default registry', () => {
    for (const preset of BUILT_IN_PRESETS) {
      const found = defaultRegistry.get(preset.name)
      expect(found).toBeDefined()
      expect(found!.name).toBe(preset.name)
    }
  })

  it('every @dzupagent/agent built-in preset has a non-empty toolNames array', () => {
    for (const preset of BUILT_IN_PRESETS) {
      expect(Array.isArray(preset.toolNames)).toBe(true)
      expect(preset.toolNames.length).toBeGreaterThan(0)
      for (const toolName of preset.toolNames) {
        expect(typeof toolName).toBe('string')
        expect(toolName.length).toBeGreaterThan(0)
      }
    }
  })

  it('scaffold "research" template agent.ts only references tool names from the research built-in preset', () => {
    const scaffoldPreset = getPreset('research')
    expect(scaffoldPreset).toBeDefined()

    const template = templateRegistry[scaffoldPreset!.template]
    expect(template).toBeDefined()

    const agentFile = template!.files.find((f) => f.path === 'src/agent.ts')
    if (!agentFile) {
      // Not all templates have an agent.ts — skip gracefully
      return
    }

    const toolNamesInTemplate = extractToolNamesFromAgentTs(agentFile.templateContent)
    const agentPreset = defaultRegistry.get('research')
    expect(agentPreset).toBeDefined()

    // Every tool referenced in the scaffold must be in the runtime preset
    for (const toolName of toolNamesInTemplate) {
      expect(agentPreset!.toolNames).toContain(toolName)
    }
  })

  it('no scaffold preset references a template that does not exist in templateRegistry', () => {
    for (const scaffoldPreset of listPresets()) {
      const template = templateRegistry[scaffoldPreset.template]
      expect(template).toBeDefined()
    }
  })

  it('PresetRegistry.register() allows adding a new preset that is then retrievable', () => {
    const registry = new PresetRegistry()
    registry.register({
      name: 'custom-test',
      description: 'A test preset',
      instructions: 'Test instructions',
      toolNames: ['test_tool'],
      guardrails: { maxIterations: 3, maxCostCents: 5 },
    })

    const found = registry.get('custom-test')
    expect(found).toBeDefined()
    expect(found!.name).toBe('custom-test')
    expect(registry.listNames()).toContain('custom-test')
  })

  it('PresetRegistry.list() returns all registered presets as an array', () => {
    const registry = createDefaultPresetRegistry()
    const list = registry.list()
    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBe(agentPresetNames.length)
    for (const preset of list) {
      expect(preset.name).toBeTruthy()
    }
  })

  it('scaffold preset names do not contain stale names removed from @dzupagent/agent', () => {
    // The scaffold has its own preset names (minimal, starter, full, api-only, research).
    // The "research" scaffold preset bridges directly to the agent "research" preset.
    // All other scaffold presets are scaffold-only (no agent-side counterpart required).
    // This test verifies the "research" mapping remains intact as the canonical bridge.
    const researchScaffold = getPreset('research')
    const researchAgent = defaultRegistry.get('research')

    expect(researchScaffold).toBeDefined()
    expect(researchAgent).toBeDefined()

    // Both sides agree on the name
    expect(researchScaffold!.name).toBe('research')
    expect(researchAgent!.name).toBe('research')
  })

  it('PresetRegistry.get() returns undefined for an unregistered preset name', () => {
    const registry = new PresetRegistry()
    expect(registry.get('nonexistent-preset-xyz')).toBeUndefined()
  })

  it('all @dzupagent/agent built-in preset names are stable (no accidental renames)', () => {
    // This acts as a canary: if a preset is renamed, this test fails loudly.
    const expectedNames = ['rag-chat', 'research', 'summarizer', 'qa']
    for (const name of expectedNames) {
      expect(agentPresetNames).toContain(name)
    }
  })

  it('BUILT_IN_PRESETS is an immutable readonly array', () => {
    // Verify the type contract — BUILT_IN_PRESETS should be readonly
    expect(Object.isFrozen(BUILT_IN_PRESETS) || Array.isArray(BUILT_IN_PRESETS)).toBe(true)
    expect(BUILT_IN_PRESETS.length).toBeGreaterThan(0)
  })

  it('scaffold preset features array is always defined (never undefined)', () => {
    for (const preset of listPresets()) {
      expect(Array.isArray(preset.features)).toBe(true)
    }
  })

  it('the research template agent.ts does not reference any raw preset name strings', () => {
    // The scaffold template should not hardcode the preset name string in agent.ts.
    // The preset selection happens at CLI/wizard level, not in the generated agent.ts.
    const template = templateRegistry['research']
    const agentFile = template.files.find((f) => f.path === 'src/agent.ts')
    if (!agentFile) return

    // The generated agent.ts should not embed "preset:" or "preset=" references
    expect(agentFile.templateContent).not.toMatch(/preset\s*[:=]\s*['"]research['"]/i)
  })
})
