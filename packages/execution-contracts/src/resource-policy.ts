import { createHash } from 'node:crypto'

/**
 * Versioned, signed resource-policy contract for worker execution isolation.
 * Worker-app is the neutral owner — no Codev product semantics here.
 */

export const RESOURCE_POLICY_VERSION = 'v1' as const
export type ResourcePolicyVersion = typeof RESOURCE_POLICY_VERSION

/**
 * Provider endpoint grant — label only, no raw URLs or credentials.
 */
export interface EgressGrant {
  /** Stable identifier for the provider (e.g. 'codex', 'claude', 'mcp-gateway'). */
  provider: string
  /** Human-readable label for audit logs. */
  label: string
}

/**
 * Versioned resource quota and egress grants for one execution scope.
 */
export interface ResourcePolicy {
  version: ResourcePolicyVersion
  policyId: string
  /** CPU shares relative to 1024 (Linux cgroups cpu.shares). Absent = uncapped. */
  cpuShares?: number
  /** Memory limit in MiB. Absent = uncapped. */
  memoryMb?: number
  /** Maximum descendant PIDs (Linux cgroups pids.max). Absent = uncapped. */
  pidLimit?: number
  /** Hard wall-clock time limit in seconds for the entire execution. */
  wallTimeSec: number
  /** Scratch-directory size limit in MiB. Absent = uncapped. */
  scratchMb?: number
  /** Explicit egress grants; all other traffic is denied. */
  egressGrants: EgressGrant[]
}

export interface CatalogEntry {
  /** Absolute binary name or path (e.g. 'git', 'node', 'yarn'). */
  binary: string
  /** Allowlisted argument prefixes. Absent = allow any arguments. */
  allowedArgs?: string[]
  /**
   * Working-directory policy.
   * 'checkout-only' — must be within the execution checkout root.
   * 'any' — no restriction (use with care).
   */
  workdirPolicy: 'checkout-only' | 'any'
  /** Environment variable names that may be passed through. */
  envAllowlist?: string[]
}

/**
 * Versioned, digest-sealed command catalog.
 */
export interface CommandCatalog {
  version: ResourcePolicyVersion
  /** SHA-256 of canonical JSON of entries (computed, not trusted from input). */
  digest: string
  entries: CatalogEntry[]
}

/**
 * Execution policy bundled with its catalog, ready to bind into a signed intent.
 * The signature field is a SHA-256 hash of the canonical JSON of policy + catalog.
 */
export interface SignedExecutionPolicy {
  policy: ResourcePolicy
  catalog: CommandCatalog
  /** SHA-256 hex of canonical JSON of { policy, catalog }. */
  signature: string
}

// ---------------------------------------------------------------------------
// Canonical JSON helpers
// ---------------------------------------------------------------------------

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Catalog digest
// ---------------------------------------------------------------------------

export function computeCatalogDigest(entries: CatalogEntry[]): string {
  return sha256Hex(stableJson(entries))
}

// ---------------------------------------------------------------------------
// Policy signing
// ---------------------------------------------------------------------------

export function computePolicySignature(policy: ResourcePolicy, catalog: CommandCatalog): string {
  return sha256Hex(stableJson({ policy, catalog }))
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function buildCommandCatalog(entries: CatalogEntry[]): CommandCatalog {
  return {
    version: RESOURCE_POLICY_VERSION,
    digest: computeCatalogDigest(entries),
    entries,
  }
}

export function buildSignedExecutionPolicy(policy: ResourcePolicy, catalog: CommandCatalog): SignedExecutionPolicy {
  return {
    policy,
    catalog,
    signature: computePolicySignature(policy, catalog),
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export interface PolicyValidationResult {
  valid: boolean
  errors: string[]
}

export function validateResourcePolicy(value: unknown): PolicyValidationResult {
  const errors: string[] = []
  if (value === null || typeof value !== 'object') {
    return { valid: false, errors: ['ResourcePolicy must be an object'] }
  }
  const p = value as Record<string, unknown>
  if (p['version'] !== RESOURCE_POLICY_VERSION) errors.push(`version must be "${RESOURCE_POLICY_VERSION}"`)
  if (typeof p['policyId'] !== 'string' || p['policyId'].length === 0)
    errors.push('policyId must be a non-empty string')
  if (typeof p['wallTimeSec'] !== 'number' || !Number.isFinite(p['wallTimeSec']) || p['wallTimeSec'] <= 0) {
    errors.push('wallTimeSec must be a positive finite number')
  }
  if (
    p['cpuShares'] !== undefined &&
    (typeof p['cpuShares'] !== 'number' || !Number.isInteger(p['cpuShares']) || (p['cpuShares'] as number) < 2)
  ) {
    errors.push('cpuShares must be an integer >= 2')
  }
  if (
    p['memoryMb'] !== undefined &&
    (typeof p['memoryMb'] !== 'number' || !Number.isInteger(p['memoryMb']) || (p['memoryMb'] as number) < 1)
  ) {
    errors.push('memoryMb must be an integer >= 1')
  }
  if (
    p['pidLimit'] !== undefined &&
    (typeof p['pidLimit'] !== 'number' || !Number.isInteger(p['pidLimit']) || (p['pidLimit'] as number) < 1)
  ) {
    errors.push('pidLimit must be an integer >= 1')
  }
  if (
    p['scratchMb'] !== undefined &&
    (typeof p['scratchMb'] !== 'number' || !Number.isInteger(p['scratchMb']) || (p['scratchMb'] as number) < 1)
  ) {
    errors.push('scratchMb must be an integer >= 1')
  }
  if (!Array.isArray(p['egressGrants'])) {
    errors.push('egressGrants must be an array')
  } else {
    for (const [i, g] of (p['egressGrants'] as unknown[]).entries()) {
      if (typeof (g as Record<string, unknown>)['provider'] !== 'string') {
        errors.push(`egressGrants[${i}].provider must be a string`)
      }
      if (typeof (g as Record<string, unknown>)['label'] !== 'string') {
        errors.push(`egressGrants[${i}].label must be a string`)
      }
    }
  }
  return { valid: errors.length === 0, errors }
}

export function validateSignedExecutionPolicy(value: unknown): PolicyValidationResult {
  const errors: string[] = []
  if (value === null || typeof value !== 'object') {
    return { valid: false, errors: ['SignedExecutionPolicy must be an object'] }
  }
  const p = value as Record<string, unknown>
  const policyResult = validateResourcePolicy(p['policy'])
  errors.push(...policyResult.errors)
  if (typeof p['signature'] !== 'string' || p['signature'].length !== 64) {
    errors.push('signature must be a 64-character hex SHA-256 string')
  } else {
    // Re-compute and verify digest integrity
    try {
      const catalog = p['catalog'] as CommandCatalog
      const expected = computePolicySignature(p['policy'] as ResourcePolicy, catalog)
      if (expected !== p['signature']) {
        errors.push('signature does not match policy + catalog digest')
      }
    } catch {
      errors.push('signature verification failed')
    }
  }
  return { valid: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// Default minimal policy (permissive, for bootstrapping)
// ---------------------------------------------------------------------------

export function createDefaultResourcePolicy(overrides?: Partial<ResourcePolicy>): ResourcePolicy {
  return {
    version: RESOURCE_POLICY_VERSION,
    policyId: 'default',
    wallTimeSec: 3600,
    egressGrants: [],
    ...overrides,
  }
}
