/**
 * Deeper coverage for memory-profiles.ts.
 *
 * The sibling `memory-profiles.test.ts` covers basics. This file explores:
 *   - Profile preset immutability guarantees
 *   - Ordering relationships across profiles
 *   - Each currentPhase value flowing through resolution
 *   - Zero-valued explicit overrides (should NOT be treated as "missing")
 *   - Fraction-overrides that leave budget untouched
 *   - Typing guarantees of ArrowMemoryConfig round-trips
 */
import { describe, it, expect } from 'vitest'
import {
  getMemoryProfilePreset,
  resolveArrowMemoryConfig,
  type MemoryProfile,
} from '../agent/memory-profiles.js'
import type { ArrowMemoryConfig } from '../agent/agent-types.js'

const ALL_PROFILES: MemoryProfile[] = ['minimal', 'balanced', 'memory-heavy']

// ---------------------------------------------------------------------------
// Preset structural guarantees
// ---------------------------------------------------------------------------

describe('getMemoryProfilePreset — structural guarantees', () => {
  it.each(ALL_PROFILES)('"%s" preset has a non-empty description', (profile) => {
    const preset = getMemoryProfilePreset(profile)
    expect(typeof preset.description).toBe('string')
    expect(preset.description.length).toBeGreaterThan(0)
  })

  it.each(ALL_PROFILES)('"%s" preset totalBudget is a positive integer', (profile) => {
    const { totalBudget } = getMemoryProfilePreset(profile)
    expect(Number.isInteger(totalBudget)).toBe(true)
    expect(totalBudget).toBeGreaterThan(0)
  })

  it.each(ALL_PROFILES)('"%s" preset maxMemoryFraction is in (0, 1]', (profile) => {
    const { maxMemoryFraction } = getMemoryProfilePreset(profile)
    expect(maxMemoryFraction).toBeGreaterThan(0)
    expect(maxMemoryFraction).toBeLessThanOrEqual(1)
  })

  it.each(ALL_PROFILES)(
    '"%s" preset minResponseReserve is non-negative and < totalBudget',
    (profile) => {
      const { minResponseReserve, totalBudget } = getMemoryProfilePreset(profile)
      expect(minResponseReserve).toBeGreaterThanOrEqual(0)
      expect(minResponseReserve).toBeLessThan(totalBudget)
    },
  )

  it('returns the same object shape repeatedly (deterministic)', () => {
    const a = getMemoryProfilePreset('balanced')
    const b = getMemoryProfilePreset('balanced')
    expect(a).toEqual(b)
  })

  it('each profile has a distinct totalBudget', () => {
    const budgets = ALL_PROFILES.map(p => getMemoryProfilePreset(p).totalBudget)
    expect(new Set(budgets).size).toBe(3)
  })

  it('each profile has a distinct maxMemoryFraction', () => {
    const fractions = ALL_PROFILES.map(p => getMemoryProfilePreset(p).maxMemoryFraction)
    expect(new Set(fractions).size).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Ordering relationships
// ---------------------------------------------------------------------------

describe('getMemoryProfilePreset — ordering', () => {
  it('totalBudget: minimal < balanced < memory-heavy', () => {
    const minimal = getMemoryProfilePreset('minimal').totalBudget
    const balanced = getMemoryProfilePreset('balanced').totalBudget
    const heavy = getMemoryProfilePreset('memory-heavy').totalBudget
    expect(minimal).toBeLessThan(balanced)
    expect(balanced).toBeLessThan(heavy)
  })

  it('maxMemoryFraction: minimal < balanced < memory-heavy', () => {
    const minimal = getMemoryProfilePreset('minimal').maxMemoryFraction
    const balanced = getMemoryProfilePreset('balanced').maxMemoryFraction
    const heavy = getMemoryProfilePreset('memory-heavy').maxMemoryFraction
    expect(minimal).toBeLessThan(balanced)
    expect(balanced).toBeLessThan(heavy)
  })

  it('minResponseReserve is largest for the "minimal" profile', () => {
    const minimal = getMemoryProfilePreset('minimal').minResponseReserve
    const balanced = getMemoryProfilePreset('balanced').minResponseReserve
    const heavy = getMemoryProfilePreset('memory-heavy').minResponseReserve
    expect(minimal).toBeGreaterThanOrEqual(balanced)
    expect(minimal).toBeGreaterThanOrEqual(heavy)
  })
})

// ---------------------------------------------------------------------------
// resolveArrowMemoryConfig — profile-only resolution
// ---------------------------------------------------------------------------

describe('resolveArrowMemoryConfig — profile only', () => {
  it.each(ALL_PROFILES)(
    'resolving only "%s" yields preset values verbatim',
    (profile) => {
      const preset = getMemoryProfilePreset(profile)
      const resolved = resolveArrowMemoryConfig(undefined, profile)
      expect(resolved).toBeDefined()
      expect(resolved!.totalBudget).toBe(preset.totalBudget)
      expect(resolved!.maxMemoryFraction).toBe(preset.maxMemoryFraction)
      expect(resolved!.minResponseReserve).toBe(preset.minResponseReserve)
      expect(resolved!.currentPhase).toBeUndefined()
    },
  )

  it.each(ALL_PROFILES)(
    'resolving "%s" does not include profile-only metadata on output',
    (profile) => {
      const resolved = resolveArrowMemoryConfig(undefined, profile)!
      // description is a profile-level field — it should NOT leak into the
      // resolved ArrowMemoryConfig
      expect(resolved).not.toHaveProperty('description')
    },
  )
})

// ---------------------------------------------------------------------------
// resolveArrowMemoryConfig — partial override precedence
// ---------------------------------------------------------------------------

describe('resolveArrowMemoryConfig — override precedence', () => {
  it('only totalBudget override keeps the other fields from the profile', () => {
    const resolved = resolveArrowMemoryConfig(
      { totalBudget: 99_999 },
      'memory-heavy',
    )!
    expect(resolved.totalBudget).toBe(99_999)
    expect(resolved.maxMemoryFraction).toBe(0.5) // memory-heavy default
    expect(resolved.minResponseReserve).toBe(4_000) // memory-heavy default
  })

  it('only maxMemoryFraction override keeps budget & reserve', () => {
    const resolved = resolveArrowMemoryConfig(
      { maxMemoryFraction: 0.9 },
      'minimal',
    )!
    expect(resolved.maxMemoryFraction).toBe(0.9)
    expect(resolved.totalBudget).toBe(32_000) // minimal
    expect(resolved.minResponseReserve).toBe(8_000) // minimal
  })

  it('only minResponseReserve override keeps budget & fraction', () => {
    const resolved = resolveArrowMemoryConfig(
      { minResponseReserve: 16_000 },
      'balanced',
    )!
    expect(resolved.minResponseReserve).toBe(16_000)
    expect(resolved.totalBudget).toBe(128_000)
    expect(resolved.maxMemoryFraction).toBe(0.3)
  })

  it('zero totalBudget override is preserved (not treated as missing)', () => {
    // `?? operator` means 0 is a valid override value, unlike `||`.
    const resolved = resolveArrowMemoryConfig({ totalBudget: 0 }, 'balanced')!
    expect(resolved.totalBudget).toBe(0)
  })

  it('zero maxMemoryFraction override is preserved', () => {
    const resolved = resolveArrowMemoryConfig({ maxMemoryFraction: 0 }, 'balanced')!
    expect(resolved.maxMemoryFraction).toBe(0)
  })

  it('zero minResponseReserve override is preserved', () => {
    const resolved = resolveArrowMemoryConfig({ minResponseReserve: 0 }, 'balanced')!
    expect(resolved.minResponseReserve).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// resolveArrowMemoryConfig — currentPhase pass-through
// ---------------------------------------------------------------------------

describe('resolveArrowMemoryConfig — currentPhase', () => {
  const phases: Array<NonNullable<ArrowMemoryConfig['currentPhase']>> = [
    'planning',
    'coding',
    'debugging',
    'reviewing',
    'general',
  ]

  it.each(phases)('flows "%s" through unchanged', (phase) => {
    const resolved = resolveArrowMemoryConfig({ currentPhase: phase }, 'balanced')!
    expect(resolved.currentPhase).toBe(phase)
  })

  it('undefined currentPhase stays undefined even with profile', () => {
    const resolved = resolveArrowMemoryConfig({}, 'minimal')!
    expect(resolved.currentPhase).toBeUndefined()
  })

  it('currentPhase is not injected by the profile itself', () => {
    const resolved = resolveArrowMemoryConfig(undefined, 'memory-heavy')!
    expect(resolved.currentPhase).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// resolveArrowMemoryConfig — undefined inputs
// ---------------------------------------------------------------------------

describe('resolveArrowMemoryConfig — undefined handling', () => {
  it('undefined + undefined returns undefined', () => {
    expect(resolveArrowMemoryConfig(undefined, undefined)).toBeUndefined()
  })

  it('only-config defaults profile to "balanced"', () => {
    const resolved = resolveArrowMemoryConfig({})!
    expect(resolved.totalBudget).toBe(128_000)
    expect(resolved.maxMemoryFraction).toBe(0.3)
    expect(resolved.minResponseReserve).toBe(4_000)
  })

  it('only-profile fully populates every field', () => {
    const resolved = resolveArrowMemoryConfig(undefined, 'minimal')!
    expect(resolved.totalBudget).toBeDefined()
    expect(resolved.maxMemoryFraction).toBeDefined()
    expect(resolved.minResponseReserve).toBeDefined()
  })

  it('config with undefined fields and no profile uses balanced', () => {
    const resolved = resolveArrowMemoryConfig({
      totalBudget: undefined,
      maxMemoryFraction: undefined,
      minResponseReserve: undefined,
    })!
    expect(resolved.totalBudget).toBe(128_000)
    expect(resolved.maxMemoryFraction).toBe(0.3)
    expect(resolved.minResponseReserve).toBe(4_000)
  })
})

// ---------------------------------------------------------------------------
// resolveArrowMemoryConfig — full override
// ---------------------------------------------------------------------------

describe('resolveArrowMemoryConfig — full overrides', () => {
  it('full config without profile gives exact input', () => {
    const cfg: ArrowMemoryConfig = {
      totalBudget: 64_000,
      maxMemoryFraction: 0.25,
      minResponseReserve: 2_500,
      currentPhase: 'coding',
    }
    const resolved = resolveArrowMemoryConfig(cfg)!
    expect(resolved).toEqual(cfg)
  })

  it('full config overrides every profile value', () => {
    const cfg: ArrowMemoryConfig = {
      totalBudget: 64_000,
      maxMemoryFraction: 0.25,
      minResponseReserve: 2_500,
      currentPhase: 'planning',
    }
    const resolved = resolveArrowMemoryConfig(cfg, 'memory-heavy')!
    expect(resolved).toEqual(cfg)
  })

  it('resolved object is not the same reference as input', () => {
    const cfg: ArrowMemoryConfig = { totalBudget: 10_000 }
    const resolved = resolveArrowMemoryConfig(cfg)!
    expect(resolved).not.toBe(cfg)
  })
})

// ---------------------------------------------------------------------------
// Cross-check: presets match resolved defaults
// ---------------------------------------------------------------------------

describe('resolveArrowMemoryConfig — cross-checks', () => {
  it.each(ALL_PROFILES)(
    'resolved (undefined, "%s") matches getMemoryProfilePreset numeric fields',
    (profile) => {
      const preset = getMemoryProfilePreset(profile)
      const resolved = resolveArrowMemoryConfig(undefined, profile)!
      expect(resolved.totalBudget).toBe(preset.totalBudget)
      expect(resolved.maxMemoryFraction).toBe(preset.maxMemoryFraction)
      expect(resolved.minResponseReserve).toBe(preset.minResponseReserve)
    },
  )

  it('empty-config + profile equals profile-only resolution', () => {
    for (const profile of ALL_PROFILES) {
      const a = resolveArrowMemoryConfig({}, profile)!
      const b = resolveArrowMemoryConfig(undefined, profile)!
      expect(a).toEqual(b)
    }
  })
})
