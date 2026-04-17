/**
 * Sandbox permission tiers — configure Docker sandbox security based on trust level.
 *
 * Three tiers:
 * - read-only: No writes, no network, no processes (safest)
 * - workspace-write: Write to workspace dir only, no network
 * - full-access: Full filesystem, network, processes (for trusted code)
 */

export type PermissionTier = 'read-only' | 'workspace-write' | 'full-access'

export interface TierConfig {
  /** Allow network access */
  network: boolean
  /** Filesystem access level */
  filesystem: 'read-only' | 'workspace-only' | 'full'
  /** Allow spawning child processes */
  processes: boolean
  /** Max memory in MB */
  maxMemoryMb: number
  /** Max CPU count */
  maxCpus: number
  /** Execution timeout in ms */
  timeoutMs: number
}

export const TIER_DEFAULTS: Record<PermissionTier, TierConfig> = {
  'read-only': {
    network: false,
    filesystem: 'read-only',
    processes: false,
    maxMemoryMb: 256,
    maxCpus: 1,
    timeoutMs: 30_000,
  },
  'workspace-write': {
    network: false,
    filesystem: 'workspace-only',
    processes: true,
    maxMemoryMb: 512,
    maxCpus: 2,
    timeoutMs: 60_000,
  },
  'full-access': {
    network: true,
    filesystem: 'full',
    processes: true,
    maxMemoryMb: 1024,
    maxCpus: 4,
    timeoutMs: 120_000,
  },
}

/** Convert a permission tier to Docker run flags */
export function tierToDockerFlags(tier: PermissionTier): string[] {
  const config = TIER_DEFAULTS[tier]
  const flags: string[] = [
    `--memory=${config.maxMemoryMb}m`,
    `--cpus=${config.maxCpus}`,
    '--no-new-privileges',
  ]

  if (!config.network) flags.push('--network=none')
  if (config.filesystem === 'read-only') flags.push('--read-only')
  if (!config.processes) flags.push('--pids-limit=5')

  return flags
}

// ---------------------------------------------------------------------------
// Validation, merge, conversions, comparison helpers
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

/** Minimum allowed memory budget (MB) for any tier override. */
export const MIN_MEMORY_MB = 64
/** Minimum allowed CPU count for any tier override. */
export const MIN_CPUS = 1
/** Minimum allowed execution timeout (ms) for any tier override. */
export const MIN_TIMEOUT_MS = 1000

const VALID_FILESYSTEMS: ReadonlyArray<TierConfig['filesystem']> = [
  'read-only',
  'workspace-only',
  'full',
]

/**
 * Validate a partial {@link TierConfig} override for sane ranges.
 *
 * Returns `{ valid: true, errors: [] }` when all provided fields pass the
 * minimum threshold checks. Multiple errors accumulate in a single call.
 */
export function validateTierConfig(config: Partial<TierConfig>): ValidationResult {
  const errors: string[] = []

  if (config.maxMemoryMb !== undefined && config.maxMemoryMb < MIN_MEMORY_MB) {
    errors.push(`maxMemoryMb must be >= ${MIN_MEMORY_MB} (got ${config.maxMemoryMb})`)
  }
  if (config.maxCpus !== undefined && config.maxCpus < MIN_CPUS) {
    errors.push(`maxCpus must be >= ${MIN_CPUS} (got ${config.maxCpus})`)
  }
  if (config.timeoutMs !== undefined && config.timeoutMs < MIN_TIMEOUT_MS) {
    errors.push(`timeoutMs must be >= ${MIN_TIMEOUT_MS} (got ${config.timeoutMs})`)
  }
  if (
    config.filesystem !== undefined &&
    !VALID_FILESYSTEMS.includes(config.filesystem)
  ) {
    errors.push(
      `filesystem must be one of ${VALID_FILESYSTEMS.join(', ')} (got ${String(config.filesystem)})`,
    )
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Merge base tier defaults with partial overrides.
 *
 * Returns a new object — does not mutate {@link TIER_DEFAULTS}.
 */
export function mergeTierConfig(
  tier: PermissionTier,
  overrides: Partial<TierConfig>,
): TierConfig {
  return { ...TIER_DEFAULTS[tier], ...overrides }
}

/**
 * Convert a permission tier to an E2B sandbox config object.
 *
 * The returned shape is compatible with {@link E2BSandboxConfig}-style options
 * (e.g. `template`, `timeout`, `envs`, `metadata`).
 */
export function tierToE2bConfig(tier: PermissionTier): Record<string, unknown> {
  const config = TIER_DEFAULTS[tier]
  return {
    template: 'base',
    timeout: config.timeoutMs,
    envs: {},
    metadata: {
      tier,
      filesystem: config.filesystem,
      network: config.network,
      processes: config.processes,
      maxMemoryMb: config.maxMemoryMb,
      maxCpus: config.maxCpus,
    },
  }
}

const TIER_ORDER: Record<PermissionTier, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'full-access': 2,
}

/**
 * Compare two tiers by security level — `read-only` (most restrictive) is
 * lowest, `full-access` (least restrictive) is highest.
 *
 * Returns `-1` when `a` is more restrictive than `b`, `1` when `a` is more
 * permissive, and `0` when both are the same tier.
 */
export function compareTiers(a: PermissionTier, b: PermissionTier): -1 | 0 | 1 {
  const diff = TIER_ORDER[a] - TIER_ORDER[b]
  return diff < 0 ? -1 : diff > 0 ? 1 : 0
}

/**
 * Return the more restrictive of two tiers.
 *
 * When `a` and `b` have the same security level, `a` is returned.
 */
export function mostRestrictiveTier(
  a: PermissionTier,
  b: PermissionTier,
): PermissionTier {
  return compareTiers(a, b) <= 0 ? a : b
}
