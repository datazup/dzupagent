/**
 * Memory budget profiles — predefined configurations for Arrow-based
 * token-budgeted memory selection.
 *
 * Profiles allow callers to pick a preset (minimal / balanced / memory-heavy)
 * instead of manually specifying totalBudget, maxMemoryFraction, and
 * minResponseReserve.  Explicit overrides in ArrowMemoryConfig always win.
 */
import type { ArrowMemoryConfig } from './agent-types.js'

/** Named memory budget profile. */
export type MemoryProfile = 'minimal' | 'balanced' | 'memory-heavy'

/** Preset values for a memory profile. */
export interface MemoryProfilePreset {
  totalBudget: number
  maxMemoryFraction: number
  minResponseReserve: number
  description: string
}

const PROFILE_PRESETS: Record<MemoryProfile, MemoryProfilePreset> = {
  minimal: {
    totalBudget: 32_000,
    maxMemoryFraction: 0.1,
    minResponseReserve: 8_000,
    description: 'Cost-constrained workers — small context, large response reserve',
  },
  balanced: {
    totalBudget: 128_000,
    maxMemoryFraction: 0.3,
    minResponseReserve: 4_000,
    description: 'Default profile — matches standard Arrow memory defaults',
  },
  'memory-heavy': {
    totalBudget: 200_000,
    maxMemoryFraction: 0.5,
    minResponseReserve: 4_000,
    description: 'Knowledge-intensive tasks — large context, high memory fraction',
  },
} as const

/**
 * Return the preset values for a given memory profile.
 */
export function getMemoryProfilePreset(profile: MemoryProfile): MemoryProfilePreset {
  return PROFILE_PRESETS[profile]
}

/**
 * Resolve an ArrowMemoryConfig by merging a profile's defaults with any
 * explicit overrides.
 *
 * Precedence (highest → lowest):
 *   1. Explicit fields in `config`
 *   2. Profile preset values
 *   3. Built-in defaults (balanced profile)
 *
 * If neither `config` nor `profile` is provided, returns `undefined` so the
 * caller knows Arrow memory was not requested.
 */
export function resolveArrowMemoryConfig(
  config?: ArrowMemoryConfig,
  profile?: MemoryProfile,
): ArrowMemoryConfig | undefined {
  if (!config && !profile) return undefined

  const preset = getMemoryProfilePreset(profile ?? 'balanced')

  return {
    totalBudget: config?.totalBudget ?? preset.totalBudget,
    maxMemoryFraction: config?.maxMemoryFraction ?? preset.maxMemoryFraction,
    minResponseReserve: config?.minResponseReserve ?? preset.minResponseReserve,
    currentPhase: config?.currentPhase,
  }
}
