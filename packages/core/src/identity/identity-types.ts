/**
 * ForgeAgent identity types.
 *
 * Defines the core identity primitives used across the ForgeAgent ecosystem:
 * agents, credentials, capabilities, and lightweight identity references.
 */

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

/** Supported credential types for agent authentication. */
export type CredentialType =
  | 'api-key'
  | 'oauth2'
  | 'did-vc'
  | 'mtls'
  | 'delegation'
  | 'custom'

/** An authentication credential attached to an agent identity. */
export interface ForgeCredential {
  type: CredentialType
  issuedAt: Date
  expiresAt?: Date
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

/**
 * A single capability an agent declares.
 *
 * Names use dot-separated segments (e.g. `code.review.security`).
 * Hyphens are allowed within segments (`code-gen.typescript`).
 */
export interface ForgeCapability {
  /** Dot-separated capability name, e.g. `code.review.security`. */
  name: string
  /** Semver version of this capability. */
  version: string
  /** Human-readable description (required for registry discoverability). */
  description: string
  /** Optional JSON-Schema-like input schema. */
  inputSchema?: Record<string, unknown>
  /** Optional JSON-Schema-like output schema. */
  outputSchema?: Record<string, unknown>
  /** Searchable tags for capability discovery. */
  tags?: string[]
  /** Optional SLA constraints. */
  sla?: { maxLatencyMs?: number; maxCostCents?: number }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Full agent identity record. */
export interface ForgeIdentity {
  /** Unique identity ID (opaque string, typically a UUID). */
  id: string
  /** Canonical URI, e.g. `forge://acme/code-reviewer`. */
  uri: string
  /** Human-readable display name. */
  displayName: string
  /** Optional longer description of the agent. */
  description?: string
  /** Organization that owns this agent. */
  organization: string
  /** Capabilities this agent declares. */
  capabilities: ForgeCapability[]
  /** Credentials attached to this identity. */
  credentials: ForgeCredential[]
  /** Arbitrary metadata. */
  metadata?: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// Identity Reference (lightweight)
// ---------------------------------------------------------------------------

/** Lightweight reference to an identity (for embedding in messages, logs, etc.). */
export interface ForgeIdentityRef {
  id: string
  uri: string
  displayName: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a lightweight reference from a full identity. */
export function toIdentityRef(identity: ForgeIdentity): ForgeIdentityRef {
  return {
    id: identity.id,
    uri: identity.uri,
    displayName: identity.displayName,
  }
}
