# 01 — Identity & Trust Layer

> **Created:** 2026-03-24
> **Status:** Planning
> **Package:** `@dzipagent/core/src/identity/` (interfaces + API-key impl), `@dzipagent/server` (middleware integration)
> **Parent:** [00-INDEX.md](./00-INDEX.md) | [AGENT_ECOSYSTEM_SUGGESTIONS.md](/docs/AGENT_ECOSYSTEM_SUGGESTIONS.md) Section 3.1, Section 4.1
> **Features:** F1-F10 (A1-A10 in ecosystem catalog)
> **Effort:** ~76h total across P0/P1/P2

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Feature Specifications](#2-feature-specifications)
   - [F1: ForgeIdentity Type System (P0)](#f1-forgeidentity-type-system-p0-4h)
   - [F2: Agent URI Scheme (P0)](#f2-agent-uri-scheme-p0-2h)
   - [F3: API-Key Identity Resolver (P0)](#f3-api-key-identity-resolver-p0-4h)
   - [F4: Delegation Token System (P1)](#f4-delegation-token-system-p1-8h)
   - [F5: Capability-Based Authorization (P1)](#f5-capability-based-authorization-p1-6h)
   - [F6: Agent Card Signing (P1)](#f6-agent-card-signing-p1-4h)
   - [F7: DID Identity Resolver (P2)](#f7-did-identity-resolver-p2-12h)
   - [F8: Verifiable Credentials (P2)](#f8-verifiable-credentials-p2-16h)
   - [F9: OIDC-A Integration (P2)](#f9-oidc-a-integration-p2-12h)
   - [F10: Trust Scoring (P2)](#f10-trust-scoring-p2-8h)
3. [Data Flow Diagrams](#3-data-flow-diagrams)
4. [File Structure](#4-file-structure)
5. [Migration Strategy](#5-migration-strategy)
6. [Testing Strategy](#6-testing-strategy)
7. [Dependencies](#7-dependencies)

---

## 1. Architecture Overview

### 1.1 Problem Statement

DzipAgent currently identifies agents by opaque string IDs and authenticates HTTP requests via API key bearer tokens with role-based access control (admin/operator/viewer/agent). This works for single-tenant deployments where all agents are trusted peers, but breaks down when:

- Agents from different organizations need to collaborate (no cross-org trust)
- Agent A delegates a task to Agent B on behalf of User C (no delegation chain)
- An agent's capabilities need cryptographic verification (no signed credentials)
- Inter-agent calls need fine-grained authorization beyond RBAC roles (no capability checks)
- Audit trails need to attribute actions to specific agents in a chain (no identity propagation)

The Identity & Trust layer introduces a unified `ForgeIdentity` model that works across all communication protocols (internal, MCP, A2A) and supports progressive adoption from simple API keys to full W3C DID/VC verification.

### 1.2 Design Principles

1. **Progressive complexity** -- API keys work out of the box; DIDs/VCs are opt-in for enterprise
2. **Interface in core, implementation pluggable** -- `IdentityResolver` is abstract; concrete resolvers live alongside their dependencies
3. **Identity propagates, not authenticates** -- Once resolved at the HTTP boundary, `ForgeIdentity` flows through hooks, events, and sub-agent spawns without re-authentication
4. **Non-breaking** -- Existing `authMiddleware` + `rbacMiddleware` continue to work unchanged; identity is an additive layer
5. **Credential-type agnostic** -- The same `ForgeIdentity` can hold API key metadata, OAuth tokens, DID documents, or custom credentials

### 1.3 Identity Resolution Flow

```
                         Incoming Request
                               |
                               v
                    +---------------------+
                    |   authMiddleware()   |  <-- existing, unchanged
                    | Extract Bearer token |
                    | Validate API key     |
                    | Set c.apiKey context |
                    +---------------------+
                               |
                               v
                    +---------------------+
                    | identityMiddleware() |  <-- NEW
                    | Call resolver.resolve|
                    |   with token/headers |
                    | Set c.forgeIdentity  |
                    | Set c.forgeCapabilities
                    +---------------------+
                               |
                               v
                    +---------------------+
                    |  rbacMiddleware()    |  <-- existing, enhanced
                    | Extract role from    |
                    |   identity OR header |
                    | Check permissions    |
                    +---------------------+
                               |
                               v
                    +---------------------+
                    | capabilityGuard()    |  <-- NEW (optional)
                    | Check if identity    |
                    |   has required       |
                    |   capability for     |
                    |   this operation     |
                    +---------------------+
                               |
                               v
                    +---------------------+
                    |   Route Handler      |
                    | Access identity via  |
                    |   getForgeIdentity(c)|
                    +---------------------+
```

### 1.4 Identity Propagation Through Agent Chains

When DzipAgent spawns sub-agents or makes A2A calls, identity must propagate so that every action in the chain is attributable.

```
  User Request (API Key: user-abc-123)
        |
        v
  +-------------------+
  | Primary Agent     |  identity: forge://acme/planner@1.0
  | (resolved from    |  delegator: null (root caller)
  |  API key)         |  role: operator
  +-------------------+
        |
        | spawnSubAgent()
        | DelegationToken { delegator: planner, delegatee: coder, scope: ["code.*"] }
        v
  +-------------------+
  | Sub-Agent (coder) |  identity: forge://acme/coder@1.0
  |                   |  delegator: forge://acme/planner@1.0
  |                   |  scope: ["code.generate", "code.review"]
  +-------------------+
        |
        | A2A call (external)
        | DelegationToken chained: planner -> coder -> external-reviewer
        v
  +-------------------+
  | External Agent    |  identity: forge://partner/reviewer@2.1
  | (A2A)             |  delegation chain: [planner, coder]
  |                   |  scope: ["code.review"] (intersection)
  +-------------------+
```

### 1.5 Relationship to Existing Auth

The identity layer sits **on top of** existing auth, not replacing it:

| Layer | Component | Location | Responsibility |
|-------|-----------|----------|---------------|
| Transport auth | `authMiddleware` | `@dzipagent/server` | Validates bearer token, rejects unauthenticated requests |
| Identity resolution | `identityMiddleware` | `@dzipagent/server` | Maps validated token to `ForgeIdentity` with capabilities |
| Role authorization | `rbacMiddleware` | `@dzipagent/server` | Checks role-based permissions (backward compatible) |
| Capability authorization | `capabilityGuard` | `@dzipagent/server` | Checks fine-grained capability permissions (new, optional) |
| Delegation | `DelegationToken` | `@dzipagent/core` | Scoped, time-limited, chainable trust delegation |
| Trust scoring | `TrustScorer` | `@dzipagent/core` | Reputation based on task history (async, non-blocking) |

---

## 2. Feature Specifications

### F1: ForgeIdentity Type System (P0, 4h)

**Package:** `@dzipagent/core/src/identity/`

This is the foundation type system that all other identity features build on. Every agent, whether local or remote, API-key-authenticated or DID-verified, gets represented as a `ForgeIdentity`.

#### Core Interfaces

```typescript
// --- @dzipagent/core/src/identity/identity-types.ts ---

import type { JSONSchema7 } from 'json-schema'

/**
 * Credential type discriminator.
 *
 * - `api-key`  -- simple shared secret (current system)
 * - `oauth2`   -- OAuth2/OIDC bearer token
 * - `did-vc`   -- W3C DID with Verifiable Credentials
 * - `mtls`     -- mutual TLS client certificate
 * - `delegation` -- DzipAgent delegation token (see F4)
 * - `custom`   -- user-provided credential type
 */
export type CredentialType =
  | 'api-key'
  | 'oauth2'
  | 'did-vc'
  | 'mtls'
  | 'delegation'
  | 'custom'

/**
 * A credential proving an agent's identity or authorization.
 *
 * The `proof` field is credential-type-specific:
 * - api-key: `{ keyHash: string; prefix: string }`
 * - oauth2: `{ accessToken: string; tokenType: string; scopes: string[] }`
 * - did-vc: `{ verifiableCredential: object }`
 * - delegation: `{ delegationToken: DelegationToken }`
 */
export interface ForgeCredential {
  /** Credential type discriminator */
  readonly type: CredentialType
  /** Who issued this credential (URI or name) */
  readonly issuer: string
  /** When the credential was issued */
  readonly issuedAt: Date
  /** When the credential expires (undefined = never) */
  readonly expiresAt?: Date
  /** Whether this credential has been revoked */
  readonly revoked: boolean
  /** Type-specific cryptographic proof or token data */
  readonly proof: Record<string, unknown>
}

/**
 * A capability an agent can perform, with optional SLA guarantees.
 *
 * Capabilities use a hierarchical dot-separated taxonomy:
 *   "code.generate", "code.review.security", "data.sql.generate"
 *
 * @example
 * ```ts
 * const capability: ForgeCapability = {
 *   name: 'code.generate.typescript',
 *   version: '1.0.0',
 *   description: 'Generate TypeScript code from natural language',
 *   inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
 *   outputSchema: { type: 'object', properties: { code: { type: 'string' } } },
 *   sla: { maxLatencyMs: 30_000, maxCostCents: 50 },
 * }
 * ```
 */
export interface ForgeCapability {
  /** Hierarchical capability name (dot-separated taxonomy) */
  readonly name: string
  /** Semver version of this capability */
  readonly version: string
  /** Human-readable description */
  readonly description?: string
  /** JSON Schema for capability input */
  readonly inputSchema: JSONSchema7
  /** JSON Schema for capability output (optional) */
  readonly outputSchema?: JSONSchema7
  /** Service-level agreement for this capability */
  readonly sla?: {
    /** Maximum expected latency in milliseconds */
    readonly maxLatencyMs: number
    /** Maximum expected cost in cents per invocation */
    readonly maxCostCents: number
  }
}

/**
 * The universal agent identity type.
 *
 * Every agent in the DzipAgent ecosystem -- whether local, remote,
 * API-key-authenticated, or DID-verified -- is represented as a ForgeIdentity.
 *
 * ForgeIdentity is immutable once resolved. To update capabilities or
 * credentials, resolve a new identity.
 *
 * @example
 * ```ts
 * const identity: ForgeIdentity = {
 *   id: 'agent_abc123',
 *   uri: 'forge://acme/code-reviewer@1.2.0',
 *   displayName: 'Acme Code Reviewer',
 *   organization: 'acme',
 *   capabilities: [codeReviewCap],
 *   credentials: [apiKeyCred],
 *   roles: ['agent'],
 *   trustScore: 0.95,
 *   metadata: { region: 'us-east-1' },
 *   resolvedAt: new Date(),
 * }
 * ```
 */
export interface ForgeIdentity {
  /** Unique agent identifier (opaque string, immutable) */
  readonly id: string
  /** Forge URI: forge://org/agent-name@version */
  readonly uri: string
  /** Human-readable display name */
  readonly displayName: string
  /** Organization or tenant that owns this agent */
  readonly organization?: string
  /** Capabilities this agent can perform */
  readonly capabilities: readonly ForgeCapability[]
  /** Credentials proving this agent's identity */
  readonly credentials: readonly ForgeCredential[]
  /** RBAC roles (backward compat with existing rbacMiddleware) */
  readonly roles: readonly string[]
  /** Trust score: 0.0 (untrusted) to 1.0 (fully trusted). See F10. */
  readonly trustScore?: number
  /** Arbitrary metadata (region, team, tags, etc.) */
  readonly metadata: Readonly<Record<string, unknown>>
  /** When this identity was resolved (for cache invalidation) */
  readonly resolvedAt: Date
}

/**
 * Minimal identity for contexts where full resolution is unnecessary
 * (e.g., event payloads, log entries).
 */
export interface ForgeIdentityRef {
  readonly id: string
  readonly uri: string
  readonly displayName: string
}

/**
 * Extract a lightweight reference from a full identity.
 */
export function toIdentityRef(identity: ForgeIdentity): ForgeIdentityRef {
  return {
    id: identity.id,
    uri: identity.uri,
    displayName: identity.displayName,
  }
}
```

#### Zod Schemas

```typescript
// --- @dzipagent/core/src/identity/identity-schemas.ts ---

import { z } from 'zod'

export const CredentialTypeSchema = z.enum([
  'api-key',
  'oauth2',
  'did-vc',
  'mtls',
  'delegation',
  'custom',
])

export const ForgeCredentialSchema = z.object({
  type: CredentialTypeSchema,
  issuer: z.string().min(1),
  issuedAt: z.coerce.date(),
  expiresAt: z.coerce.date().optional(),
  revoked: z.boolean().default(false),
  proof: z.record(z.unknown()),
})

export const ForgeCapabilitySchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(
      /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/,
      'Capability names must be dot-separated lowercase identifiers (e.g., "code.review.security")',
    ),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, 'Version must be semver (e.g., "1.0.0")'),
  description: z.string().optional(),
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()).optional(),
  sla: z
    .object({
      maxLatencyMs: z.number().int().positive(),
      maxCostCents: z.number().nonneg(),
    })
    .optional(),
})

/**
 * Forge URI schema.
 * Format: forge://org/agent-name@version
 * The @version segment is optional.
 */
export const ForgeUriSchema = z
  .string()
  .regex(
    /^forge:\/\/[a-z0-9_-]+\/[a-z0-9_-]+(@\d+\.\d+\.\d+)?$/,
    'URI must match forge://org/agent-name or forge://org/agent-name@1.0.0',
  )

export const ForgeIdentitySchema = z.object({
  id: z.string().min(1),
  uri: ForgeUriSchema,
  displayName: z.string().min(1),
  organization: z.string().optional(),
  capabilities: z.array(ForgeCapabilitySchema).default([]),
  credentials: z.array(ForgeCredentialSchema).default([]),
  roles: z.array(z.string()).default([]),
  trustScore: z.number().min(0).max(1).optional(),
  metadata: z.record(z.unknown()).default({}),
  resolvedAt: z.coerce.date(),
})

export const ForgeIdentityRefSchema = z.object({
  id: z.string().min(1),
  uri: ForgeUriSchema,
  displayName: z.string().min(1),
})
```

#### Identity Resolver Interface

```typescript
// --- @dzipagent/core/src/identity/identity-resolver.ts ---

import type { ForgeIdentity } from './identity-types.js'

/**
 * Context available to identity resolvers during resolution.
 */
export interface IdentityResolutionContext {
  /** Raw token or credential string extracted from the request */
  readonly token: string
  /** HTTP headers from the incoming request (for multi-source resolution) */
  readonly headers?: Readonly<Record<string, string>>
  /** Tenant ID if already extracted by tenant-scope middleware */
  readonly tenantId?: string
  /** Protocol that initiated the request */
  readonly protocol?: 'http' | 'ws' | 'mcp' | 'a2a' | 'internal'
}

/**
 * Abstract identity resolver. Implementations map credentials to ForgeIdentity.
 *
 * Resolvers are tried in order until one returns a non-null identity.
 * This supports layered resolution: API key -> OAuth -> DID.
 *
 * @example
 * ```ts
 * class APIKeyIdentityResolver implements IdentityResolver {
 *   readonly type = 'api-key'
 *
 *   async resolve(ctx: IdentityResolutionContext): Promise<ForgeIdentity | null> {
 *     const keyRecord = await this.keyStore.lookup(ctx.token)
 *     if (!keyRecord) return null
 *     return mapKeyToIdentity(keyRecord)
 *   }
 *
 *   async verify(identity: ForgeIdentity): Promise<boolean> {
 *     return identity.credentials.some(
 *       c => c.type === 'api-key' && !c.revoked && (!c.expiresAt || c.expiresAt > new Date())
 *     )
 *   }
 * }
 * ```
 */
export interface IdentityResolver {
  /** Which credential type this resolver handles */
  readonly type: string

  /**
   * Resolve a token/credential to a ForgeIdentity.
   * Returns null if this resolver cannot handle the provided credentials.
   */
  resolve(ctx: IdentityResolutionContext): Promise<ForgeIdentity | null>

  /**
   * Verify that an existing identity is still valid.
   * Used for cached identities and delegation chain validation.
   */
  verify(identity: ForgeIdentity): Promise<boolean>
}

/**
 * Composite resolver that tries multiple resolvers in order.
 * First non-null result wins. If all return null, resolution fails.
 */
export interface CompositeIdentityResolver extends IdentityResolver {
  /** Add a resolver to the chain */
  addResolver(resolver: IdentityResolver): void
  /** Remove a resolver by type */
  removeResolver(type: string): boolean
  /** List registered resolver types */
  resolverTypes(): readonly string[]
}
```

#### Identity Event Extensions

The following events are added to the `DzipEvent` discriminated union:

```typescript
// Added to @dzipagent/core/src/events/event-types.ts

// --- Identity events ---
| { type: 'identity:resolved'; agentId: string; uri: string; resolverType: string }
| { type: 'identity:verification_failed'; agentId: string; uri: string; reason: string }
| { type: 'identity:delegation_created'; delegator: string; delegatee: string; scope: string[] }
| { type: 'identity:delegation_expired'; delegator: string; delegatee: string }
| { type: 'identity:trust_updated'; agentId: string; uri: string; oldScore: number; newScore: number }
```

#### Error Code Extensions

```typescript
// Added to @dzipagent/core/src/errors/error-codes.ts

// --- Identity errors ---
| 'IDENTITY_RESOLUTION_FAILED'
| 'IDENTITY_VERIFICATION_FAILED'
| 'IDENTITY_EXPIRED'
| 'DELEGATION_INVALID'
| 'DELEGATION_EXPIRED'
| 'DELEGATION_DEPTH_EXCEEDED'
| 'DELEGATION_SCOPE_VIOLATION'
| 'CAPABILITY_DENIED'
| 'TRUST_SCORE_TOO_LOW'
```

---

### F2: Agent URI Scheme (P0, 2h)

**Package:** `@dzipagent/core/src/identity/`

A URI scheme for uniquely identifying agents across organizations and versions. Compatible with the emerging `agent://` URI scheme from research, but uses the `forge://` prefix to avoid conflict before `agent://` is standardized.

#### URI Format

```
forge://org/agent-name@version
  |       |     |          |
  |       |     |          +-- Optional semver (e.g., 1.0.0)
  |       |     +------------- Agent name (lowercase, hyphens allowed)
  |       +-------------------- Organization/tenant (lowercase, hyphens/underscores)
  +---------------------------- Scheme identifier
```

**Examples:**
- `forge://acme/code-reviewer@1.2.0` -- specific version
- `forge://acme/code-reviewer` -- latest version (resolver decides)
- `forge://local/planner@1.0.0` -- local-only agent (no remote resolution)

#### Parser and Builder

```typescript
// --- @dzipagent/core/src/identity/forge-uri.ts ---

/**
 * Parsed components of a forge:// URI.
 */
export interface ForgeUriComponents {
  /** Full URI string */
  readonly uri: string
  /** Organization or tenant identifier */
  readonly organization: string
  /** Agent name */
  readonly agentName: string
  /** Semver version (undefined if not specified) */
  readonly version?: string
}

/**
 * Parse a forge:// URI into its components.
 *
 * @throws ForgeError with code INVALID_CONFIG if the URI is malformed
 *
 * @example
 * ```ts
 * const parts = parseForgeUri('forge://acme/code-reviewer@1.2.0')
 * // { uri: 'forge://acme/code-reviewer@1.2.0', organization: 'acme',
 * //   agentName: 'code-reviewer', version: '1.2.0' }
 * ```
 */
export function parseForgeUri(uri: string): ForgeUriComponents { /* ... */ }

/**
 * Build a forge:// URI from components.
 *
 * @example
 * ```ts
 * buildForgeUri({ organization: 'acme', agentName: 'code-reviewer', version: '1.2.0' })
 * // 'forge://acme/code-reviewer@1.2.0'
 *
 * buildForgeUri({ organization: 'acme', agentName: 'planner' })
 * // 'forge://acme/planner'
 * ```
 */
export function buildForgeUri(parts: {
  organization: string
  agentName: string
  version?: string
}): string { /* ... */ }

/**
 * Check if a string is a valid forge:// URI.
 * Does not throw -- returns boolean.
 */
export function isForgeUri(value: string): boolean { /* ... */ }

/**
 * Convert a forge:// URI to an agent:// URI (emerging standard).
 *
 * forge://acme/code-reviewer@1.2.0 -> agent://acme/code-reviewer@1.2.0
 *
 * Useful for interoperability with systems that adopt the agent:// scheme.
 */
export function toAgentUri(forgeUri: string): string { /* ... */ }

/**
 * Convert an agent:// URI to a forge:// URI.
 */
export function fromAgentUri(agentUri: string): string { /* ... */ }

/**
 * Resolve a forge:// URI to an HTTP endpoint URL.
 *
 * Uses a configurable resolution strategy:
 * - registry: look up in AgentRegistry (when available, see 03-DISCOVERY)
 * - convention: derive from org domain (e.g., forge://acme/X -> https://agents.acme.com/X)
 * - static: use a provided map
 *
 * @example
 * ```ts
 * const resolver = createUriResolver({
 *   strategy: 'static',
 *   map: {
 *     'forge://acme/code-reviewer': 'https://code-reviewer.acme.internal:4000',
 *   },
 * })
 *
 * await resolver.resolve('forge://acme/code-reviewer@1.2.0')
 * // 'https://code-reviewer.acme.internal:4000'
 * ```
 */
export interface UriResolver {
  resolve(uri: string): Promise<string | null>
}

export interface UriResolverConfig {
  strategy: 'registry' | 'convention' | 'static'
  /** Domain pattern for convention strategy. Default: 'https://agents.{org}.com/{name}' */
  conventionPattern?: string
  /** Static URI-to-URL map */
  map?: Record<string, string>
}

export function createUriResolver(config: UriResolverConfig): UriResolver { /* ... */ }
```

---

### F3: API-Key Identity Resolver (P0, 4h)

**Package:** `@dzipagent/core/src/identity/` (resolver), `@dzipagent/server/src/middleware/` (middleware)

The first concrete `IdentityResolver` implementation. It wraps the existing API key validation and enriches the result with `ForgeIdentity` data. This makes the transition from pure API-key auth to identity-aware auth seamless.

#### Resolver Implementation

```typescript
// --- @dzipagent/core/src/identity/api-key-resolver.ts ---

import type { ForgeIdentity, ForgeCredential, ForgeCapability } from './identity-types.js'
import type { IdentityResolver, IdentityResolutionContext } from './identity-resolver.js'

/**
 * Record returned by the key lookup function.
 * This is what the consumer's key store returns when validating a key.
 */
export interface APIKeyRecord {
  /** The key's unique ID (not the key itself) */
  keyId: string
  /** Agent ID this key authenticates */
  agentId: string
  /** Agent display name */
  agentName: string
  /** Organization/tenant this key belongs to */
  organization: string
  /** RBAC roles assigned to this key */
  roles: string[]
  /** Capabilities this key grants (if empty, inherits from agent definition) */
  capabilities?: ForgeCapability[]
  /** Arbitrary metadata stored with the key */
  metadata?: Record<string, unknown>
  /** When the key was created */
  createdAt: Date
  /** When the key expires (undefined = never) */
  expiresAt?: Date
}

export interface APIKeyResolverConfig {
  /**
   * Look up an API key and return its record, or null if invalid.
   * This is the same function signature as `AuthConfig.validateKey`
   * but with a typed return.
   */
  lookupKey: (key: string) => Promise<APIKeyRecord | null>

  /**
   * Default Forge URI template for agents without explicit URIs.
   * Default: 'forge://{organization}/{agentName}'
   */
  uriTemplate?: string

  /**
   * Cache resolved identities for this many milliseconds.
   * Default: 300_000 (5 minutes). Set to 0 to disable caching.
   */
  cacheTtlMs?: number

  /**
   * Maximum cache entries. Default: 1000.
   * Uses LRU eviction when exceeded.
   */
  cacheMaxEntries?: number
}

/**
 * Resolves API keys to ForgeIdentity using a pluggable key lookup.
 *
 * Caches resolved identities to avoid repeated DB lookups for
 * the same key within the TTL window.
 *
 * @example
 * ```ts
 * const resolver = createAPIKeyResolver({
 *   lookupKey: async (key) => {
 *     const row = await db.apiKeys.findByHash(hashKey(key))
 *     if (!row) return null
 *     return {
 *       keyId: row.id,
 *       agentId: row.agentId,
 *       agentName: row.agentName,
 *       organization: row.tenantId,
 *       roles: row.roles,
 *       createdAt: row.createdAt,
 *       expiresAt: row.expiresAt,
 *     }
 *   },
 *   cacheTtlMs: 60_000,
 * })
 * ```
 */
export function createAPIKeyResolver(
  config: APIKeyResolverConfig,
): IdentityResolver { /* ... */ }
```

#### Identity Middleware for Hono

```typescript
// --- @dzipagent/server/src/middleware/identity.ts ---

import type { MiddlewareHandler } from 'hono'
import type { IdentityResolver, ForgeIdentity } from '@dzipagent/core'

export interface IdentityMiddlewareConfig {
  /** Identity resolver(s) to use. Tried in order; first non-null wins. */
  resolvers: IdentityResolver[]

  /**
   * If true, requests that fail identity resolution are rejected with 401.
   * If false, requests continue without identity (identity is undefined in context).
   * Default: false (non-breaking -- existing auth still gates access).
   */
  required?: boolean

  /**
   * Protocol identifier for the resolution context.
   * Default: 'http'
   */
  protocol?: 'http' | 'ws' | 'mcp' | 'a2a'
}

/**
 * Hono middleware that resolves the authenticated request to a ForgeIdentity.
 *
 * Must be placed AFTER authMiddleware (which validates the token)
 * and BEFORE rbacMiddleware or any route handlers.
 *
 * Sets the following Hono context variables:
 * - `forgeIdentity`: ForgeIdentity | undefined
 * - `forgeCapabilities`: readonly ForgeCapability[]
 *
 * @example
 * ```ts
 * // In createForgeApp:
 * app.use('/api/*', authMiddleware(authConfig))
 * app.use('/api/*', identityMiddleware({
 *   resolvers: [apiKeyResolver],
 *   required: false,  // graceful -- existing auth still works
 * }))
 * app.use('/api/*', rbacMiddleware(rbacConfig))
 * ```
 */
export function identityMiddleware(
  config: IdentityMiddlewareConfig,
): MiddlewareHandler { /* ... */ }

/**
 * Extract the resolved ForgeIdentity from Hono context.
 * Returns undefined if identity middleware has not run or resolution failed.
 */
export function getForgeIdentity(c: {
  get: (key: string) => unknown
}): ForgeIdentity | undefined { /* ... */ }
```

#### Integration with Existing authMiddleware

The existing `authMiddleware` in `@dzipagent/server/src/middleware/auth.ts` remains unchanged. The new `identityMiddleware` reads the `apiKey` context variable that `authMiddleware` sets and uses it as input to the resolver chain.

For consumers who want the simplest upgrade path:

```typescript
// Before (current):
app.use('/api/*', authMiddleware({ mode: 'api-key', validateKey }))
app.use('/api/*', rbacMiddleware({ extractRole }))

// After (with identity):
app.use('/api/*', authMiddleware({ mode: 'api-key', validateKey }))
app.use('/api/*', identityMiddleware({ resolvers: [apiKeyResolver] }))
app.use('/api/*', rbacMiddleware({
  extractRole: (c) => {
    // Prefer identity roles, fall back to header
    const identity = getForgeIdentity(c)
    return identity?.roles[0] as ForgeRole ?? extractRoleFromHeader(c)
  },
}))
```

#### Caching Strategy

The API-key resolver caches resolved identities using an LRU map keyed by the SHA-256 hash of the API key (never the raw key). Cache entries have:

- **TTL**: configurable, default 5 minutes
- **Max entries**: configurable, default 1000
- **Eviction**: LRU when max entries exceeded
- **Invalidation**: manual `invalidate(keyHash)` method for key revocation
- **No external dependency**: uses an in-process `Map` with a doubly-linked list for LRU ordering

---

### F4: Delegation Token System (P1, 8h)

**Package:** `@dzipagent/core/src/identity/`

When Agent A spawns Agent B and wants B to act with a subset of A's authority, A issues a `DelegationToken`. This enables auditable chains of trust without giving B full access to A's credentials.

#### Token Types

```typescript
// --- @dzipagent/core/src/identity/delegation-types.ts ---

/**
 * Constraints limiting what a delegatee can do.
 */
export interface DelegationConstraint {
  /** Type of constraint */
  readonly type: 'max-cost' | 'max-tokens' | 'max-iterations' | 'allowed-tools' | 'time-window'
  /** Constraint-specific value */
  readonly value: unknown
}

/** Specific constraint types for type safety */
export interface MaxCostConstraint extends DelegationConstraint {
  readonly type: 'max-cost'
  readonly value: { maxCents: number }
}

export interface MaxTokensConstraint extends DelegationConstraint {
  readonly type: 'max-tokens'
  readonly value: { maxTokens: number }
}

export interface MaxIterationsConstraint extends DelegationConstraint {
  readonly type: 'max-iterations'
  readonly value: { maxIterations: number }
}

export interface AllowedToolsConstraint extends DelegationConstraint {
  readonly type: 'allowed-tools'
  readonly value: { tools: string[] }
}

export interface TimeWindowConstraint extends DelegationConstraint {
  readonly type: 'time-window'
  readonly value: { notBefore: Date; notAfter: Date }
}

/**
 * A delegation token granting scoped authority from one agent to another.
 *
 * Tokens form chains: A -> B -> C. Each link in the chain can only
 * narrow scope, never widen it. The effective scope of C is the
 * intersection of A->B scope and B->C scope.
 *
 * @example
 * ```ts
 * const token: DelegationToken = {
 *   id: 'del_abc123',
 *   delegator: 'forge://acme/planner@1.0',
 *   delegatee: 'forge://acme/coder@1.0',
 *   scope: ['code.generate', 'code.review'],
 *   constraints: [
 *     { type: 'max-cost', value: { maxCents: 100 } },
 *     { type: 'max-iterations', value: { maxIterations: 5 } },
 *   ],
 *   parentTokenId: undefined,  // root delegation
 *   depth: 0,
 *   issuedAt: new Date(),
 *   expiresAt: new Date(Date.now() + 3600_000),
 *   signature: '...',
 * }
 * ```
 */
export interface DelegationToken {
  /** Unique token identifier */
  readonly id: string
  /** URI of the agent granting authority */
  readonly delegator: string
  /** URI of the agent receiving authority */
  readonly delegatee: string
  /** Capability names this delegation grants (subset of delegator's capabilities) */
  readonly scope: readonly string[]
  /** Additional constraints on the delegatee */
  readonly constraints: readonly DelegationConstraint[]
  /** Parent token ID for chain validation (undefined = root delegation) */
  readonly parentTokenId?: string
  /** Depth in the delegation chain (0 = root). Max enforced by DelegationManager. */
  readonly depth: number
  /** When this token was issued */
  readonly issuedAt: Date
  /** When this token expires */
  readonly expiresAt: Date
  /** HMAC-SHA256 signature of the token body, using the delegator's signing key */
  readonly signature: string
}

/**
 * Resolved delegation chain from root to leaf.
 * Used for auditing and scope intersection.
 */
export interface DelegationChain {
  /** Ordered list of tokens from root delegator to final delegatee */
  readonly tokens: readonly DelegationToken[]
  /** Effective scope (intersection of all token scopes in chain) */
  readonly effectiveScope: readonly string[]
  /** Whether all tokens in the chain are valid (not expired, not revoked, signatures OK) */
  readonly valid: boolean
  /** If invalid, the reason */
  readonly invalidReason?: string
}
```

#### Delegation Manager

```typescript
// --- @dzipagent/core/src/identity/delegation-manager.ts ---

import type { DelegationToken, DelegationChain, DelegationConstraint } from './delegation-types.js'

export interface DelegationManagerConfig {
  /**
   * HMAC secret for signing tokens.
   * In production, this should be loaded from a secret manager.
   * Different agents can use different signing keys via the keyResolver.
   */
  signingSecret: string

  /**
   * Optional: resolve signing key per agent URI.
   * If provided, overrides signingSecret for the resolved agent.
   */
  keyResolver?: (agentUri: string) => Promise<string | null>

  /**
   * Maximum allowed delegation depth.
   * A -> B -> C -> D has depth 2 at D (D's token parentTokenId -> C's token).
   * Default: 3
   */
  maxDepth?: number

  /**
   * Token store for persisting and looking up tokens.
   * If not provided, uses in-memory store (tokens lost on restart).
   */
  tokenStore?: DelegationTokenStore
}

export interface DelegationTokenStore {
  save(token: DelegationToken): Promise<void>
  get(id: string): Promise<DelegationToken | null>
  getByDelegatee(delegateeUri: string): Promise<DelegationToken[]>
  revoke(id: string): Promise<void>
  isRevoked(id: string): Promise<boolean>
}

export interface DelegationManager {
  /**
   * Issue a new delegation token.
   *
   * The scope must be a subset of the delegator's current capabilities.
   * If parentTokenId is provided, scope is intersected with parent's scope.
   *
   * @throws ForgeError DELEGATION_DEPTH_EXCEEDED if chain would exceed maxDepth
   * @throws ForgeError DELEGATION_SCOPE_VIOLATION if scope exceeds delegator's authority
   */
  issue(params: {
    delegator: string
    delegatee: string
    scope: string[]
    constraints?: DelegationConstraint[]
    parentTokenId?: string
    ttlMs: number
  }): Promise<DelegationToken>

  /**
   * Verify a single delegation token's signature and expiration.
   * Does not verify the full chain -- use validateChain for that.
   */
  verify(token: DelegationToken): Promise<boolean>

  /**
   * Resolve and validate the full delegation chain from a leaf token.
   * Walks parentTokenId links back to the root, verifying each token.
   */
  validateChain(tokenId: string): Promise<DelegationChain>

  /**
   * Revoke a delegation token. Also revokes all child tokens in the chain.
   */
  revoke(tokenId: string): Promise<void>

  /**
   * Check if a specific capability is within the effective scope of a delegation chain.
   */
  hasCapabilityInChain(tokenId: string, capabilityName: string): Promise<boolean>
}

export function createDelegationManager(
  config: DelegationManagerConfig,
): DelegationManager { /* ... */ }
```

#### Signing and Verification

Tokens are signed using HMAC-SHA256 over the canonicalized token body (all fields except `signature`, JSON-serialized with keys sorted alphabetically).

```typescript
// Signing pseudocode:
const body = canonicalize({ id, delegator, delegatee, scope, constraints, parentTokenId, depth, issuedAt, expiresAt })
const signature = hmacSHA256(signingSecret, body).toString('base64url')

// Verification pseudocode:
const expected = hmacSHA256(signingSecret, canonicalize(tokenWithoutSignature))
return timingSafeEqual(expected, Buffer.from(token.signature, 'base64url'))
```

**Why HMAC-SHA256 and not asymmetric (Ed25519)?** HMAC is simpler for internal delegations where both parties share a signing secret (or the server holds it). F6 (Agent Card Signing) uses Ed25519 for external verification where the verifier does not have the private key. P2 features (DID/VC) also use asymmetric cryptography.

#### Integration with ForgeMessage Envelope

When an agent makes an inter-agent call (A2A or internal), the delegation token is attached to the `ForgeMessage.metadata.delegationToken` field (defined in `02-COMMUNICATION-PROTOCOLS.md`). The receiving agent validates the chain before processing.

#### Integration with Sub-Agent Spawning

The `SubAgentConfig` type (in `@dzipagent/core/src/subagent/subagent-types.ts`) gains an optional `delegationToken` field:

```typescript
// Extension to SubAgentConfig:
export interface SubAgentConfig {
  // ... existing fields ...

  /** Delegation token granting this sub-agent scoped authority from the parent */
  delegationToken?: DelegationToken
}
```

The sub-agent spawner (`subagent-spawner.ts`) automatically issues a delegation token if the parent has an identity and the child does not already have one.

---

### F5: Capability-Based Authorization (P1, 6h)

**Package:** `@dzipagent/core/src/identity/` (checker), `@dzipagent/server/src/middleware/` (guard)

Transition from pure RBAC to capability-based authorization. Instead of "does this role have permission to POST /runs?", the question becomes "does this agent have the `runs.create` capability?".

#### Capability Checker Interface

```typescript
// --- @dzipagent/core/src/identity/capability-checker.ts ---

import type { ForgeIdentity } from './identity-types.js'
import type { DelegationChain } from './delegation-types.js'

/**
 * Result of a capability check.
 */
export interface CapabilityCheckResult {
  /** Whether the capability is granted */
  readonly allowed: boolean
  /** Human-readable reason for the decision */
  readonly reason: string
  /** Which credential/delegation granted the capability (for auditing) */
  readonly grantedBy?: string
  /** The specific capability that matched (may differ from requested if wildcard) */
  readonly matchedCapability?: string
}

/**
 * Checks whether an identity has a specific capability.
 *
 * Resolution order:
 * 1. Check delegation chain effective scope (if delegation token present)
 * 2. Check identity's direct capabilities
 * 3. Fall back to RBAC role mapping (backward compatibility)
 *
 * Wildcard matching: "code.*" matches "code.generate", "code.review", etc.
 */
export interface CapabilityChecker {
  /**
   * Check if an identity has a specific capability.
   *
   * @param identity - The agent's resolved identity
   * @param capability - Capability name to check (e.g., "code.review")
   * @param delegationChain - Optional delegation chain (restricts scope)
   */
  check(
    identity: ForgeIdentity,
    capability: string,
    delegationChain?: DelegationChain,
  ): CapabilityCheckResult

  /**
   * Check if an identity has ALL of the specified capabilities.
   */
  checkAll(
    identity: ForgeIdentity,
    capabilities: string[],
    delegationChain?: DelegationChain,
  ): CapabilityCheckResult
}

export interface CapabilityCheckerConfig {
  /**
   * Mapping from RBAC roles to capability patterns.
   * Used as a fallback when identity has no explicit capabilities.
   * Default mapping:
   *   admin -> ["*"]
   *   operator -> ["runs.*", "agents.read", "tools.*", "approvals.*"]
   *   viewer -> ["*.read"]
   *   agent -> ["runs.*", "tools.execute"]
   */
  roleCapabilityMap?: Record<string, string[]>
}

export function createCapabilityChecker(
  config?: CapabilityCheckerConfig,
): CapabilityChecker { /* ... */ }
```

#### Capability Guard Middleware

```typescript
// --- @dzipagent/server/src/middleware/capability-guard.ts ---

import type { MiddlewareHandler } from 'hono'

/**
 * Middleware that checks if the resolved identity has a specific capability.
 *
 * Unlike rbacGuard (which checks roles), capabilityGuard checks the identity's
 * capability list and delegation chain scope.
 *
 * @example
 * ```ts
 * // Protect a route with a capability check:
 * app.post('/api/runs', capabilityGuard('runs.create'), createRunHandler)
 *
 * // Multiple capabilities required:
 * app.post('/api/agents/:id/deploy', capabilityGuard(['agents.update', 'runs.create']), deployHandler)
 * ```
 */
export function capabilityGuard(
  capability: string | string[],
): MiddlewareHandler { /* ... */ }
```

#### Backward Compatibility

The capability system is fully backward compatible with existing RBAC:

1. If an identity has explicit capabilities, those are checked directly
2. If an identity has only roles (the current state), roles are mapped to capabilities via `roleCapabilityMap`
3. If no identity middleware is configured, `capabilityGuard` falls through to `rbacMiddleware` behavior
4. Existing `rbacMiddleware` and `rbacGuard` continue to work unchanged

---

### F6: Agent Card Signing (P1, 4h)

**Package:** `@dzipagent/core/src/identity/` (signing utils), `@dzipagent/server/src/a2a/` (integration)

Agent Cards (served at `/.well-known/agent.json`) gain a cryptographic signature so consumers can verify the card was published by the claimed agent and has not been tampered with.

#### Signing Types

```typescript
// --- @dzipagent/core/src/identity/signing-types.ts ---

/**
 * A key pair for Ed25519 signing.
 */
export interface SigningKeyPair {
  /** Ed25519 public key (Base64URL encoded) */
  readonly publicKey: string
  /** Ed25519 private key (Base64URL encoded). NEVER exposed in Agent Cards. */
  readonly privateKey: string
  /** Key identifier for rotation support */
  readonly keyId: string
  /** When this key was created */
  readonly createdAt: Date
  /** When this key expires (undefined = manual rotation only) */
  readonly expiresAt?: Date
}

/**
 * A signed document with detached signature.
 */
export interface SignedDocument<T> {
  /** The signed payload */
  readonly payload: T
  /** Ed25519 signature of the canonicalized payload (Base64URL) */
  readonly signature: string
  /** Key ID used for signing (for key rotation support) */
  readonly keyId: string
  /** When the signature was created */
  readonly signedAt: Date
}

/**
 * Agent Card extended with signing metadata.
 */
export interface SignedAgentCard extends SignedDocument<import('../../../forgeagent-server/src/a2a/agent-card.js').AgentCard> {
  /** Public key for verifying this card's signature (Base64URL) */
  readonly publicKey: string
}
```

#### Key Management

```typescript
// --- @dzipagent/core/src/identity/key-manager.ts ---

export interface KeyManagerConfig {
  /** Where to store key pairs */
  store: KeyStore
  /** Auto-rotate keys after this many milliseconds. Default: 90 days. */
  rotationIntervalMs?: number
}

export interface KeyStore {
  save(keyPair: SigningKeyPair): Promise<void>
  getCurrent(agentUri: string): Promise<SigningKeyPair | null>
  getByKeyId(keyId: string): Promise<SigningKeyPair | null>
  listActive(agentUri: string): Promise<SigningKeyPair[]>
  revoke(keyId: string): Promise<void>
}

export interface KeyManager {
  /** Generate a new Ed25519 key pair for an agent */
  generate(agentUri: string): Promise<SigningKeyPair>
  /** Get the current active signing key for an agent */
  getCurrentKey(agentUri: string): Promise<SigningKeyPair | null>
  /** Rotate keys: generate new, mark old as expiring */
  rotate(agentUri: string): Promise<SigningKeyPair>
  /** Sign arbitrary data with an agent's current key */
  sign(agentUri: string, data: Uint8Array): Promise<{ signature: string; keyId: string }>
  /** Verify a signature using a public key */
  verify(publicKey: string, data: Uint8Array, signature: string): Promise<boolean>
}

export function createKeyManager(config: KeyManagerConfig): KeyManager { /* ... */ }
```

#### Integration with buildAgentCard

The existing `buildAgentCard` function in `@dzipagent/server/src/a2a/agent-card.ts` gains an optional signing parameter:

```typescript
export interface AgentCardConfig {
  // ... existing fields ...

  /** If provided, the card will be signed with this agent's key */
  signing?: {
    keyManager: KeyManager
    agentUri: string
  }
}

// buildAgentCard returns AgentCard | SignedAgentCard depending on config
```

---

### F7: DID Identity Resolver (P2, 12h)

**Package:** `@dzipagent/core/src/identity/` (or separate `@dzipagent/identity` if the module grows large enough)

Implements the `IdentityResolver` interface for W3C Decentralized Identifiers using the `did:web` method.

#### DID Document Resolution

```typescript
// --- @dzipagent/core/src/identity/did-resolver.ts ---

import type { IdentityResolver, IdentityResolutionContext } from './identity-resolver.js'
import type { ForgeIdentity } from './identity-types.js'

/**
 * W3C DID Document (simplified for DzipAgent use).
 * Full spec: https://www.w3.org/TR/did-core/
 */
export interface DIDDocument {
  readonly '@context': string[]
  readonly id: string
  readonly verificationMethod: VerificationMethod[]
  readonly authentication?: string[]
  readonly service?: DIDService[]
}

export interface VerificationMethod {
  readonly id: string
  readonly type: string
  readonly controller: string
  readonly publicKeyMultibase?: string
  readonly publicKeyJwk?: Record<string, unknown>
}

export interface DIDService {
  readonly id: string
  readonly type: string
  readonly serviceEndpoint: string | Record<string, string>
}

export interface DIDResolverConfig {
  /**
   * HTTP client for fetching DID documents.
   * Default: uses native fetch.
   */
  httpClient?: { fetch(url: string): Promise<Response> }

  /**
   * Cache TTL for resolved DID documents.
   * Default: 3600_000 (1 hour)
   */
  cacheTtlMs?: number

  /**
   * Trusted DID issuers. If provided, only DIDs from these issuers are accepted.
   * If empty, all valid DIDs are accepted.
   */
  trustedIssuers?: string[]
}

/**
 * Resolves did:web identifiers to ForgeIdentity.
 *
 * did:web method: did:web:example.com:agents:code-reviewer
 * resolves to: https://example.com/agents/code-reviewer/did.json
 *
 * The DID Document's service endpoints map to ForgeCapability,
 * and verification methods map to ForgeCredential.
 *
 * @example
 * ```ts
 * const resolver = createDIDResolver({
 *   trustedIssuers: ['did:web:agents.acme.com'],
 *   cacheTtlMs: 1800_000,
 * })
 *
 * const identity = await resolver.resolve({
 *   token: 'did:web:agents.acme.com:code-reviewer',
 *   protocol: 'a2a',
 * })
 * ```
 */
export function createDIDResolver(
  config?: DIDResolverConfig,
): IdentityResolver { /* ... */ }
```

#### Mapping DID to ForgeIdentity

| DID Document Field | ForgeIdentity Field |
|---|---|
| `id` | `id` (the full DID string) |
| DID + service endpoint | `uri` (mapped to forge:// scheme) |
| Service metadata | `capabilities` |
| `verificationMethod` | `credentials` (type: 'did-vc') |
| Controller DID | `organization` (extracted from DID) |

---

### F8: Verifiable Credentials (P2, 16h)

**Package:** `@dzipagent/core/src/identity/`

W3C Verifiable Credentials Data Model 2.0 for cryptographically proving agent capabilities.

#### VC Types

```typescript
// --- @dzipagent/core/src/identity/verifiable-credential-types.ts ---

/**
 * W3C Verifiable Credential for agent capabilities.
 * Spec: https://www.w3.org/TR/vc-data-model-2.0/
 */
export interface VerifiableCredential {
  readonly '@context': string[]
  readonly id: string
  readonly type: string[]
  readonly issuer: string | { id: string; name?: string }
  readonly issuanceDate: string
  readonly expirationDate?: string
  readonly credentialSubject: {
    readonly id: string
    readonly capabilities?: Array<{
      readonly name: string
      readonly version: string
      readonly granted: boolean
    }>
    readonly organization?: string
    readonly trustLevel?: number
  }
  readonly proof: {
    readonly type: string
    readonly created: string
    readonly verificationMethod: string
    readonly proofPurpose: string
    readonly proofValue: string
  }
}

export interface CredentialStatusEntry {
  readonly id: string
  readonly type: 'RevocationList2020Status' | 'StatusList2021Entry'
  readonly statusListIndex: string
  readonly statusListCredential: string
}

export interface VCIssuerConfig {
  /** DID of the issuing authority */
  issuerDid: string
  /** Key manager for signing credentials */
  keyManager: import('./key-manager.js').KeyManager
  /** Base URL for credential status (revocation) checks */
  statusBaseUrl?: string
}

export interface VCVerifierConfig {
  /** Trusted issuer DIDs */
  trustedIssuers: string[]
  /** DID resolver for looking up issuer verification methods */
  didResolver: import('./did-resolver.js').IdentityResolver
  /** Whether to check credential revocation status. Default: true */
  checkRevocation?: boolean
}

export interface VCIssuer {
  issue(params: {
    subjectDid: string
    capabilities: Array<{ name: string; version: string }>
    expirationDate?: Date
  }): Promise<VerifiableCredential>

  revoke(credentialId: string): Promise<void>
}

export interface VCVerifier {
  verify(credential: VerifiableCredential): Promise<{
    valid: boolean
    reason?: string
    issuer?: string
  }>
}

export function createVCIssuer(config: VCIssuerConfig): VCIssuer { /* ... */ }
export function createVCVerifier(config: VCVerifierConfig): VCVerifier { /* ... */ }
```

#### Issuance Flow

```
  Organization Admin
        |
        | POST /api/credentials/issue
        | { subjectDid: "did:web:...", capabilities: [...], ttl: "30d" }
        v
  +-------------------+
  | VCIssuer          |
  | 1. Validate subject DID
  | 2. Build VC payload
  | 3. Sign with issuer key (Ed25519)
  | 4. Store in credential store
  | 5. Return signed VC
  +-------------------+
        |
        v
  Agent receives VC, includes in ForgeCredential.proof
```

#### Verification Flow

```
  Incoming request with VC in credentials
        |
        v
  +-------------------+
  | VCVerifier        |
  | 1. Parse VC JSON-LD context
  | 2. Resolve issuer DID -> public key
  | 3. Verify Ed25519 signature
  | 4. Check expiration date
  | 5. Check revocation status (HTTP)
  | 6. Validate capability claims
  +-------------------+
        |
        v
  CapabilityCheckResult { allowed: true/false }
```

---

### F9: OIDC-A Integration (P2, 12h)

**Package:** `@dzipagent/core/src/identity/`

OpenID Connect for Agents (OIDC-A) extends standard OIDC with agent-specific claims and delegation semantics. This enables DzipAgent to participate in enterprise SSO flows where agents authenticate alongside human users.

```typescript
// --- @dzipagent/core/src/identity/oidc-a-resolver.ts ---

export interface OIDCAConfig {
  /** OIDC issuer URL (e.g., https://auth.example.com) */
  issuerUrl: string
  /** Client ID for this DzipAgent instance */
  clientId: string
  /** Client secret (from secret manager) */
  clientSecret: string
  /** Expected audience in tokens */
  audience: string
  /** JWKS URI for token verification (auto-discovered from issuer if not set) */
  jwksUri?: string
  /** Cache TTL for JWKS keys. Default: 3600_000 */
  jwksCacheTtlMs?: number
}

export interface OIDCATokenClaims {
  /** Standard OIDC claims */
  sub: string
  iss: string
  aud: string | string[]
  exp: number
  iat: number
  /** OIDC-A agent-specific claims */
  agent_id?: string
  agent_uri?: string
  agent_name?: string
  agent_org?: string
  agent_capabilities?: string[]
  /** Delegation claims */
  act?: {
    sub: string
    agent_id?: string
  }
}

/**
 * OIDC-A identity resolver.
 *
 * Validates JWT tokens from an OIDC-A provider and maps claims to ForgeIdentity.
 * Supports the `act` claim for delegation (RFC 8693 token exchange).
 *
 * @example
 * ```ts
 * const resolver = createOIDCAResolver({
 *   issuerUrl: 'https://auth.acme.com',
 *   clientId: 'forgeagent-prod',
 *   clientSecret: process.env.OIDC_CLIENT_SECRET!,
 *   audience: 'https://agents.acme.com',
 * })
 * ```
 */
export function createOIDCAResolver(
  config: OIDCAConfig,
): IdentityResolver { /* ... */ }

/**
 * Token exchange for agent delegation using RFC 8693.
 *
 * Agent A can exchange its token for a new token scoped to Agent B's authority.
 * This is the OIDC-A equivalent of DzipAgent's DelegationToken.
 */
export interface OIDCATokenExchanger {
  exchange(params: {
    subjectToken: string
    targetAgentUri: string
    scope: string[]
  }): Promise<string>
}

export function createOIDCATokenExchanger(
  config: OIDCAConfig,
): OIDCATokenExchanger { /* ... */ }
```

---

### F10: Trust Scoring (P2, 8h)

**Package:** `@dzipagent/core/src/identity/`

Reputation score calculated from an agent's task history. Used for preferring reliable agents in discovery and for gating high-risk operations.

```typescript
// --- @dzipagent/core/src/identity/trust-scorer.ts ---

/**
 * Input signals for trust score calculation.
 */
export interface TrustSignals {
  /** Total tasks completed */
  readonly tasksCompleted: number
  /** Total tasks failed */
  readonly tasksFailed: number
  /** Average task latency in ms */
  readonly avgLatencyMs: number
  /** Cost accuracy: actual/estimated ratio (1.0 = perfect) */
  readonly costAccuracy: number
  /** Number of delegation chain validations passed */
  readonly delegationsPassed: number
  /** Number of delegation chain validations failed */
  readonly delegationsFailed: number
  /** Days since last activity (for decay) */
  readonly daysSinceLastActivity: number
  /** Number of unique organizations that have used this agent */
  readonly uniqueOrganizations: number
}

/**
 * Trust score breakdown for transparency.
 */
export interface TrustScoreBreakdown {
  /** Overall score: 0.0 to 1.0 */
  readonly score: number
  /** Component scores */
  readonly components: {
    /** Success rate component (0-1) */
    readonly reliability: number
    /** Latency/SLA component (0-1) */
    readonly performance: number
    /** Cost accuracy component (0-1) */
    readonly costPredictability: number
    /** Delegation compliance component (0-1) */
    readonly delegationCompliance: number
    /** Activity recency component (0-1, decays over time) */
    readonly recency: number
  }
  /** When this score was calculated */
  readonly calculatedAt: Date
  /** Number of data points used */
  readonly sampleSize: number
}

export interface TrustScorerConfig {
  /** Component weights (must sum to 1.0) */
  weights?: {
    reliability?: number
    performance?: number
    costPredictability?: number
    delegationCompliance?: number
    recency?: number
  }
  /** Minimum tasks required before scoring (below this, score = 0.5). Default: 10 */
  minSampleSize?: number
  /** Half-life for recency decay in days. Default: 30 */
  recencyHalfLifeDays?: number
  /** Trust score store for persistence */
  store?: TrustScoreStore
}

export interface TrustScoreStore {
  getSignals(agentUri: string): Promise<TrustSignals | null>
  saveSignals(agentUri: string, signals: TrustSignals): Promise<void>
  getScore(agentUri: string): Promise<TrustScoreBreakdown | null>
  saveScore(agentUri: string, breakdown: TrustScoreBreakdown): Promise<void>
}

export interface TrustScorer {
  /**
   * Calculate trust score from signals.
   * Pure function -- does not read/write store.
   */
  calculate(signals: TrustSignals): TrustScoreBreakdown

  /**
   * Record a task outcome to update an agent's trust signals.
   * Reads current signals from store, merges, recalculates, saves.
   */
  recordOutcome(agentUri: string, outcome: {
    success: boolean
    latencyMs: number
    costCents: number
    estimatedCostCents?: number
  }): Promise<TrustScoreBreakdown>

  /**
   * Get the current trust score for an agent.
   * Returns from cache/store, does not recalculate.
   */
  getScore(agentUri: string): Promise<TrustScoreBreakdown | null>

  /**
   * Propagate trust across delegation chains.
   * The effective trust of a delegatee is min(delegator_trust, delegatee_trust).
   */
  getChainTrust(chain: import('./delegation-types.js').DelegationChain): Promise<number>
}

export function createTrustScorer(
  config?: TrustScorerConfig,
): TrustScorer { /* ... */ }
```

#### Trust Score Calculation

Default weights:

| Component | Weight | Calculation |
|-----------|--------|-------------|
| Reliability | 0.35 | `tasksCompleted / (tasksCompleted + tasksFailed)` |
| Performance | 0.20 | `1 - min(avgLatencyMs / slaMaxLatencyMs, 1)` |
| Cost Predictability | 0.15 | `1 - abs(1 - costAccuracy)` |
| Delegation Compliance | 0.15 | `delegationsPassed / (delegationsPassed + delegationsFailed)` |
| Recency | 0.15 | `0.5 ^ (daysSinceLastActivity / recencyHalfLifeDays)` |

Minimum sample size (default 10 tasks): below this threshold, score defaults to 0.5 (neutral).

#### Trust Propagation Across Delegation Chains

When Agent A delegates to Agent B who delegates to Agent C, the effective trust of C is:

```
effectiveTrust(C) = min(trust(A), trust(B), trust(C))
```

This ensures the chain is only as trustworthy as its weakest link.

---

## 3. Data Flow Diagrams

### 3.1 Agent Registration Flow

```
  Admin/Operator
        |
        | POST /api/agents { name, description, capabilities, ... }
        v
  +-------------------+
  | createForgeApp    |
  | Route: agents     |
  +-------------------+
        |
        | 1. Validate AgentDefinition
        | 2. Assign agent ID
        | 3. Build forge:// URI
        | 4. Generate API key (if requested)
        | 5. Generate Ed25519 key pair (if signing enabled)
        v
  +-------------------+
  | AgentStore.save() |
  +-------------------+
        |
        | 6. Register in AgentRegistry (if configured, see 03-DISCOVERY)
        | 7. Emit 'identity:resolved' event
        v
  Response: { agentId, uri, apiKey (once), publicKey }
```

### 3.2 Identity Verification on Incoming Request

```
  HTTP Request
  Authorization: Bearer fk_live_abc123
  X-Tenant-ID: acme
        |
        v
  authMiddleware -----------> Invalid? -> 401 Unauthorized
        | Valid
        v
  identityMiddleware
        | 1. Read c.apiKey (set by authMiddleware)
        | 2. Hash API key for cache lookup
        | 3. Cache hit? -> Use cached ForgeIdentity
        | 4. Cache miss?
        |    a. APIKeyResolver.resolve({ token: fk_live_abc123 })
        |    b. Lookup key in DB -> APIKeyRecord
        |    c. Map to ForgeIdentity { id, uri, capabilities, roles }
        |    d. Cache with TTL
        | 5. Set c.forgeIdentity
        v
  rbacMiddleware -----------> Forbidden? -> 403
        | Allowed
        v
  capabilityGuard ----------> Denied? -> 403 { code: 'CAPABILITY_DENIED' }
        | Allowed
        v
  Route Handler
```

### 3.3 Delegation Chain Validation

```
  Agent C receives request with DelegationToken (depth=2)
        |
        v
  DelegationManager.validateChain(token.id)
        |
        | 1. Load token from store
        | 2. Verify token.signature (HMAC-SHA256)
        | 3. Check token.expiresAt > now
        | 4. Check not revoked
        | 5. If token.parentTokenId:
        |    a. Recursively validate parent token
        |    b. Check depth <= maxDepth
        |    c. Intersect scopes
        |
        v
  DelegationChain {
    tokens: [A->B, B->C],
    effectiveScope: intersection(A->B.scope, B->C.scope),
    valid: true/false,
    invalidReason?: "Token B->C expired"
  }
        |
        | 6. Verify requested capability in effectiveScope
        v
  Proceed or reject with DELEGATION_SCOPE_VIOLATION
```

### 3.4 Trust Score Update Flow

```
  Agent completes task
        |
        v
  DzipEventBus: 'agent:completed' { agentId, runId, durationMs }
        |
        v
  TrustScorer plugin (event handler)
        | 1. Read current TrustSignals from store
        | 2. Merge new outcome:
        |    - tasksCompleted++
        |    - Update avgLatencyMs (exponential moving average)
        |    - Update costAccuracy
        | 3. Recalculate TrustScoreBreakdown
        | 4. Save updated signals + score to store
        | 5. If score changed significantly (>0.05):
        |    Emit 'identity:trust_updated' event
        v
  Updated trust score available for future discovery queries
```

---

## 4. File Structure

### @dzipagent/core/src/identity/

```
packages/forgeagent-core/src/identity/
  index.ts                      -- Barrel export for all identity types and functions
  identity-types.ts             -- ForgeIdentity, ForgeCredential, ForgeCapability, ForgeIdentityRef, toIdentityRef
  identity-schemas.ts           -- Zod schemas for all identity types
  identity-resolver.ts          -- IdentityResolver, CompositeIdentityResolver interfaces
  forge-uri.ts                  -- parseForgeUri, buildForgeUri, isForgeUri, toAgentUri, fromAgentUri, UriResolver
  api-key-resolver.ts           -- APIKeyRecord, APIKeyResolverConfig, createAPIKeyResolver
  delegation-types.ts           -- DelegationToken, DelegationChain, DelegationConstraint variants
  delegation-manager.ts         -- DelegationManager interface, DelegationTokenStore, createDelegationManager
  capability-checker.ts         -- CapabilityChecker, CapabilityCheckResult, createCapabilityChecker
  signing-types.ts              -- SigningKeyPair, SignedDocument, SignedAgentCard
  key-manager.ts                -- KeyManager, KeyStore, createKeyManager
  trust-scorer.ts               -- TrustScorer, TrustSignals, TrustScoreBreakdown, createTrustScorer
  did-resolver.ts               -- DIDDocument, DIDResolverConfig, createDIDResolver (P2)
  verifiable-credential-types.ts -- VerifiableCredential, VCIssuer, VCVerifier (P2)
  oidc-a-resolver.ts            -- OIDCAConfig, createOIDCAResolver, createOIDCATokenExchanger (P2)
```

### @dzipagent/server/src/middleware/

```
packages/forgeagent-server/src/middleware/
  auth.ts                       -- EXISTING, unchanged
  rbac.ts                       -- EXISTING, enhanced: extractRole can read ForgeIdentity
  tenant-scope.ts               -- EXISTING, unchanged
  rate-limiter.ts               -- EXISTING, unchanged
  identity.ts                   -- NEW: identityMiddleware, getForgeIdentity
  capability-guard.ts           -- NEW: capabilityGuard
```

### Export Structure

From `@dzipagent/core/src/identity/index.ts`:

```typescript
// Types
export type {
  ForgeIdentity,
  ForgeIdentityRef,
  ForgeCredential,
  ForgeCapability,
  CredentialType,
} from './identity-types.js'

export { toIdentityRef } from './identity-types.js'

// Schemas
export {
  ForgeIdentitySchema,
  ForgeIdentityRefSchema,
  ForgeCredentialSchema,
  ForgeCapabilitySchema,
  ForgeUriSchema,
  CredentialTypeSchema,
} from './identity-schemas.js'

// Resolver
export type {
  IdentityResolver,
  CompositeIdentityResolver,
  IdentityResolutionContext,
} from './identity-resolver.js'

// URI
export {
  parseForgeUri,
  buildForgeUri,
  isForgeUri,
  toAgentUri,
  fromAgentUri,
  createUriResolver,
} from './forge-uri.js'
export type { ForgeUriComponents, UriResolver, UriResolverConfig } from './forge-uri.js'

// API Key Resolver
export { createAPIKeyResolver } from './api-key-resolver.js'
export type { APIKeyRecord, APIKeyResolverConfig } from './api-key-resolver.js'

// Delegation
export type {
  DelegationToken,
  DelegationChain,
  DelegationConstraint,
  MaxCostConstraint,
  MaxTokensConstraint,
  MaxIterationsConstraint,
  AllowedToolsConstraint,
  TimeWindowConstraint,
} from './delegation-types.js'
export { createDelegationManager } from './delegation-manager.js'
export type { DelegationManager, DelegationManagerConfig, DelegationTokenStore } from './delegation-manager.js'

// Capabilities
export { createCapabilityChecker } from './capability-checker.js'
export type { CapabilityChecker, CapabilityCheckResult, CapabilityCheckerConfig } from './capability-checker.js'

// Signing
export type { SigningKeyPair, SignedDocument, SignedAgentCard } from './signing-types.js'
export { createKeyManager } from './key-manager.js'
export type { KeyManager, KeyStore, KeyManagerConfig } from './key-manager.js'

// Trust
export { createTrustScorer } from './trust-scorer.js'
export type { TrustScorer, TrustSignals, TrustScoreBreakdown, TrustScorerConfig, TrustScoreStore } from './trust-scorer.js'
```

Re-exported from `@dzipagent/core/src/index.ts` via:

```typescript
export * from './identity/index.js'
```

---

## 5. Migration Strategy

### Phase 0: Zero-change (current state continues to work)

Nothing in the identity layer is required. Existing deployments using `authMiddleware` + `rbacMiddleware` continue to function identically. The `identityMiddleware` is not added by default -- consumers opt in.

### Phase 1: Add identity alongside existing auth (P0 features)

```typescript
// Step 1: Create an API key resolver that wraps the existing validateKey function
const apiKeyResolver = createAPIKeyResolver({
  lookupKey: async (key) => {
    const meta = await existingValidateKey(key)
    if (!meta) return null
    return {
      keyId: meta.id,
      agentId: meta.agentId,
      agentName: meta.name,
      organization: meta.tenantId,
      roles: meta.roles,
      createdAt: meta.createdAt,
    }
  },
})

// Step 2: Add identity middleware AFTER auth, BEFORE rbac
app.use('/api/*', authMiddleware({ mode: 'api-key', validateKey }))
app.use('/api/*', identityMiddleware({ resolvers: [apiKeyResolver], required: false }))
app.use('/api/*', rbacMiddleware({ extractRole }))

// Step 3: Identity is now available in route handlers
app.get('/api/runs', (c) => {
  const identity = getForgeIdentity(c)  // ForgeIdentity | undefined
  // Use for logging, auditing, etc. -- not required for auth to work
})
```

### Phase 2: Capability-based authorization (P1 features)

```typescript
// Add capability guards to specific routes that need fine-grained control
app.post('/api/runs', capabilityGuard('runs.create'), createRunHandler)
app.delete('/api/agents/:id', capabilityGuard('agents.delete'), deleteAgentHandler)

// RBAC still works as fallback via roleCapabilityMap
```

### Phase 3: Delegation tokens (P1 features)

```typescript
// Sub-agent spawning automatically issues delegation tokens
const spawner = createSubAgentSpawner({
  delegationManager,  // NEW optional config
  // ... existing config
})

// Delegation tokens propagate through ForgeMessage envelope
// (requires 02-COMMUNICATION-PROTOCOLS features)
```

### Phase 4: DID/VC/OIDC-A (P2 features)

```typescript
// Add DID resolver alongside API key resolver
app.use('/api/*', identityMiddleware({
  resolvers: [
    apiKeyResolver,     // Try API key first
    oidcaResolver,      // Then OIDC-A
    didResolver,        // Then DID
  ],
  required: true,       // Now require identity resolution
}))
```

### Feature Flags

For gradual rollout, identity features respect a configuration object:

```typescript
export interface IdentityFeatureFlags {
  /** Enable identity resolution middleware. Default: false */
  identityResolution: boolean
  /** Enable capability-based authorization. Default: false */
  capabilityAuth: boolean
  /** Enable delegation tokens for sub-agent spawning. Default: false */
  delegationTokens: boolean
  /** Enable trust scoring. Default: false */
  trustScoring: boolean
  /** Enable agent card signing. Default: false */
  agentCardSigning: boolean
}
```

---

## 6. Testing Strategy

### 6.1 Unit Tests

| Component | Test File | Key Test Cases |
|-----------|-----------|---------------|
| `parseForgeUri` / `buildForgeUri` | `__tests__/forge-uri.test.ts` | Valid URIs, missing version, invalid characters, round-trip, agent:// conversion |
| `ForgeIdentitySchema` | `__tests__/identity-schemas.test.ts` | Valid identity, missing required fields, invalid URI, expired credential, capability name validation |
| `createAPIKeyResolver` | `__tests__/api-key-resolver.test.ts` | Successful resolution, invalid key, expired key, cache hit/miss, cache eviction, concurrent resolution |
| `createDelegationManager` | `__tests__/delegation-manager.test.ts` | Issue token, verify signature, chain validation, depth exceeded, scope intersection, expiration, revocation, concurrent issuance |
| `createCapabilityChecker` | `__tests__/capability-checker.test.ts` | Direct capability match, wildcard match, role fallback, delegation scope restriction, empty capabilities |
| `createTrustScorer` | `__tests__/trust-scorer.test.ts` | Score calculation, component weights, minimum sample size, recency decay, chain trust propagation |
| `createKeyManager` | `__tests__/key-manager.test.ts` | Key generation, signing, verification, rotation, revoked key rejection |
| `identityMiddleware` | `__tests__/identity-middleware.test.ts` | Resolution success, resolution failure (required vs optional), resolver chain ordering, context propagation |
| `capabilityGuard` | `__tests__/capability-guard.test.ts` | Single capability, multiple capabilities, no identity (fallback to RBAC), delegation-scoped |

### 6.2 Integration Tests

| Test Suite | Scope |
|-----------|-------|
| Auth + Identity + RBAC stack | Full middleware chain: auth -> identity -> rbac -> capability guard -> handler |
| Delegation through sub-agent spawn | Parent agent issues delegation, child uses it, scope enforced |
| Trust score update on task completion | Event bus fires agent:completed, trust scorer updates score |
| Signed agent card round-trip | Build signed card, serve via route, fetch and verify signature |

### 6.3 Security Tests

| Test | What It Validates |
|------|------------------|
| Token forgery | Modified token body fails HMAC verification |
| Token replay | Expired tokens are rejected even with valid signature |
| Scope escalation | Child delegation cannot widen parent's scope |
| Depth bomb | Chain deeper than maxDepth is rejected |
| Cache poisoning | Expired cache entries are not served; manual invalidation works |
| Timing attack resistance | Signature comparison uses constant-time comparison |
| Key rotation | Old keys stop working after rotation grace period |
| Revocation propagation | Revoking a parent token invalidates all child tokens |

### 6.4 Test Utilities

For consumers writing tests against identity-aware code:

```typescript
// --- @dzipagent/test-utils (future) or inline helpers ---

/**
 * Create a minimal ForgeIdentity for testing.
 * All fields have sensible defaults that can be overridden.
 */
export function createTestIdentity(
  overrides?: Partial<ForgeIdentity>,
): ForgeIdentity { /* ... */ }

/**
 * Create a test delegation token with valid signature.
 */
export function createTestDelegationToken(
  overrides?: Partial<DelegationToken>,
): DelegationToken { /* ... */ }

/**
 * Create a mock IdentityResolver that returns a fixed identity.
 */
export function createMockResolver(
  identity: ForgeIdentity | null,
): IdentityResolver { /* ... */ }
```

---

## 7. Dependencies

### 7.1 What This Depends On

| Dependency | Package | Status | Required For |
|-----------|---------|--------|-------------|
| `DzipEventBus` | `@dzipagent/core/events` | Exists | Identity events (F1) |
| `ForgeError`, `ForgeErrorCode` | `@dzipagent/core/errors` | Exists | Error handling |
| `authMiddleware` | `@dzipagent/server/middleware` | Exists | Transport-level auth (F3) |
| `rbacMiddleware` | `@dzipagent/server/middleware` | Exists | Role fallback (F5) |
| `AgentCard`, `buildAgentCard` | `@dzipagent/server/a2a` | Exists | Card signing (F6) |
| `SubAgentConfig` | `@dzipagent/core/subagent` | Exists | Delegation propagation (F4) |
| `AgentStore`, `RunStore` | `@dzipagent/core/persistence` | Exists | Trust signal persistence (F10) |
| `zod` | peer dependency | Exists | Schema validation (F1) |
| Node.js `crypto` | built-in | N/A | HMAC-SHA256 (F4), Ed25519 (F6) |

### 7.2 External Libraries (New)

| Library | Purpose | When Needed | Peer/Direct |
|---------|---------|-------------|------------|
| `jose` | JWT verification for OIDC-A | F9 (P2) | Peer |
| `@noble/ed25519` | Ed25519 signing (if Node.js < 22) | F6 (P1) | Direct (small, no deps) |
| `canonicalize` | JSON Canonicalization (RFC 8785) | F4 (P1) | Direct (tiny) |

### 7.3 What Depends on This

| Downstream | Uses | Required Phase |
|-----------|------|---------------|
| `02-COMMUNICATION-PROTOCOLS` | `ForgeIdentity` in `ForgeMessage.from/to`, `DelegationToken` in metadata | Phase 1 |
| `03-DISCOVERY-REGISTRY` | `ForgeIdentity` in `AgentRegistry.register()`, capabilities for discovery queries | Phase 1 |
| `04-ORCHESTRATION-PATTERNS` | Delegation tokens for contract-net bidding, trust scores for agent selection | Phase 2 |
| `05-MEMORY-SHARING` | Identity for `MemoryProvenance.createdBy`, access control in `SharedMemorySpace` | Phase 2 |
| `06-OBSERVABILITY-TRACING` | `ForgeIdentityRef` in span attributes for trace attribution | Phase 1 |
| `09-FORMATS-STANDARDS` | Identity fields in Agent Card v2 | Phase 1 |
| `12-SECURITY-GOVERNANCE` | Capability checks for zero-trust policies, delegation audit trail | Phase 3 |

### 7.4 Dependency Boundary Rules

1. `@dzipagent/core/src/identity/` imports NOTHING from `@dzipagent/server`, `@dzipagent/agent`, `@dzipagent/codegen`, or `@dzipagent/memory`
2. `@dzipagent/server/src/middleware/identity.ts` imports types from `@dzipagent/core/identity` (allowed: server depends on core)
3. DID/VC/OIDC-A resolvers import from `@dzipagent/core/identity` only (they are leaf implementations)
4. Trust scorer reads from `RunStore` interface (defined in core), not concrete Postgres implementation

---

## Appendix A: Implementation Priority Summary

| Feature | Priority | Effort | Phase | Dependencies |
|---------|----------|--------|-------|-------------|
| F1: ForgeIdentity Types | P0 | 4h | 1 | None |
| F2: Agent URI Scheme | P0 | 2h | 1 | None |
| F3: API-Key Identity Resolver | P0 | 4h | 1 | F1 |
| F4: Delegation Token System | P1 | 8h | 2 | F1, F2 |
| F5: Capability-Based Auth | P1 | 6h | 2 | F1 |
| F6: Agent Card Signing | P1 | 4h | 2 | F1 |
| F7: DID Identity Resolver | P2 | 12h | 3 | F3 |
| F8: Verifiable Credentials | P2 | 16h | 3 | F7 |
| F9: OIDC-A Integration | P2 | 12h | 3 | F3 |
| F10: Trust Scoring | P2 | 8h | 3 | F2 |
| **Total** | | **76h** | | |

## Appendix B: ADR-001 -- Identity Types in Core, Not Separate Package

### Status: Accepted

### Context
We considered creating a separate `@dzipagent/identity` package for the identity layer. The identity module has 15+ files and could grow further with DID/VC support.

### Decision
Identity types and interfaces live in `@dzipagent/core/src/identity/`. The API-key resolver also lives in core. DID/VC/OIDC-A resolvers live in core initially but may be extracted to `@dzipagent/identity` if the module exceeds ~30 files or requires heavy external dependencies.

### Rationale
1. Every package needs identity types (ForgeIdentity, ForgeIdentityRef) -- putting them in core avoids a new dependency for all consumers
2. The IdentityResolver interface is a core abstraction like RunStore or AgentStore
3. The API-key resolver has zero external dependencies -- it belongs in core
4. DID/VC resolvers add external deps (`jose`, DID resolution libraries) but can be tree-shaken if unused
5. A separate package adds coordination overhead for a solo/small team

### Consequences
- Positive: No new package to maintain for P0/P1 features
- Positive: Identity types available everywhere without additional dependencies
- Negative: Core package grows by ~15 files
- Risk: If DID/VC deps are heavy, core bundle size increases. Mitigate: lazy import or extract at that point.
