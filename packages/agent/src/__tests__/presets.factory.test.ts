import { describe, it, expect, vi } from 'vitest'
import {
  buildConfigFromPreset,
  PresetRegistry,
  createDefaultPresetRegistry,
  type PresetConfig,
} from '../presets/factory.js'
import type { AgentPreset, PresetRuntimeDeps } from '../presets/types.js'
import {
  RAGChatPreset,
  ResearchPreset,
  SummarizerPreset,
  QAPreset,
} from '../presets/built-in.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePreset(overrides: Partial<AgentPreset> = {}): AgentPreset {
  return {
    name: 'test-preset',
    description: 'A test preset',
    instructions: 'default instructions',
    toolNames: ['tool_a', 'tool_b'],
    guardrails: { maxIterations: 10, maxCostCents: 50, maxTokens: 5000 },
    ...overrides,
  }
}

function makeDeps(overrides: Partial<PresetRuntimeDeps> = {}): PresetRuntimeDeps {
  return {
    model: { id: 'mock-model' },
    ...overrides,
  }
}

function makeTool(name: string) {
  return { name }
}

// ---------------------------------------------------------------------------
// buildConfigFromPreset — basic field mapping
// ---------------------------------------------------------------------------

describe('buildConfigFromPreset', () => {
  it('returns a PresetConfig with correct id format', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    const cfg = buildConfigFromPreset(makePreset(), makeDeps())

    expect(cfg.id).toBe(`preset-test-preset-${now}`)
    vi.restoreAllMocks()
  })

  it('maps preset name to config.name', () => {
    const cfg = buildConfigFromPreset(makePreset({ name: 'my-agent' }), makeDeps())
    expect(cfg.name).toBe('my-agent')
  })

  it('passes through model from deps', () => {
    const model = { id: 'gpt-4o' }
    const cfg = buildConfigFromPreset(makePreset(), makeDeps({ model }))
    expect(cfg.model).toBe(model)
  })

  it('passes through memory from deps', () => {
    const memory = { type: 'redis' }
    const cfg = buildConfigFromPreset(makePreset(), makeDeps({ memory }))
    expect(cfg.memory).toBe(memory)
  })

  it('passes through eventBus from deps', () => {
    const eventBus = { emit: vi.fn() }
    const cfg = buildConfigFromPreset(makePreset(), makeDeps({ eventBus }))
    expect(cfg.eventBus).toBe(eventBus)
  })

  // ---------------------------------------------------------------------------
  // Instructions override precedence
  // ---------------------------------------------------------------------------

  describe('instructions override precedence', () => {
    it('uses preset instructions when no override', () => {
      const cfg = buildConfigFromPreset(
        makePreset({ instructions: 'preset instructions' }),
        makeDeps(),
      )
      expect(cfg.instructions).toBe('preset instructions')
    })

    it('override instructions take precedence over preset', () => {
      const cfg = buildConfigFromPreset(
        makePreset({ instructions: 'preset instructions' }),
        makeDeps({ overrides: { instructions: 'custom instructions' } }),
      )
      expect(cfg.instructions).toBe('custom instructions')
    })

    it('override with empty string still takes precedence', () => {
      const cfg = buildConfigFromPreset(
        makePreset({ instructions: 'preset instructions' }),
        makeDeps({ overrides: { instructions: '' } }),
      )
      // Empty string is falsy but ?? only checks null/undefined
      expect(cfg.instructions).toBe('')
    })
  })

  // ---------------------------------------------------------------------------
  // Guardrail merging
  // ---------------------------------------------------------------------------

  describe('guardrail merging', () => {
    it('uses preset guardrails when no override', () => {
      const cfg = buildConfigFromPreset(
        makePreset({ guardrails: { maxIterations: 7, maxCostCents: 30 } }),
        makeDeps(),
      )
      expect(cfg.guardrails.maxIterations).toBe(7)
      expect(cfg.guardrails.maxCostCents).toBe(30)
    })

    it('override guardrails merge with preset (override wins)', () => {
      const cfg = buildConfigFromPreset(
        makePreset({ guardrails: { maxIterations: 10, maxCostCents: 50, maxTokens: 5000 } }),
        makeDeps({ overrides: { guardrails: { maxIterations: 3 } } }),
      )
      expect(cfg.guardrails.maxIterations).toBe(3)
      expect(cfg.guardrails.maxCostCents).toBe(50) // preserved from preset
      expect(cfg.guardrails.maxTokens).toBe(5000) // preserved from preset
    })

    it('override can set cost/token limits not in preset', () => {
      const cfg = buildConfigFromPreset(
        makePreset({ guardrails: { maxIterations: 5 } }),
        makeDeps({ overrides: { guardrails: { maxCostCents: 99, maxTokens: 10000 } } }),
      )
      expect(cfg.guardrails.maxIterations).toBe(5)
      expect(cfg.guardrails.maxCostCents).toBe(99)
      expect(cfg.guardrails.maxTokens).toBe(10000)
    })

    it('guardrails are always present even if minimal', () => {
      const cfg = buildConfigFromPreset(
        makePreset({ guardrails: { maxIterations: 1 } }),
        makeDeps(),
      )
      expect(cfg.guardrails).toBeDefined()
      expect(cfg.guardrails.maxIterations).toBe(1)
      expect(cfg.guardrails.maxCostCents).toBeUndefined()
      expect(cfg.guardrails.maxTokens).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // memoryProfile passthrough
  // ---------------------------------------------------------------------------

  describe('memoryProfile', () => {
    it('uses preset memoryProfile when no override', () => {
      const cfg = buildConfigFromPreset(
        makePreset({ memoryProfile: 'memory-heavy' }),
        makeDeps(),
      )
      expect(cfg.memoryProfile).toBe('memory-heavy')
    })

    it('override memoryProfile takes precedence', () => {
      const cfg = buildConfigFromPreset(
        makePreset({ memoryProfile: 'minimal' }),
        makeDeps({ overrides: { memoryProfile: 'balanced' } }),
      )
      expect(cfg.memoryProfile).toBe('balanced')
    })

    it('memoryProfile is undefined when not set anywhere', () => {
      const cfg = buildConfigFromPreset(
        makePreset({ memoryProfile: undefined }),
        makeDeps(),
      )
      expect(cfg.memoryProfile).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Tool filtering
  // ---------------------------------------------------------------------------

  describe('tool filtering', () => {
    it('filters tools to only those named in preset.toolNames', () => {
      const tools = [makeTool('tool_a'), makeTool('tool_b'), makeTool('tool_c')]
      const cfg = buildConfigFromPreset(
        makePreset({ toolNames: ['tool_a', 'tool_b'] }),
        makeDeps({ tools }),
      )
      expect(cfg.tools).toHaveLength(2)
      expect(cfg.tools!.map((t) => (t as { name: string }).name)).toEqual(['tool_a', 'tool_b'])
    })

    it('keeps tools without a name property (nameless tools pass through)', () => {
      const tools = [makeTool('tool_a'), { execute: vi.fn() }, makeTool('blocked')]
      const cfg = buildConfigFromPreset(
        makePreset({ toolNames: ['tool_a'] }),
        makeDeps({ tools }),
      )
      // tool_a + nameless tool (blocked is excluded)
      expect(cfg.tools).toHaveLength(2)
    })

    it('blocks all named tools not in allowlist', () => {
      const tools = [makeTool('x'), makeTool('y')]
      const cfg = buildConfigFromPreset(
        makePreset({ toolNames: ['z'] }),
        makeDeps({ tools }),
      )
      expect(cfg.tools).toHaveLength(0)
    })

    it('does not filter when toolNames is empty', () => {
      const tools = [makeTool('a'), makeTool('b')]
      const cfg = buildConfigFromPreset(
        makePreset({ toolNames: [] }),
        makeDeps({ tools }),
      )
      expect(cfg.tools).toHaveLength(2)
    })

    it('returns undefined tools when deps.tools is undefined', () => {
      const cfg = buildConfigFromPreset(makePreset(), makeDeps({ tools: undefined }))
      expect(cfg.tools).toBeUndefined()
    })

    it('returns empty array when all tools are filtered out', () => {
      const cfg = buildConfigFromPreset(
        makePreset({ toolNames: ['nonexistent'] }),
        makeDeps({ tools: [makeTool('other')] }),
      )
      expect(cfg.tools).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // selfCorrection -> selfLearning wiring (NEW)
  // ---------------------------------------------------------------------------

  describe('selfCorrection → selfLearning mapping', () => {
    it('maps selfCorrection.enabled to selfLearning when enabled', () => {
      const cfg = buildConfigFromPreset(
        makePreset({
          selfCorrection: { enabled: true, maxReflectionIterations: 5 },
        }),
        makeDeps(),
      )
      expect(cfg.selfLearning).toBeDefined()
      expect(cfg.selfLearning!.enabled).toBe(true)
      expect(cfg.selfLearning!.maxIterations).toBe(5)
    })

    it('does not set selfLearning when selfCorrection is not enabled', () => {
      const cfg = buildConfigFromPreset(
        makePreset({
          selfCorrection: { enabled: false },
        }),
        makeDeps(),
      )
      expect(cfg.selfLearning).toBeUndefined()
    })

    it('does not set selfLearning when selfCorrection is absent', () => {
      const cfg = buildConfigFromPreset(makePreset(), makeDeps())
      expect(cfg.selfLearning).toBeUndefined()
    })

    it('selfLearning.maxIterations is undefined when maxReflectionIterations not set', () => {
      const cfg = buildConfigFromPreset(
        makePreset({ selfCorrection: { enabled: true } }),
        makeDeps(),
      )
      expect(cfg.selfLearning).toBeDefined()
      expect(cfg.selfLearning!.enabled).toBe(true)
      expect(cfg.selfLearning!.maxIterations).toBeUndefined()
    })

    it('overrides.selfLearning takes precedence over preset.selfCorrection', () => {
      const cfg = buildConfigFromPreset(
        makePreset({
          selfCorrection: { enabled: true, maxReflectionIterations: 5 },
        }),
        makeDeps({
          overrides: { selfLearning: { enabled: false, maxIterations: 2 } },
        }),
      )
      expect(cfg.selfLearning!.enabled).toBe(false)
      expect(cfg.selfLearning!.maxIterations).toBe(2)
    })

    it('overrides.selfLearning with partial fields', () => {
      const cfg = buildConfigFromPreset(
        makePreset({ selfCorrection: { enabled: true, maxReflectionIterations: 10 } }),
        makeDeps({
          overrides: { selfLearning: { enabled: true } },
        }),
      )
      expect(cfg.selfLearning!.enabled).toBe(true)
      expect(cfg.selfLearning!.maxIterations).toBeUndefined()
    })

    it('overrides.selfLearning works even without preset.selfCorrection', () => {
      const cfg = buildConfigFromPreset(
        makePreset(),
        makeDeps({
          overrides: { selfLearning: { enabled: true, maxIterations: 7 } },
        }),
      )
      expect(cfg.selfLearning!.enabled).toBe(true)
      expect(cfg.selfLearning!.maxIterations).toBe(7)
    })
  })

  // ---------------------------------------------------------------------------
  // defaultModelTier (NEW)
  // ---------------------------------------------------------------------------

  describe('defaultModelTier', () => {
    it('maps preset.defaultModelTier into output config', () => {
      const cfg = buildConfigFromPreset(
        makePreset({ defaultModelTier: 'reasoning' }),
        makeDeps(),
      )
      expect(cfg.defaultModelTier).toBe('reasoning')
    })

    it('defaultModelTier is undefined when not set on preset', () => {
      const cfg = buildConfigFromPreset(makePreset(), makeDeps())
      expect(cfg.defaultModelTier).toBeUndefined()
    })

    it('defaultModelTier for each built-in preset', () => {
      const ragCfg = buildConfigFromPreset(RAGChatPreset, makeDeps())
      expect(ragCfg.defaultModelTier).toBeUndefined()

      const researchCfg = buildConfigFromPreset(ResearchPreset, makeDeps())
      expect(researchCfg.defaultModelTier).toBe('reasoning')
    })
  })

  // ---------------------------------------------------------------------------
  // Return type is PresetConfig
  // ---------------------------------------------------------------------------

  describe('return type', () => {
    it('returns an object matching PresetConfig shape', () => {
      const cfg: PresetConfig = buildConfigFromPreset(makePreset(), makeDeps())
      // Type-level check: if this compiles, the return type is correct
      expect(cfg.id).toBeDefined()
      expect(cfg.name).toBeDefined()
      expect(cfg.instructions).toBeDefined()
      expect(cfg.guardrails).toBeDefined()
    })

    it('all expected top-level keys are present', () => {
      const cfg = buildConfigFromPreset(makePreset(), makeDeps())
      const keys = Object.keys(cfg)
      expect(keys).toContain('id')
      expect(keys).toContain('name')
      expect(keys).toContain('instructions')
      expect(keys).toContain('model')
      expect(keys).toContain('guardrails')
      expect(keys).toContain('defaultModelTier')
    })
  })
})

// ---------------------------------------------------------------------------
// PresetRegistry
// ---------------------------------------------------------------------------

describe('PresetRegistry', () => {
  it('registers and retrieves a preset by name', () => {
    const registry = new PresetRegistry()
    const preset = makePreset({ name: 'my-preset' })
    registry.register(preset)
    expect(registry.get('my-preset')).toBe(preset)
  })

  it('returns undefined for unregistered name', () => {
    const registry = new PresetRegistry()
    expect(registry.get('nonexistent')).toBeUndefined()
  })

  it('lists all registered presets', () => {
    const registry = new PresetRegistry()
    registry.register(makePreset({ name: 'a' }))
    registry.register(makePreset({ name: 'b' }))
    expect(registry.list()).toHaveLength(2)
  })

  it('listNames returns all registered names', () => {
    const registry = new PresetRegistry()
    registry.register(makePreset({ name: 'x' }))
    registry.register(makePreset({ name: 'y' }))
    expect(registry.listNames()).toEqual(['x', 'y'])
  })

  it('overwrites preset on re-register with same name', () => {
    const registry = new PresetRegistry()
    registry.register(makePreset({ name: 'dup', description: 'first' }))
    registry.register(makePreset({ name: 'dup', description: 'second' }))
    expect(registry.get('dup')!.description).toBe('second')
    expect(registry.list()).toHaveLength(1)
  })

  it('list returns empty array for empty registry', () => {
    const registry = new PresetRegistry()
    expect(registry.list()).toEqual([])
    expect(registry.listNames()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// createDefaultPresetRegistry (fixed behavior)
// ---------------------------------------------------------------------------

describe('createDefaultPresetRegistry', () => {
  it('returns a registry with 4 built-in presets', () => {
    const registry = createDefaultPresetRegistry()
    expect(registry.list()).toHaveLength(4)
  })

  it('contains rag-chat preset', () => {
    const registry = createDefaultPresetRegistry()
    expect(registry.get('rag-chat')).toBeDefined()
    expect(registry.get('rag-chat')!.name).toBe('rag-chat')
  })

  it('contains research preset', () => {
    const registry = createDefaultPresetRegistry()
    expect(registry.get('research')).toBeDefined()
  })

  it('contains summarizer preset', () => {
    const registry = createDefaultPresetRegistry()
    expect(registry.get('summarizer')).toBeDefined()
  })

  it('contains qa preset', () => {
    const registry = createDefaultPresetRegistry()
    expect(registry.get('qa')).toBeDefined()
  })

  it('listNames returns all 4 names', () => {
    const registry = createDefaultPresetRegistry()
    const names = registry.listNames()
    expect(names).toContain('rag-chat')
    expect(names).toContain('research')
    expect(names).toContain('summarizer')
    expect(names).toContain('qa')
  })

  it('allows adding custom presets alongside built-ins', () => {
    const registry = createDefaultPresetRegistry()
    registry.register(makePreset({ name: 'custom' }))
    expect(registry.list()).toHaveLength(5)
    expect(registry.get('custom')).toBeDefined()
  })
})
