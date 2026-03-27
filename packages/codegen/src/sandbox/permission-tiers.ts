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
