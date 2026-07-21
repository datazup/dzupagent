import { createHash } from 'node:crypto'

/**
 * Versioned, signed resource-policy contract for worker execution isolation.
 * Worker-app is the neutral owner — no Codev product semantics here.
 */

export const RESOURCE_POLICY_VERSION = 'v1' as const
export type ResourcePolicyVersion = typeof RESOURCE_POLICY_VERSION

/** Canonical UTC ISO 8601 timestamp with exactly millisecond precision. */
export type UtcTimestamp = string

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
  /**
   * Time at which this policy was issued, in canonical UTC ISO 8601 form
   * (`YYYY-MM-DDTHH:mm:ss.sssZ`). Must be paired with `expiresAt`.
   */
  issuedAt?: UtcTimestamp
  /**
   * Exclusive policy expiration time, in canonical UTC ISO 8601 form.
   * Must be paired with `issuedAt` and later than it.
   */
  expiresAt?: UtcTimestamp
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

/** Deterministic time input for strict policy validation at claim time. */
export interface PolicyClaimValidationInput {
  claimedAt: UtcTimestamp
}

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function parseCanonicalUtcTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !CANONICAL_UTC_TIMESTAMP.test(value)) return undefined
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) return undefined
  return timestamp
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

  const hasIssuedAt = p['issuedAt'] !== undefined
  const hasExpiresAt = p['expiresAt'] !== undefined
  const issuedAt = hasIssuedAt ? parseCanonicalUtcTimestamp(p['issuedAt']) : undefined
  const expiresAt = hasExpiresAt ? parseCanonicalUtcTimestamp(p['expiresAt']) : undefined
  if (hasIssuedAt !== hasExpiresAt) {
    errors.push('issuedAt and expiresAt must either both be present or both be absent')
  }
  if (hasIssuedAt && issuedAt === undefined) {
    errors.push('issuedAt must be a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)')
  }
  if (hasExpiresAt && expiresAt === undefined) {
    errors.push('expiresAt must be a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)')
  }
  if (issuedAt !== undefined && expiresAt !== undefined && expiresAt <= issuedAt) {
    errors.push('policy validity must be positive: expiresAt must be later than issuedAt')
  }

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

/**
 * Strictly validates a signed policy for a claim made at a caller-supplied time.
 *
 * Unlike structural validation, this fails closed when a legacy v1 policy has
 * no temporal fields. `expiresAt` is exclusive: a claim exactly at expiration
 * is rejected.
 */
export function validateSignedExecutionPolicyForClaim(
  value: unknown,
  input: PolicyClaimValidationInput,
): PolicyValidationResult {
  const signedResult = validateSignedExecutionPolicy(value)
  const errors = [...signedResult.errors]
  const claimedAt = parseCanonicalUtcTimestamp(input.claimedAt)

  if (claimedAt === undefined) {
    errors.push('claimedAt must be a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)')
  }

  if (value !== null && typeof value === 'object') {
    const policy = (value as Record<string, unknown>)['policy']
    if (policy !== null && typeof policy === 'object') {
      const resourcePolicy = policy as Record<string, unknown>
      const issuedAt = parseCanonicalUtcTimestamp(resourcePolicy['issuedAt'])
      const expiresAt = parseCanonicalUtcTimestamp(resourcePolicy['expiresAt'])

      if (resourcePolicy['issuedAt'] === undefined || resourcePolicy['expiresAt'] === undefined) {
        errors.push('issuedAt and expiresAt are required for claim-time validation')
      } else if (claimedAt !== undefined && issuedAt !== undefined && expiresAt !== undefined) {
        if (claimedAt < issuedAt) {
          errors.push('policy is not valid before issuedAt')
        }
        if (claimedAt >= expiresAt) {
          errors.push('policy is expired at claimedAt (expiresAt is exclusive)')
        }
      }
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
