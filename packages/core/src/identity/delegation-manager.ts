/**
 * Delegation manager — issues, verifies, and validates delegation token chains.
 *
 * Uses HMAC-SHA256 for token signatures and supports multi-level
 * sub-delegation with scope narrowing and depth limits.
 */
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto'

import { CapabilityMatcher } from '../registry/capability-matcher.js'
import type {
  DelegationToken,
  DelegationTokenStore,
  DelegationConstraint,
  DelegationChain,
} from './delegation-types.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DelegationManagerConfig {
  /** Token persistence store. */
  store: DelegationTokenStore
  /** Secret used for HMAC-SHA256 signing. */
  signingSecret: string
  /** Maximum delegation chain depth (default: 3). */
  maxDepth?: number
}

// ---------------------------------------------------------------------------
// Issue params
// ---------------------------------------------------------------------------

export interface IssueDelegationParams {
  delegator: string
  delegatee: string
  scope: string[]
  constraints?: DelegationConstraint[]
  parentTokenId?: string
  /** Time-to-live in milliseconds (default: 3_600_000 = 1 hour). */
  expiresInMs?: number
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DEPTH = 3
const DEFAULT_EXPIRES_MS = 3_600_000 // 1 hour

export class DelegationManager {
  private readonly store: DelegationTokenStore
  private readonly signingSecret: string
  private readonly maxDepth: number
  private readonly matcher = new CapabilityMatcher()

  /**
   * Tracks parent -> child token relationships for cascading revocation.
   * This is maintained alongside the store because the DelegationTokenStore
   * interface does not expose a children-by-parent query.
   */
  private readonly childrenMap = new Map<string, Set<string>>()

  constructor(config: DelegationManagerConfig) {
    this.store = config.store
    this.signingSecret = config.signingSecret
    this.maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH
  }

  // -----------------------------------------------------------------------
  // Issue
  // -----------------------------------------------------------------------

  /**
   * Issue a new delegation token.
   *
   * When `parentTokenId` is supplied the new token's scope must be a subset
   * of the parent's scope, and the depth must not exceed `maxDepth`.
   */
  async issue(params: IssueDelegationParams): Promise<DelegationToken> {
    let depth = 0

    if (params.parentTokenId) {
      const parent = await this.store.get(params.parentTokenId)
      if (!parent) {
        throw new Error(`Parent token not found: ${params.parentTokenId}`)
      }

      depth = parent.depth + 1
      if (depth > this.maxDepth) {
        throw new Error(
          `Delegation depth ${depth} exceeds maximum of ${this.maxDepth}`,
        )
      }

      // Validate scope narrowing: every requested scope pattern must be
      // covered by at least one pattern in the parent scope.
      for (const requested of params.scope) {
        const covered = parent.scope.some(
          (parentPattern) =>
            parentPattern === '*' ||
            parentPattern === requested ||
            this.matcher.matchesPattern(parentPattern, requested),
        )
        if (!covered) {
          throw new Error(
            `Scope "${requested}" is not covered by parent scope [${parent.scope.join(', ')}]`,
          )
        }
      }
    }

    const now = new Date()
    const expiresAt = new Date(now.getTime() + (params.expiresInMs ?? DEFAULT_EXPIRES_MS))

    const token: DelegationToken = {
      id: randomUUID(),
      delegator: params.delegator,
      delegatee: params.delegatee,
      scope: params.scope,
      constraints: params.constraints ?? [],
      ...(params.parentTokenId !== undefined && { parentTokenId: params.parentTokenId }),
      depth,
      issuedAt: now,
      expiresAt,
      signature: '', // placeholder — computed below
    }

    token.signature = this.computeSignature(token)

    await this.store.save(token)

    // Track parent-child relationship for cascading revocation
    if (params.parentTokenId) {
      this.registerChild(params.parentTokenId, token.id)
    }

    return token
  }

  // -----------------------------------------------------------------------
  // Verify
  // -----------------------------------------------------------------------

  /** Verify the HMAC-SHA256 signature of a single token using timing-safe comparison. */
  async verify(token: DelegationToken): Promise<boolean> {
    const expected = this.computeSignature(token)
    const expectedBuf = Buffer.from(expected, 'base64url')
    const actualBuf = Buffer.from(token.signature, 'base64url')

    if (expectedBuf.length !== actualBuf.length) {
      return false
    }

    return timingSafeEqual(expectedBuf, actualBuf)
  }

  // -----------------------------------------------------------------------
  // Validate chain
  // -----------------------------------------------------------------------

  /**
   * Walk the delegation chain from the given token back to the root,
   * verifying signatures, expiration, and revocation at each level.
   * Returns the chain with intersected effective scope.
   */
  async validateChain(tokenId: string): Promise<DelegationChain> {
    const tokens: DelegationToken[] = []
    let currentId: string | undefined = tokenId

    // Walk from leaf to root
    while (currentId) {
      const token = await this.store.get(currentId)
      if (!token) {
        return {
          tokens,
          effectiveScope: [],
          valid: false,
          invalidReason: `Token not found: ${currentId}`,
        }
      }

      // Check revocation
      const revoked = await this.store.isRevoked(token.id)
      if (revoked) {
        return {
          tokens: [...tokens, token],
          effectiveScope: [],
          valid: false,
          invalidReason: `Token revoked: ${token.id}`,
        }
      }

      // Check expiration
      if (token.expiresAt.getTime() < Date.now()) {
        return {
          tokens: [...tokens, token],
          effectiveScope: [],
          valid: false,
          invalidReason: `Token expired: ${token.id}`,
        }
      }

      // Verify signature
      const sigValid = await this.verify(token)
      if (!sigValid) {
        return {
          tokens: [...tokens, token],
          effectiveScope: [],
          valid: false,
          invalidReason: `Invalid signature on token: ${token.id}`,
        }
      }

      // Check depth
      if (token.depth > this.maxDepth) {
        return {
          tokens: [...tokens, token],
          effectiveScope: [],
          valid: false,
          invalidReason: `Delegation depth ${token.depth} exceeds maximum of ${this.maxDepth}`,
        }
      }

      tokens.push(token)
      currentId = token.parentTokenId
    }

    // Reverse so root is first
    tokens.reverse()

    // Intersect scopes across the chain
    const effectiveScope = this.intersectScopes(
      tokens.map((t) => t.scope),
    )

    return {
      tokens,
      effectiveScope,
      valid: true,
    }
  }

  // -----------------------------------------------------------------------
  // Revoke
  // -----------------------------------------------------------------------

  /**
   * Revoke a token and cascade revocation to all child tokens.
   */
  async revoke(tokenId: string): Promise<void> {
    await this.store.revoke(tokenId)
    await this.cascadeRevoke(tokenId)
  }

  // -----------------------------------------------------------------------
  // Capability check helper
  // -----------------------------------------------------------------------

  /**
   * Check if a specific capability is present in the chain's effective scope.
   */
  hasCapabilityInChain(chain: DelegationChain, capability: string): boolean {
    if (!chain.valid) return false

    return chain.effectiveScope.some(
      (pattern) =>
        pattern === '*' ||
        pattern === capability ||
        this.matcher.matchesPattern(pattern, capability),
    )
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private computeSignature(token: DelegationToken): string {
    const payload = [
      token.id,
      token.delegator,
      token.delegatee,
      token.scope.join(','),
      String(token.depth),
      token.issuedAt.toISOString(),
      token.expiresAt.toISOString(),
    ].join('|')

    return createHmac('sha256', this.signingSecret)
      .update(payload)
      .digest('base64url')
  }

  /**
   * Intersect an array of scope arrays.
   * A pattern in the result survives only if it is covered by every scope array.
   */
  private intersectScopes(scopeArrays: string[][]): string[] {
    if (scopeArrays.length === 0) return []
    if (scopeArrays.length === 1) return scopeArrays[0] ?? []

    // Start with the leaf scope (most restricted, last in array)
    let result = scopeArrays[scopeArrays.length - 1]!

    // Keep only patterns covered by every preceding scope
    for (let i = scopeArrays.length - 2; i >= 0; i--) {
      const parentScope = scopeArrays[i]!
      result = result.filter((pattern) =>
        parentScope.some(
          (parentPattern) =>
            parentPattern === '*' ||
            parentPattern === pattern ||
            this.matcher.matchesPattern(parentPattern, pattern),
        ),
      )
    }

    return result
  }

  private registerChild(parentId: string, childId: string): void {
    let children = this.childrenMap.get(parentId)
    if (!children) {
      children = new Set<string>()
      this.childrenMap.set(parentId, children)
    }
    children.add(childId)
  }

  private async cascadeRevoke(parentId: string): Promise<void> {
    const children = this.childrenMap.get(parentId)
    if (!children) return

    for (const childId of children) {
      await this.store.revoke(childId)
      await this.cascadeRevoke(childId)
    }
  }
}
