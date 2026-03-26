import { describe, it, expect } from 'vitest'
import {
  getMemoryProfilePreset,
  resolveArrowMemoryConfig,
  type MemoryProfile,
} from '../agent/memory-profiles.js'

// ---------------------------------------------------------------------------
// getMemoryProfilePreset
// ---------------------------------------------------------------------------

describe('getMemoryProfilePreset', () => {
  it('returns correct values for "minimal"', () => {
    const preset = getMemoryProfilePreset('minimal')
    expect(preset.totalBudget).toBe(32_000)
    expect(preset.maxMemoryFraction).toBe(0.1)
    expect(preset.minResponseReserve).toBe(8_000)
    expect(preset.description.toLowerCase()).toContain('cost-constrained')
  })

  it('returns correct values for "balanced"', () => {
    const preset = getMemoryProfilePreset('balanced')
    expect(preset.totalBudget).toBe(128_000)
    expect(preset.maxMemoryFraction).toBe(0.3)
    expect(preset.minResponseReserve).toBe(4_000)
  })

  it('returns correct values for "memory-heavy"', () => {
    const preset = getMemoryProfilePreset('memory-heavy')
    expect(preset.totalBudget).toBe(200_000)
    expect(preset.maxMemoryFraction).toBe(0.5)
    expect(preset.minResponseReserve).toBe(4_000)
    expect(preset.description.toLowerCase()).toContain('knowledge-intensive')
  })

  it('returns distinct presets for each profile', () => {
    const profiles: MemoryProfile[] = ['minimal', 'balanced', 'memory-heavy']
    const budgets = profiles.map(p => getMemoryProfilePreset(p).totalBudget)
    expect(new Set(budgets).size).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// resolveArrowMemoryConfig
// ---------------------------------------------------------------------------

describe('resolveArrowMemoryConfig', () => {
  it('returns undefined when neither config nor profile is provided', () => {
    expect(resolveArrowMemoryConfig()).toBeUndefined()
    expect(resolveArrowMemoryConfig(undefined, undefined)).toBeUndefined()
  })

  it('uses profile defaults when only profile is provided', () => {
    const resolved = resolveArrowMemoryConfig(undefined, 'minimal')
    expect(resolved).toBeDefined()
    expect(resolved!.totalBudget).toBe(32_000)
    expect(resolved!.maxMemoryFraction).toBe(0.1)
    expect(resolved!.minResponseReserve).toBe(8_000)
    expect(resolved!.currentPhase).toBeUndefined()
  })

  it('falls back to balanced profile when only config is provided', () => {
    const resolved = resolveArrowMemoryConfig({ currentPhase: 'coding' })
    expect(resolved).toBeDefined()
    // Balanced defaults fill in missing fields
    expect(resolved!.totalBudget).toBe(128_000)
    expect(resolved!.maxMemoryFraction).toBe(0.3)
    expect(resolved!.minResponseReserve).toBe(4_000)
    expect(resolved!.currentPhase).toBe('coding')
  })

  it('explicit config values override profile defaults', () => {
    const resolved = resolveArrowMemoryConfig(
      { totalBudget: 50_000, maxMemoryFraction: 0.2 },
      'memory-heavy',
    )
    expect(resolved).toBeDefined()
    // Explicit overrides
    expect(resolved!.totalBudget).toBe(50_000)
    expect(resolved!.maxMemoryFraction).toBe(0.2)
    // Falls through to profile default
    expect(resolved!.minResponseReserve).toBe(4_000)
  })

  it('preserves currentPhase from config', () => {
    const resolved = resolveArrowMemoryConfig(
      { currentPhase: 'debugging' },
      'minimal',
    )
    expect(resolved!.currentPhase).toBe('debugging')
  })

  it('currentPhase is undefined when not set in config', () => {
    const resolved = resolveArrowMemoryConfig(
      { totalBudget: 64_000 },
      'balanced',
    )
    expect(resolved!.currentPhase).toBeUndefined()
  })

  it('empty config object still uses profile defaults', () => {
    const resolved = resolveArrowMemoryConfig({}, 'memory-heavy')
    expect(resolved!.totalBudget).toBe(200_000)
    expect(resolved!.maxMemoryFraction).toBe(0.5)
    expect(resolved!.minResponseReserve).toBe(4_000)
  })

  it('full explicit config overrides all profile defaults', () => {
    const resolved = resolveArrowMemoryConfig(
      {
        totalBudget: 10_000,
        maxMemoryFraction: 0.05,
        minResponseReserve: 2_000,
        currentPhase: 'reviewing',
      },
      'memory-heavy',
    )
    expect(resolved!.totalBudget).toBe(10_000)
    expect(resolved!.maxMemoryFraction).toBe(0.05)
    expect(resolved!.minResponseReserve).toBe(2_000)
    expect(resolved!.currentPhase).toBe('reviewing')
  })
})
