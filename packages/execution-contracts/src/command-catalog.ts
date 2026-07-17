import { createHash } from 'node:crypto'
import { resolve, isAbsolute, normalize } from 'node:path'
import type { CatalogEntry, CommandCatalog } from './resource-policy.js'

/**
 * Command catalog enforcement — validates proposed commands against a versioned,
 * digest-sealed catalog. Fails closed: anything not explicitly allowed is denied.
 */

export type CommandValidationReason =
  | 'UNKNOWN_BINARY'
  | 'FORBIDDEN_ARGS'
  | 'FORBIDDEN_WORKDIR'
  | 'FORBIDDEN_ENV'
  | 'STALE_DIGEST'

export interface CommandValidationResult {
  allowed: boolean
  reason?: CommandValidationReason
  detail?: string
}

export class CommandValidationError extends Error {
  constructor(
    message: string,
    public readonly reason: CommandValidationReason,
  ) {
    super(message)
    this.name = 'CommandValidationError'
  }
}

// ---------------------------------------------------------------------------
// Canonical digest
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

/** Internal digest computation — not exported to avoid collision with resource-policy. */
function computeCatalogDigest(entries: CatalogEntry[]): string {
  return createHash('sha256').update(stableJson(entries), 'utf8').digest('hex')
}

/**
 * Verify that the catalog's embedded digest still matches its entries.
 * Returns false if tampered or stale.
 */
export function verifyCatalogDigest(catalog: CommandCatalog): boolean {
  const expected = computeCatalogDigest(catalog.entries)
  return expected === catalog.digest
}

// ---------------------------------------------------------------------------
// Argument matching
// ---------------------------------------------------------------------------

/**
 * Returns true if the argument is an exact match or matches one of the allowed
 * arg prefixes (prefix must end with a trailing space to avoid partial matches
 * on flags, or be an exact match).
 */
function argAllowed(arg: string, allowedArgs: string[]): boolean {
  return allowedArgs.some((allowed) => arg === allowed || arg.startsWith(`${allowed} `))
}

function allArgsAllowed(args: string[], allowedArgs: string[]): boolean {
  if (allowedArgs.length === 0) return true // empty allowedArgs = allow any
  return args.every((arg) => argAllowed(arg, allowedArgs))
}

// ---------------------------------------------------------------------------
// Working-directory policy
// ---------------------------------------------------------------------------

function checkWorkdir(workdir: string, policy: CatalogEntry['workdirPolicy'], checkoutRoot: string): boolean {
  if (policy === 'any') return true
  // 'checkout-only': workdir must be the checkout root or a subdirectory.
  // normalize() collapses '..' segments so that absolute paths like
  // /checkout/../../etc/passwd resolve to /etc/passwd before the prefix check.
  const resolvedWorkdir = normalize(isAbsolute(workdir) ? workdir : resolve(workdir))
  const resolvedRoot = normalize(isAbsolute(checkoutRoot) ? checkoutRoot : resolve(checkoutRoot))
  // Prevent path traversal: ensure resolved workdir starts with resolvedRoot.
  return resolvedWorkdir === resolvedRoot || resolvedWorkdir.startsWith(`${resolvedRoot}/`)
}

// ---------------------------------------------------------------------------
// Env-var filtering
// ---------------------------------------------------------------------------

function checkEnv(env: Record<string, string>, envAllowlist: string[] | undefined): boolean {
  if (envAllowlist === undefined) return true // no restriction
  const keys = Object.keys(env)
  return keys.every((key) => envAllowlist.includes(key))
}

// ---------------------------------------------------------------------------
// Main validation
// ---------------------------------------------------------------------------

/**
 * Validate a proposed command against the catalog. Requires a checkout root
 * when any entry uses workdirPolicy 'checkout-only'.
 *
 * Returns { allowed: true } when the command is explicitly permitted.
 * Returns { allowed: false, reason, detail } for any denial.
 */
export function validateCommand(
  binary: string,
  args: string[],
  workdir: string,
  env: Record<string, string>,
  catalog: CommandCatalog,
  checkoutRoot: string,
): CommandValidationResult {
  // First: verify catalog integrity.
  if (!verifyCatalogDigest(catalog)) {
    return {
      allowed: false,
      reason: 'STALE_DIGEST',
      detail: 'Command catalog digest does not match its entries; catalog may be tampered or stale.',
    }
  }

  // Find matching catalog entry (binary name match, exact).
  const entry = catalog.entries.find((e) => e.binary === binary)
  if (!entry) {
    return {
      allowed: false,
      reason: 'UNKNOWN_BINARY',
      detail: `Binary "${binary}" is not in the command catalog.`,
    }
  }

  // Check arguments.
  if (entry.allowedArgs !== undefined && !allArgsAllowed(args, entry.allowedArgs)) {
    return {
      allowed: false,
      reason: 'FORBIDDEN_ARGS',
      detail: `One or more arguments are not in the allowed-args list for "${binary}".`,
    }
  }

  // Check working directory.
  if (!checkWorkdir(workdir, entry.workdirPolicy, checkoutRoot)) {
    return {
      allowed: false,
      reason: 'FORBIDDEN_WORKDIR',
      detail: `Working directory is outside the checkout root for "${binary}" (policy: ${entry.workdirPolicy}).`,
    }
  }

  // Check environment variables.
  if (!checkEnv(env, entry.envAllowlist)) {
    return {
      allowed: false,
      reason: 'FORBIDDEN_ENV',
      detail: `One or more environment variables are not in the env allowlist for "${binary}".`,
    }
  }

  return { allowed: true }
}

// ---------------------------------------------------------------------------
// Default catalog
// ---------------------------------------------------------------------------

/**
 * Minimal default catalog with common safe binaries. All entries restrict
 * working directory to the checkout root. Extend via buildCommandCatalog().
 */
export const DEFAULT_CATALOG_ENTRIES: CatalogEntry[] = [
  {
    binary: 'git',
    workdirPolicy: 'checkout-only',
    // Allow any git sub-command; callers can tighten allowedArgs.
  },
  {
    binary: 'node',
    workdirPolicy: 'checkout-only',
  },
  {
    binary: 'yarn',
    workdirPolicy: 'checkout-only',
  },
  {
    binary: 'npm',
    workdirPolicy: 'checkout-only',
  },
  {
    binary: 'pnpm',
    workdirPolicy: 'checkout-only',
  },
]
