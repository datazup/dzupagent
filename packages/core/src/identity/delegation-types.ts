/**
 * Delegation token types for capability-based authorization.
 *
 * Tokens form chains: a delegator issues a token to a delegatee,
 * who may sub-delegate via a child token (with narrower scope).
 */

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

/** Constraint limiting what a delegatee can do with the delegated capabilities. */
export type DelegationConstraint =
  | { type: 'max-cost'; maxCostCents: number }
  | { type: 'max-tokens'; maxTokens: number }
  | { type: 'max-iterations'; maxIterations: number }
  | { type: 'allowed-tools'; tools: string[] }
  | { type: 'time-window'; startAt: Date; endAt: Date }

// ---------------------------------------------------------------------------
// Delegation Token
// ---------------------------------------------------------------------------

/** A signed delegation token granting capabilities from delegator to delegatee. */
export interface DelegationToken {
  /** Unique token ID (opaque string, typically a UUID). */
  id: string
  /** Forge URI of the identity issuing this delegation. */
  delegator: string
  /** Forge URI of the identity receiving the delegation. */
  delegatee: string
  /** Capability patterns granted (e.g. "code.*", "memory.read"). */
  scope: string[]
  /** Operational constraints on the delegation. */
  constraints: DelegationConstraint[]
  /** Parent token ID for sub-delegation chains. */
  parentTokenId?: string
  /** Depth in the delegation chain (0 = root delegation). */
  depth: number
  /** When the token was issued. */
  issuedAt: Date
  /** When the token expires. */
  expiresAt: Date
  /** HMAC-SHA256 signature (base64url-encoded). */
  signature: string
}

// ---------------------------------------------------------------------------
// Delegation Chain
// ---------------------------------------------------------------------------

/** A validated delegation chain from root to leaf. */
export interface DelegationChain {
  /** Ordered tokens from root (index 0) to leaf. */
  tokens: DelegationToken[]
  /** Intersection of all token scopes in the chain. */
  effectiveScope: string[]
  /** Whether the entire chain is valid. */
  valid: boolean
  /** Reason the chain is invalid, if applicable. */
  invalidReason?: string
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Persistent store for delegation tokens. */
export interface DelegationTokenStore {
  /** Save a new token. */
  save(token: DelegationToken): Promise<void>
  /** Retrieve a token by ID. */
  get(tokenId: string): Promise<DelegationToken | undefined>
  /** Retrieve all tokens delegated to a given identity URI. */
  getByDelegatee(delegateeUri: string): Promise<DelegationToken[]>
  /** Revoke a token by ID. */
  revoke(tokenId: string): Promise<void>
  /** Check if a token has been revoked. */
  isRevoked(tokenId: string): Promise<boolean>
}
