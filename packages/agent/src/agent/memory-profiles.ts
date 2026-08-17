/**
 * Memory budget profiles — predefined configurations for Arrow-based
 * token-budgeted memory selection.
 *
 * Profiles allow callers to pick a preset (minimal / balanced / memory-heavy)
 * instead of manually specifying totalBudget, maxMemoryFraction, and
 * minResponseReserve.  Explicit overrides in ArrowMemoryConfig always win.
 */
import type { ArrowMemoryConfig } from './arrow-memory-types.js'
import { omitUndefined } from '../utils/exact-optional.js'

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
 *
 * `config` is deliberately widened to allow present-but-undefined fields
 * rather than taking a bare `ArrowMemoryConfig`. Under
 * `exactOptionalPropertyTypes` an `ArrowMemoryConfig` parameter would reject
 * `{ totalBudget: undefined }`, yet every field is read through
 * `config?.x ?? preset.x`, which handles a present-undefined identically to an
 * absent key — and that behaviour is what distinguishes this resolver from a
 * `{ ...preset, ...config }` spread, where a present-undefined would clobber
 * the preset. Untyped callers (JSON config, JS consumers) reach this shape, so
 * the signature now states what the body already guarantees.
 */
export function resolveArrowMemoryConfig(
  config?: { [K in keyof ArrowMemoryConfig]?: ArrowMemoryConfig[K] | undefined },
  profile?: MemoryProfile,
): ArrowMemoryConfig | undefined {
  if (!config && !profile) return undefined

  const preset = getMemoryProfilePreset(profile ?? 'balanced')

  return omitUndefined({
    totalBudget: config?.totalBudget ?? preset.totalBudget,
    maxMemoryFraction: config?.maxMemoryFraction ?? preset.maxMemoryFraction,
    minResponseReserve: config?.minResponseReserve ?? preset.minResponseReserve,
    currentPhase: config?.currentPhase,
  })
}
