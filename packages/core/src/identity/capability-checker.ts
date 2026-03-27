/**
 * Capability-based authorization checker.
 *
 * Resolution order:
 * 1. Delegation token chain (if delegationTokenId provided)
 * 2. Direct capabilities from identity
 * 3. Role-based mapping fallback
 */
import { CapabilityMatcher } from '../registry/capability-matcher.js'
import type { ForgeCapability, ForgeIdentityRef } from './identity-types.js'
import type { DelegationManager } from './delegation-manager.js'

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface CapabilityCheckResult {
  allowed: boolean
  reason: string
  grantedBy?: 'delegation' | 'direct' | 'role'
  matchedCapability?: string
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CapabilityCheckerConfig {
  delegationManager?: DelegationManager
  roleCapabilityMap?: Record<string, string[]>
}

// ---------------------------------------------------------------------------
// Checker interface
// ---------------------------------------------------------------------------

export interface CapabilityCheckParams {
  identity: ForgeIdentityRef & { capabilities?: ForgeCapability[]; role?: string }
  requiredCapability: string
  delegationTokenId?: string
}

export interface CapabilityChecker {
  check(params: CapabilityCheckParams): Promise<CapabilityCheckResult>
}

// ---------------------------------------------------------------------------
// Default role -> capability map
// ---------------------------------------------------------------------------

const DEFAULT_ROLE_CAPABILITY_MAP: Record<string, string[]> = {
  admin: ['*'],
  operator: ['runs.*', 'agents.read', 'tools.*', 'approvals.*'],
  viewer: ['*.read'],
  agent: ['runs.*', 'tools.execute'],
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCapabilityChecker(
  config?: CapabilityCheckerConfig,
): CapabilityChecker {
  const delegationManager = config?.delegationManager
  const roleMap = config?.roleCapabilityMap ?? DEFAULT_ROLE_CAPABILITY_MAP
  const matcher = new CapabilityMatcher()

  /**
   * Match a capability against a pattern, supporting:
   * - Exact match: "code.review" matches "code.review"
   * - Global wildcard: "*" matches everything
   * - Suffix wildcard: "code.*" matches "code.review" (via CapabilityMatcher)
   * - Prefix wildcard: "*.read" matches "agents.read", "memory.read"
   */
  function matchesPattern(pattern: string, capability: string): boolean {
    if (pattern === '*') return true
    if (pattern === capability) return true

    // CapabilityMatcher handles suffix wildcards like "code.*"
    if (matcher.matchesPattern(pattern, capability)) return true

    // Handle prefix wildcards like "*.read"
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2) // e.g. "read"
      return capability === suffix || capability.endsWith('.' + suffix)
    }

    return false
  }

  function matchesAny(patterns: string[], capability: string): string | undefined {
    for (const pattern of patterns) {
      if (matchesPattern(pattern, capability)) {
        return pattern
      }
    }
    return undefined
  }

  return {
    async check(params: CapabilityCheckParams): Promise<CapabilityCheckResult> {
      const { identity, requiredCapability, delegationTokenId } = params

      // 1. Delegation chain check
      if (delegationTokenId && delegationManager) {
        const chain = await delegationManager.validateChain(delegationTokenId)
        if (!chain.valid) {
          return {
            allowed: false,
            reason: `Delegation chain invalid: ${chain.invalidReason ?? 'unknown'}`,
          }
        }

        const matched = matchesAny(chain.effectiveScope, requiredCapability)
        if (matched) {
          return {
            allowed: true,
            reason: 'Granted via delegation chain',
            grantedBy: 'delegation',
            matchedCapability: matched,
          }
        }

        // Delegation was provided but did not cover the capability
        return {
          allowed: false,
          reason: `Delegation chain does not grant "${requiredCapability}"`,
        }
      }

      // 2. Direct capabilities
      if (identity.capabilities && identity.capabilities.length > 0) {
        const capNames = identity.capabilities.map((c) => c.name)
        const matched = matchesAny(capNames, requiredCapability)
        if (matched) {
          return {
            allowed: true,
            reason: 'Granted via direct capability',
            grantedBy: 'direct',
            matchedCapability: matched,
          }
        }
      }

      // 3. Role-based fallback
      if (identity.role) {
        const rolePatterns = roleMap[identity.role]
        if (rolePatterns) {
          const matched = matchesAny(rolePatterns, requiredCapability)
          if (matched) {
            return {
              allowed: true,
              reason: `Granted via role "${identity.role}"`,
              grantedBy: 'role',
              matchedCapability: matched,
            }
          }
        }
      }

      // Denied
      return {
        allowed: false,
        reason: `No grant found for "${requiredCapability}"`,
      }
    },
  }
}
