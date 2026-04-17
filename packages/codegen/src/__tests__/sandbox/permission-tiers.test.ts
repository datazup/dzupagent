import { describe, it, expect } from 'vitest'

import {
  TIER_DEFAULTS,
  MIN_MEMORY_MB,
  MIN_CPUS,
  MIN_TIMEOUT_MS,
  tierToDockerFlags,
  validateTierConfig,
  mergeTierConfig,
  tierToE2bConfig,
  compareTiers,
  mostRestrictiveTier,
  type PermissionTier,
  type TierConfig,
} from '../../sandbox/permission-tiers.js'

// ===========================================================================
// TIER_DEFAULTS
// ===========================================================================

describe('TIER_DEFAULTS', () => {
  it('defines all three permission tiers', () => {
    expect(Object.keys(TIER_DEFAULTS).sort()).toEqual([
      'full-access',
      'read-only',
      'workspace-write',
    ])
  })

  it('read-only tier disables network, processes, and is filesystem read-only', () => {
    const t = TIER_DEFAULTS['read-only']
    expect(t.network).toBe(false)
    expect(t.processes).toBe(false)
    expect(t.filesystem).toBe('read-only')
  })

  it('workspace-write tier allows processes but not network', () => {
    const t = TIER_DEFAULTS['workspace-write']
    expect(t.network).toBe(false)
    expect(t.processes).toBe(true)
    expect(t.filesystem).toBe('workspace-only')
  })

  it('full-access tier enables network, processes, and full filesystem', () => {
    const t = TIER_DEFAULTS['full-access']
    expect(t.network).toBe(true)
    expect(t.processes).toBe(true)
    expect(t.filesystem).toBe('full')
  })

  it('read-only tier has the lowest memory budget', () => {
    expect(TIER_DEFAULTS['read-only'].maxMemoryMb).toBeLessThan(
      TIER_DEFAULTS['workspace-write'].maxMemoryMb,
    )
    expect(TIER_DEFAULTS['workspace-write'].maxMemoryMb).toBeLessThan(
      TIER_DEFAULTS['full-access'].maxMemoryMb,
    )
  })

  it('full-access tier has the highest memory and CPU budgets', () => {
    const all: TierConfig[] = Object.values(TIER_DEFAULTS)
    const maxMem = Math.max(...all.map((c) => c.maxMemoryMb))
    const maxCpu = Math.max(...all.map((c) => c.maxCpus))
    expect(TIER_DEFAULTS['full-access'].maxMemoryMb).toBe(maxMem)
    expect(TIER_DEFAULTS['full-access'].maxCpus).toBe(maxCpu)
  })
})

// ===========================================================================
// tierToDockerFlags
// ===========================================================================

describe('tierToDockerFlags', () => {
  it('always includes --no-new-privileges flag for any tier', () => {
    expect(tierToDockerFlags('read-only')).toContain('--no-new-privileges')
    expect(tierToDockerFlags('workspace-write')).toContain('--no-new-privileges')
    expect(tierToDockerFlags('full-access')).toContain('--no-new-privileges')
  })

  it('formats memory flag as --memory=<mb>m', () => {
    const flags = tierToDockerFlags('read-only')
    expect(flags).toContain(`--memory=${TIER_DEFAULTS['read-only'].maxMemoryMb}m`)
  })

  it('formats cpus flag as --cpus=<n>', () => {
    const flags = tierToDockerFlags('full-access')
    expect(flags).toContain(`--cpus=${TIER_DEFAULTS['full-access'].maxCpus}`)
  })

  it('read-only tier includes --read-only and --network=none', () => {
    const flags = tierToDockerFlags('read-only')
    expect(flags).toContain('--read-only')
    expect(flags).toContain('--network=none')
  })

  it('read-only tier includes --pids-limit=5 (no processes allowed)', () => {
    expect(tierToDockerFlags('read-only')).toContain('--pids-limit=5')
  })

  it('workspace-write tier blocks network but allows processes', () => {
    const flags = tierToDockerFlags('workspace-write')
    expect(flags).toContain('--network=none')
    expect(flags).not.toContain('--pids-limit=5')
  })

  it('workspace-write tier does NOT include --read-only flag', () => {
    expect(tierToDockerFlags('workspace-write')).not.toContain('--read-only')
  })

  it('full-access tier omits --network=none, --read-only, and --pids-limit=5', () => {
    const flags = tierToDockerFlags('full-access')
    expect(flags).not.toContain('--network=none')
    expect(flags).not.toContain('--read-only')
    expect(flags).not.toContain('--pids-limit=5')
  })

  it('returns memory flag matching the regex /--memory=\\d+m/', () => {
    const flags = tierToDockerFlags('workspace-write')
    const memFlag = flags.find((f) => f.startsWith('--memory='))
    expect(memFlag).toBeDefined()
    expect(memFlag).toMatch(/^--memory=\d+m$/)
  })
})

// ===========================================================================
// validateTierConfig
// ===========================================================================

describe('validateTierConfig', () => {
  it('returns valid:true with empty errors for a valid full config', () => {
    const result = validateTierConfig({
      maxMemoryMb: 256,
      maxCpus: 2,
      timeoutMs: 30_000,
    })
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('returns valid:true for an empty object (nothing to validate)', () => {
    const result = validateTierConfig({})
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('rejects maxMemoryMb below the minimum threshold', () => {
    const result = validateTierConfig({ maxMemoryMb: MIN_MEMORY_MB - 1 })
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toContain('maxMemoryMb')
  })

  it('accepts maxMemoryMb exactly at the minimum threshold', () => {
    const result = validateTierConfig({ maxMemoryMb: MIN_MEMORY_MB })
    expect(result.valid).toBe(true)
  })

  it('rejects maxCpus below the minimum threshold', () => {
    const result = validateTierConfig({ maxCpus: 0 })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('maxCpus')
  })

  it('rejects timeoutMs below the minimum threshold', () => {
    const result = validateTierConfig({ timeoutMs: 999 })
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('timeoutMs')
  })

  it('accumulates multiple errors when several fields are invalid', () => {
    const result = validateTierConfig({ maxMemoryMb: 1, maxCpus: 0, timeoutMs: 0 })
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBe(3)
  })

  it('reports MIN_TIMEOUT_MS constant value in the error message', () => {
    const result = validateTierConfig({ timeoutMs: 1 })
    expect(result.errors[0]).toContain(String(MIN_TIMEOUT_MS))
    expect(result.errors[0]).toContain('1')
  })
})

// ===========================================================================
// mergeTierConfig
// ===========================================================================

describe('mergeTierConfig', () => {
  it('applies overrides on top of tier defaults', () => {
    const merged = mergeTierConfig('read-only', { maxMemoryMb: 512 })
    expect(merged.maxMemoryMb).toBe(512)
  })

  it('preserves default values for fields not overridden', () => {
    const merged = mergeTierConfig('workspace-write', { maxMemoryMb: 2048 })
    expect(merged.maxCpus).toBe(TIER_DEFAULTS['workspace-write'].maxCpus)
    expect(merged.timeoutMs).toBe(TIER_DEFAULTS['workspace-write'].timeoutMs)
    expect(merged.network).toBe(TIER_DEFAULTS['workspace-write'].network)
  })

  it('does not mutate TIER_DEFAULTS when overrides are applied', () => {
    const before = { ...TIER_DEFAULTS['read-only'] }
    mergeTierConfig('read-only', { maxMemoryMb: 9999, maxCpus: 99, timeoutMs: 999_999 })
    expect(TIER_DEFAULTS['read-only']).toEqual(before)
  })

  it('returns a new object reference (not a reference to defaults)', () => {
    const merged = mergeTierConfig('full-access', {})
    expect(merged).not.toBe(TIER_DEFAULTS['full-access'])
    expect(merged).toEqual(TIER_DEFAULTS['full-access'])
  })

  it('overrides boolean fields like network and processes', () => {
    const merged = mergeTierConfig('read-only', { network: true, processes: true })
    expect(merged.network).toBe(true)
    expect(merged.processes).toBe(true)
  })
})

// ===========================================================================
// tierToE2bConfig
// ===========================================================================

describe('tierToE2bConfig', () => {
  it('returns an object containing timeout and envs fields', () => {
    const cfg = tierToE2bConfig('read-only')
    expect(cfg).toHaveProperty('timeout')
    expect(cfg).toHaveProperty('envs')
  })

  it('timeout value matches the tier defaults timeoutMs', () => {
    const cfg = tierToE2bConfig('workspace-write')
    expect(cfg.timeout).toBe(TIER_DEFAULTS['workspace-write'].timeoutMs)
  })

  it('embeds the tier name in metadata', () => {
    const cfg = tierToE2bConfig('full-access')
    const metadata = cfg.metadata as { tier: PermissionTier }
    expect(metadata.tier).toBe('full-access')
  })
})

// ===========================================================================
// compareTiers
// ===========================================================================

describe('compareTiers', () => {
  it('read-only is more restrictive than workspace-write (returns -1)', () => {
    expect(compareTiers('read-only', 'workspace-write')).toBe(-1)
  })

  it('workspace-write is more restrictive than full-access (returns -1)', () => {
    expect(compareTiers('workspace-write', 'full-access')).toBe(-1)
  })

  it('returns 0 when comparing the same tier', () => {
    expect(compareTiers('read-only', 'read-only')).toBe(0)
    expect(compareTiers('workspace-write', 'workspace-write')).toBe(0)
    expect(compareTiers('full-access', 'full-access')).toBe(0)
  })

  it('full-access is more permissive than read-only (returns 1)', () => {
    expect(compareTiers('full-access', 'read-only')).toBe(1)
  })
})

// ===========================================================================
// mostRestrictiveTier
// ===========================================================================

describe('mostRestrictiveTier', () => {
  it('returns read-only when compared with workspace-write', () => {
    expect(mostRestrictiveTier('read-only', 'workspace-write')).toBe('read-only')
    expect(mostRestrictiveTier('workspace-write', 'read-only')).toBe('read-only')
  })

  it('returns workspace-write when compared with full-access', () => {
    expect(mostRestrictiveTier('workspace-write', 'full-access')).toBe('workspace-write')
    expect(mostRestrictiveTier('full-access', 'workspace-write')).toBe('workspace-write')
  })

  it('returns the tier itself when both tiers are the same', () => {
    expect(mostRestrictiveTier('read-only', 'read-only')).toBe('read-only')
    expect(mostRestrictiveTier('full-access', 'full-access')).toBe('full-access')
  })
})
