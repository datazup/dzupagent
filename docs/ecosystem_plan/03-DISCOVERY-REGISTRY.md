# 03 — Discovery & Registry

> **Created:** 2026-03-24
> **Status:** Planning
> **Package:** `@dzipagent/registry` (new) + interfaces in `@dzipagent/core`
> **Dependencies:** 01-IDENTITY-TRUST (ForgeIdentity), 02-COMMUNICATION-PROTOCOLS (ProtocolAdapter, ForgeMessage)
> **Effort:** ~58h across 9 features (P0: 12h, P1: 22h, P2: 12h, P3: 16h)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Feature Specifications](#2-feature-specifications)
   - [F1: AgentRegistry Interface (P0, 4h)](#f1-agentregistry-interface)
   - [F2: Capability Taxonomy (P0, 4h)](#f2-capability-taxonomy)
   - [F3: InMemoryRegistry (P0, 4h)](#f3-inmemoryregistry)
   - [F4: PostgresRegistry (P1, 8h)](#f4-postgresregistry)
   - [F5: Semantic Capability Search (P1, 8h)](#f5-semantic-capability-search)
   - [F6: Health Monitoring (P1, 6h)](#f6-health-monitoring)
   - [F7: Agent Card Versioning (P2, 4h)](#f7-agent-card-versioning)
   - [F8: Registry Federation (P3, 16h)](#f8-registry-federation)
   - [F9: OpenAPI/AsyncAPI Generation (P2, 8h)](#f9-openapiasynapi-generation)
3. [Data Models](#3-data-models)
4. [Data Flow Diagrams](#4-data-flow-diagrams)
5. [File Structure](#5-file-structure)
6. [Testing Strategy](#6-testing-strategy)
7. [Migration from Current State](#7-migration-from-current-state)

---

## 1. Architecture Overview

### 1.1 Current State

DzipAgent has two discovery-adjacent features that do not interoperate:

1. **Agent Card builder** (`packages/forgeagent-server/src/a2a/agent-card.ts`) — `buildAgentCard()` produces a JSON object served at `/.well-known/agent.json`. The `AgentCard` type is minimal: `name`, `description`, `url`, `version`, `capabilities[]`, optional `authentication` and `skills`. There is no registry, no health tracking, no semantic search.

2. **Plugin discovery** (`packages/forgeagent-core/src/plugin/plugin-discovery.ts`) — `discoverPlugins()` scans local filesystem directories for `forgeagent-plugin.json` manifests. The `PluginRegistry` class (`plugin-registry.ts`) stores `DzipPlugin` instances in a `Map<string, DzipPlugin>` with no persistence, no health, no capability matching.

Neither system supports:
- Registering remote agents for discovery
- Querying by capability ("find an agent that can review TypeScript security")
- Monitoring agent health over time
- Subscribing to registration/deregistration events
- Federating with external registries (a2aregistry.org, ANS)

### 1.2 Target Architecture

The Discovery & Registry layer has three tiers that can be adopted independently:

```
+----------------------------------------------------------------------+
|                         Registry Consumers                           |
|  (Orchestrator, Supervisor, Contract-Net, Manual Discovery)          |
+-------------------------------+--------------------------------------+
                                |
                    AgentRegistry interface
                    (core — pure abstraction)
                                |
        +-----------------------+-----------------------+
        |                       |                       |
  InMemoryRegistry      PostgresRegistry        FederatedRegistry
  (core — dev/test)     (server — prod)         (registry — mesh)
        |                       |                       |
        |                  +---------+           +-----------+
        |                  | Drizzle |           | Remote    |
        |                  | Tables  |           | Sync      |
        |                  +---------+           +-----------+
        |                       |                       |
        +-----------------------+-----------------------+
                                |
                     HealthMonitor (periodic probes)
                                |
                     CapabilityMatcher (taxonomy + semantic)
                                |
                     DzipEventBus (registry:* events)
```

**Key design decisions:**

1. **AgentRegistry is an interface in `@dzipagent/core`** — follows the RunStore/AgentStore pattern where `core` owns the interface and implementations live in their respective packages.

2. **InMemoryRegistry ships with `core`** — zero-config for development, just like `InMemoryRunStore`.

3. **PostgresRegistry lives in `@dzipagent/server`** — extends the existing Drizzle schema alongside `dzip_agents` and `forge_runs`.

4. **FederatedRegistry and semantic search live in `@dzipagent/registry`** — a new package for advanced discovery features that depend on embeddings and network I/O.

5. **HealthMonitor is decoupled** — it writes health updates to whichever `AgentRegistry` is configured, using the existing `HealthAggregator` pattern from core.

6. **Events integrate with DzipEventBus** — new `registry:*` event types added to the discriminated union.

### 1.3 Dependency Graph

```
@dzipagent/core
  - AgentRegistry interface
  - CapabilityDescriptor, DiscoveryQuery, DiscoveryResult types
  - CapabilityTaxonomy (standard capabilities tree)
  - CapabilityMatcher (keyword/hierarchy matching)
  - InMemoryRegistry implementation
  - New DzipEvent types: registry:agent_registered, registry:agent_deregistered,
    registry:health_changed, registry:query_executed

@dzipagent/server (depends on core)
  - PostgresRegistry implementation
  - Drizzle schema additions (forge_registry_agents, forge_registry_health)
  - REST routes: GET/POST/DELETE /registry/agents, GET /registry/discover
  - Health probe scheduler

@dzipagent/registry (depends on core, peer dep on server)
  - SemanticCapabilitySearch (embedding-based)
  - FederatedRegistry (multi-registry sync)
  - AgentCardVersioning (version history, deprecation)
  - OpenAPI/AsyncAPI generator
```

### 1.4 Integration with Identity Layer (Doc 01)

The registry stores and indexes `ForgeIdentity` from the identity layer:

- **Registration requires identity** — `register()` accepts a `RegisteredAgent` that includes a `ForgeIdentity` (URI, public key fingerprint, credential type). Anonymous registration is rejected.
- **Discovery results include identity** — consumers can verify the identity of discovered agents before delegating work.
- **Health probes authenticate** — the health monitor presents its own identity when probing agents, allowing agents to distinguish monitoring traffic from untrusted requests.

### 1.5 Integration with Communication Layer (Doc 02)

- **Protocol-aware discovery** — `DiscoveryQuery` can filter by supported protocols (`a2a`, `mcp`, `http`, `ws`). The registry stores which `ProtocolAdapter` names each agent supports.
- **Agent Card as registration source** — `registerFromCard()` convenience method fetches `/.well-known/agent-card.json` from a URL, validates it, and registers the agent.
- **Discovery feeds orchestration** — the Orchestrator (Doc 04) calls `registry.discover()` to find agents for contract-net proposals or dynamic topology assembly.

---

## 2. Feature Specifications

### F1: AgentRegistry Interface

**Priority:** P0 | **Effort:** 4h | **Package:** `@dzipagent/core`

The abstract interface that all registry backends implement. Follows the same pattern as `RunStore` and `AgentStore` — pure data types, no I/O assumptions.

```typescript
// --- packages/forgeagent-core/src/registry/types.ts ---

import type { DzipEventBus } from '../events/event-bus.js'

// ─── Capability Descriptor ──────────────────────────────────────────

/**
 * A structured capability declaration for an agent.
 *
 * Capabilities use a hierarchical dot-notation taxonomy:
 *   `code.review.security`, `data.sql.generate`, `memory.search.semantic`
 *
 * @example
 * ```ts
 * const cap: CapabilityDescriptor = {
 *   name: 'code.review.security',
 *   version: '1.2.0',
 *   description: 'Reviews code for OWASP Top 10 vulnerabilities',
 *   inputSchema: { type: 'object', properties: { code: { type: 'string' } } },
 *   outputSchema: { type: 'object', properties: { findings: { type: 'array' } } },
 *   tags: ['security', 'owasp', 'typescript'],
 * }
 * ```
 */
export interface CapabilityDescriptor {
  /** Hierarchical capability name using dot notation */
  name: string
  /** Semver version of this capability */
  version: string
  /** Human-readable description of what this capability does */
  description: string
  /** JSON Schema for the expected input */
  inputSchema?: Record<string, unknown>
  /** JSON Schema for the expected output */
  outputSchema?: Record<string, unknown>
  /** Free-form tags for additional filtering */
  tags?: string[]
}

// ─── Registered Agent ───────────────────────────────────────────────

/**
 * The full record of an agent registered in the registry.
 *
 * This combines identity, capabilities, protocol support, and
 * operational metadata into a single queryable record.
 */
export interface RegisteredAgent {
  /** Unique agent ID (UUID or ForgeIdentity URI) */
  id: string
  /** Human-readable agent name */
  name: string
  /** Description of the agent's purpose */
  description: string
  /** Base endpoint URL for reaching this agent */
  endpoint: string
  /** Supported communication protocols */
  protocols: AgentProtocol[]
  /** Declared capabilities */
  capabilities: CapabilityDescriptor[]
  /** Authentication requirement for callers */
  authentication: AgentAuthentication
  /** Current health snapshot (updated by HealthMonitor) */
  health: AgentHealth
  /** Agent card version (semver) */
  version: string
  /** SLA declarations */
  sla?: AgentSLA
  /** Arbitrary metadata for extensibility */
  metadata?: Record<string, unknown>
  /** When this agent was first registered */
  registeredAt: Date
  /** When this record was last updated (registration, health probe, etc.) */
  lastUpdatedAt: Date
  /** TTL in ms — if no heartbeat within this period, auto-deregister. 0 = no TTL. */
  ttlMs: number
}

/**
 * Supported protocol identifiers. Extensible via string literal union.
 * Core protocols align with the ProtocolAdapter names from Doc 02.
 */
export type AgentProtocol = 'a2a' | 'mcp' | 'http' | 'ws' | 'grpc' | (string & {})

/**
 * Authentication requirements an agent declares to callers.
 */
export interface AgentAuthentication {
  /** Auth mechanism this agent requires */
  type: 'none' | 'bearer' | 'api-key' | 'oauth2' | 'mtls' | 'delegation-token'
  /** URL to obtain credentials, if applicable */
  tokenUrl?: string
  /** Required OAuth2 scopes, if applicable */
  scopes?: string[]
}

// ─── Agent Health ───────────────────────────────────────────────────

/**
 * Health snapshot for a registered agent.
 *
 * Updated by the HealthMonitor on each probe cycle. Consumers
 * can use this to exclude unhealthy agents from discovery results.
 */
export interface AgentHealth {
  /** Current operational status */
  status: AgentHealthStatus
  /** Timestamp of the last successful health probe */
  lastCheckedAt: Date | null
  /** Timestamp of the last successful response from the agent */
  lastSuccessAt: Date | null
  /** Latency percentiles from recent probes (ms) */
  latency: LatencyPercentiles
  /** Error rate as a fraction (0.0 - 1.0) over the sliding window */
  errorRate: number
  /** Consecutive successful probes since last failure */
  consecutiveSuccesses: number
  /** Consecutive failed probes since last success */
  consecutiveFailures: number
  /** Total uptime ratio (0.0 - 1.0) since registration */
  uptimeRatio: number
  /** Circuit breaker state for this agent */
  circuitState: 'closed' | 'open' | 'half-open'
}

export type AgentHealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unhealthy' | 'unreachable'

export interface LatencyPercentiles {
  p50: number
  p95: number
  p99: number
}

// ─── Agent SLA ──────────────────────────────────────────────────────

/**
 * Service Level Agreement declarations.
 * Used by discovery to filter agents meeting caller requirements.
 */
export interface AgentSLA {
  /** Maximum acceptable response latency in ms */
  maxLatencyMs?: number
  /** Minimum uptime ratio (e.g. 0.99 for 99%) */
  minUptimeRatio?: number
  /** Maximum acceptable error rate (e.g. 0.01 for 1%) */
  maxErrorRate?: number
  /** Maximum requests per second this agent can handle */
  maxRps?: number
}

// ─── Discovery Query ────────────────────────────────────────────────

/**
 * Query object for `AgentRegistry.discover()`.
 *
 * All fields are optional; they combine with AND semantics.
 * At least one of `capability`, `semanticQuery`, `tags`, or `protocols`
 * should be provided for meaningful results.
 *
 * @example
 * ```ts
 * // Find agents that can review TypeScript security code
 * const results = await registry.discover({
 *   capability: 'code.review',
 *   semanticQuery: 'analyze TypeScript code for security vulnerabilities',
 *   tags: ['typescript', 'security'],
 *   healthFilter: { minStatus: 'healthy' },
 *   limit: 5,
 * })
 * ```
 */
export interface DiscoveryQuery {
  /** Filter by capability name prefix (e.g. 'code.review' matches 'code.review.security') */
  capability?: string
  /** Filter by exact capability name and optional minimum version */
  capabilityExact?: { name: string; minVersion?: string }
  /** Natural-language query for semantic matching */
  semanticQuery?: string
  /** Filter by tags (OR within tags, AND with other filters) */
  tags?: string[]
  /** Filter by supported protocol */
  protocols?: AgentProtocol[]
  /** Health-based filters */
  healthFilter?: HealthFilter
  /** SLA-based filters */
  slaFilter?: SLAFilter
  /** Agent name substring match */
  nameContains?: string
  /** Exclude agents by ID */
  excludeIds?: string[]
  /** Maximum number of results (default: 20) */
  limit?: number
  /** Offset for pagination */
  offset?: number
  /** Sort order for results */
  sortBy?: DiscoverySortField
}

export interface HealthFilter {
  /** Minimum health status (healthy > degraded > unhealthy > unreachable) */
  minStatus?: AgentHealthStatus
  /** Maximum p95 latency in ms */
  maxLatencyP95?: number
  /** Maximum error rate (0.0 - 1.0) */
  maxErrorRate?: number
  /** Only include agents with circuit breaker closed */
  circuitClosed?: boolean
}

export interface SLAFilter {
  /** Agent must declare maxLatencyMs <= this value */
  maxLatencyMs?: number
  /** Agent must declare minUptimeRatio >= this value */
  minUptimeRatio?: number
}

export type DiscoverySortField =
  | 'relevance'
  | 'latency'
  | 'errorRate'
  | 'uptimeRatio'
  | 'registeredAt'
  | 'name'

// ─── Discovery Result ───────────────────────────────────────────────

/**
 * A single discovery result with match scoring.
 */
export interface DiscoveryResult {
  /** The matched agent record */
  agent: RegisteredAgent
  /** Overall match score (0.0 - 1.0), combining capability, semantic, and health signals */
  matchScore: number
  /** Breakdown of how the score was computed */
  scoreBreakdown: ScoreBreakdown
}

export interface ScoreBreakdown {
  /** Score from capability name/prefix matching (0.0 - 1.0) */
  capabilityScore: number
  /** Score from semantic similarity (0.0 - 1.0), 0 if no semantic query */
  semanticScore: number
  /** Score from tag overlap (0.0 - 1.0) */
  tagScore: number
  /** Health bonus/penalty (-0.2 to +0.2) */
  healthAdjustment: number
}

/**
 * Paginated wrapper for discovery results.
 */
export interface DiscoveryResultPage {
  results: DiscoveryResult[]
  total: number
  limit: number
  offset: number
  /** Time taken to execute the query in ms */
  queryTimeMs: number
}

// ─── Registration Input ─────────────────────────────────────────────

/**
 * Input for registering an agent. Validated before storage.
 */
export interface RegisterAgentInput {
  /** Unique agent ID. If omitted, a UUID is generated. */
  id?: string
  name: string
  description: string
  endpoint: string
  protocols: AgentProtocol[]
  capabilities: CapabilityDescriptor[]
  authentication: AgentAuthentication
  version: string
  sla?: AgentSLA
  metadata?: Record<string, unknown>
  /** TTL in ms. Default: 300_000 (5 minutes). Set 0 for no TTL. */
  ttlMs?: number
}

// ─── Registry Events ────────────────────────────────────────────────

/**
 * Events emitted by the registry through DzipEventBus.
 * These are added to the DzipEvent discriminated union.
 */
export type RegistryEvent =
  | { type: 'registry:agent_registered'; agentId: string; agentName: string; capabilities: string[] }
  | { type: 'registry:agent_deregistered'; agentId: string; reason: DeregistrationReason }
  | { type: 'registry:agent_updated'; agentId: string; fields: string[] }
  | { type: 'registry:health_changed'; agentId: string; previousStatus: AgentHealthStatus; newStatus: AgentHealthStatus }
  | { type: 'registry:query_executed'; query: DiscoveryQuery; resultCount: number; queryTimeMs: number }

export type DeregistrationReason = 'manual' | 'ttl_expired' | 'health_failure' | 'federation_sync'

// ─── Registry Subscription ──────────────────────────────────────────

/**
 * Subscription filter for registry.subscribe().
 * If all fields are undefined, receives all events.
 */
export interface RegistrySubscriptionFilter {
  /** Only events for these agent IDs */
  agentIds?: string[]
  /** Only these event types */
  eventTypes?: RegistryEvent['type'][]
  /** Only events for agents with these capabilities */
  capabilities?: string[]
}

// ─── AgentRegistry Interface ────────────────────────────────────────

/**
 * Abstract registry interface for agent discovery.
 *
 * Implementations:
 * - `InMemoryRegistry` in `@dzipagent/core` (dev/test)
 * - `PostgresRegistry` in `@dzipagent/server` (production)
 * - `FederatedRegistry` in `@dzipagent/registry` (multi-cluster)
 *
 * All methods are async to support both in-memory and persistent backends.
 * Implementations MUST emit corresponding `RegistryEvent`s through the
 * provided `DzipEventBus`.
 *
 * @example
 * ```ts
 * const registry: AgentRegistry = new InMemoryRegistry(eventBus)
 *
 * // Register an agent
 * const agent = await registry.register({
 *   name: 'security-reviewer',
 *   description: 'Reviews code for security vulnerabilities',
 *   endpoint: 'https://agents.example.com/security',
 *   protocols: ['a2a', 'http'],
 *   capabilities: [{
 *     name: 'code.review.security',
 *     version: '1.0.0',
 *     description: 'OWASP Top 10 vulnerability scanning',
 *   }],
 *   authentication: { type: 'bearer' },
 *   version: '2.1.0',
 * })
 *
 * // Discover agents by capability
 * const results = await registry.discover({
 *   capability: 'code.review',
 *   healthFilter: { minStatus: 'healthy' },
 * })
 * ```
 */
export interface AgentRegistry {
  /**
   * Register an agent in the registry.
   * Throws `ForgeError` with code `REGISTRY_DUPLICATE` if an agent with the
   * same ID is already registered. Use `update()` for re-registration.
   */
  register(input: RegisterAgentInput): Promise<RegisteredAgent>

  /**
   * Remove an agent from the registry.
   * No-op if the agent is not registered (idempotent).
   */
  deregister(agentId: string, reason?: DeregistrationReason): Promise<void>

  /**
   * Update a registered agent's mutable fields.
   * Only provided fields are updated; omitted fields remain unchanged.
   * Throws `ForgeError` with code `REGISTRY_NOT_FOUND` if agent does not exist.
   */
  update(agentId: string, update: Partial<RegisterAgentInput>): Promise<RegisteredAgent>

  /**
   * Discover agents matching the given query.
   * Returns results sorted by `matchScore` descending (unless `sortBy` overrides).
   */
  discover(query: DiscoveryQuery): Promise<DiscoveryResultPage>

  /**
   * Get a single agent by ID.
   * Returns `null` if not found.
   */
  getAgent(agentId: string): Promise<RegisteredAgent | null>

  /**
   * Get a single agent's current health.
   * Returns `null` if the agent is not registered.
   */
  getHealth(agentId: string): Promise<AgentHealth | null>

  /**
   * Update the health record for an agent.
   * Called by the HealthMonitor after each probe cycle.
   */
  updateHealth(agentId: string, health: Partial<AgentHealth>): Promise<void>

  /**
   * Subscribe to registry events, optionally filtered.
   * Returns an unsubscribe function.
   *
   * Implementations delegate to DzipEventBus internally but provide
   * the filter layer on top.
   */
  subscribe(
    handler: (event: RegistryEvent) => void | Promise<void>,
    filter?: RegistrySubscriptionFilter,
  ): () => void

  /**
   * List all registered agents (unfiltered, paginated).
   * For filtered queries, use `discover()`.
   */
  listAgents(limit?: number, offset?: number): Promise<{ agents: RegisteredAgent[]; total: number }>

  /**
   * Register an agent from a remote Agent Card URL.
   * Fetches `/.well-known/agent-card.json` (or `/.well-known/agent.json`),
   * validates the response, and registers.
   *
   * Throws `ForgeError` with code `REGISTRY_FETCH_FAILED` on network error
   * or `REGISTRY_INVALID_CARD` on validation failure.
   */
  registerFromCard(cardUrl: string, overrides?: Partial<RegisterAgentInput>): Promise<RegisteredAgent>

  /**
   * Evict agents whose TTL has expired.
   * Called periodically by the HealthMonitor or manually.
   * Returns the IDs of evicted agents.
   */
  evictExpired(): Promise<string[]>

  /**
   * Get registry statistics for monitoring dashboards.
   */
  stats(): Promise<RegistryStats>
}

export interface RegistryStats {
  totalAgents: number
  healthyAgents: number
  degradedAgents: number
  unhealthyAgents: number
  unreachableAgents: number
  capabilityCount: number
  avgLatencyP50: number
  avgLatencyP95: number
}
```

**Error codes to add to `error-codes.ts`:**

```typescript
// Add to ForgeErrorCode union:
| 'REGISTRY_DUPLICATE'
| 'REGISTRY_NOT_FOUND'
| 'REGISTRY_FETCH_FAILED'
| 'REGISTRY_INVALID_CARD'
| 'REGISTRY_SYNC_FAILED'
```

**Event types to add to `event-types.ts`:**

```typescript
// Add to DzipEvent union:
| { type: 'registry:agent_registered'; agentId: string; agentName: string; capabilities: string[] }
| { type: 'registry:agent_deregistered'; agentId: string; reason: string }
| { type: 'registry:agent_updated'; agentId: string; fields: string[] }
| { type: 'registry:health_changed'; agentId: string; previousStatus: string; newStatus: string }
| { type: 'registry:query_executed'; query: unknown; resultCount: number; queryTimeMs: number }
```

---

### F2: Capability Taxonomy

**Priority:** P0 | **Effort:** 4h | **Package:** `@dzipagent/core`

A hierarchical naming system and matching engine for agent capabilities. The taxonomy is not an exhaustive enum -- it is an open tree that agents extend with their own leaves. The standard tree provides well-known prefixes for interoperability.

#### 2.1 Taxonomy Design Principles

1. **Dot-separated hierarchy** -- `domain.category.specialization` (max 5 levels).
2. **Lowercase alphanumeric + hyphens within segments** -- `code.review.security-owasp`.
3. **Semver per capability** -- capabilities evolve independently of agent versions.
4. **Prefix matching** -- querying `code.review` matches `code.review.security` and `code.review.style`.
5. **Open tree** -- any agent can declare capabilities outside the standard tree. The taxonomy registry validates format, not membership.

#### 2.2 Standard Capability Tree

```typescript
// --- packages/forgeagent-core/src/registry/capability-taxonomy.ts ---

/**
 * Standard capability taxonomy for DzipAgent ecosystem.
 *
 * This tree defines well-known capability prefixes. Agents may declare
 * capabilities outside this tree -- the taxonomy is advisory, not restrictive.
 *
 * Hierarchy: domain.category[.specialization[.variant]]
 *
 * @example
 * ```ts
 * // Check if a capability is in the standard tree
 * isStandardCapability('code.review.security') // true
 * isStandardCapability('custom.my-tool')       // false (valid, but non-standard)
 * ```
 */
export const STANDARD_CAPABILITIES = {
  code: {
    review: {
      security: 'Reviews code for security vulnerabilities',
      style: 'Reviews code for style and convention adherence',
      performance: 'Reviews code for performance issues',
      accessibility: 'Reviews code for accessibility compliance',
    },
    generate: {
      feature: 'Generates new feature code from specifications',
      test: 'Generates test code for existing implementations',
      migration: 'Generates database or API migration code',
      refactor: 'Refactors existing code for improved quality',
    },
    edit: {
      patch: 'Applies targeted patches to existing code',
      'bulk-rename': 'Renames symbols across a codebase',
      format: 'Formats code according to style rules',
    },
    explain: {
      summary: 'Summarizes code purpose and structure',
      'line-by-line': 'Provides detailed line-by-line explanations',
    },
  },
  data: {
    sql: {
      generate: 'Generates SQL queries from natural language',
      optimize: 'Optimizes existing SQL queries',
      migrate: 'Generates schema migration SQL',
    },
    transform: {
      etl: 'Extracts, transforms, and loads data',
      format: 'Converts between data formats (CSV, JSON, Parquet)',
    },
    analyze: {
      statistics: 'Performs statistical analysis on datasets',
      anomaly: 'Detects anomalies in data',
    },
  },
  memory: {
    search: {
      semantic: 'Searches memory using semantic similarity',
      keyword: 'Searches memory using keyword matching',
      graph: 'Searches memory using entity graph traversal',
    },
    manage: {
      consolidate: 'Consolidates and deduplicates memory entries',
      heal: 'Detects and repairs memory inconsistencies',
    },
  },
  devops: {
    deploy: {
      container: 'Deploys containerized applications',
      serverless: 'Deploys to serverless platforms',
      kubernetes: 'Manages Kubernetes deployments',
    },
    monitor: {
      logs: 'Analyzes application logs',
      metrics: 'Monitors application metrics',
      alerts: 'Manages alerting rules',
    },
    ci: {
      pipeline: 'Creates and manages CI/CD pipelines',
      test: 'Runs automated test suites',
    },
  },
  docs: {
    generate: {
      api: 'Generates API documentation',
      readme: 'Generates README files',
      changelog: 'Generates changelogs from commits',
    },
    translate: {
      i18n: 'Translates documentation between languages',
    },
  },
  chat: {
    converse: {
      general: 'General-purpose conversational agent',
      technical: 'Technical domain conversational agent',
      support: 'Customer support conversational agent',
    },
    summarize: {
      conversation: 'Summarizes conversations',
      document: 'Summarizes documents',
    },
  },
} as const

/**
 * Parsed representation of a hierarchical capability name.
 */
export interface ParsedCapability {
  /** Full dot-separated name */
  full: string
  /** Individual segments */
  segments: string[]
  /** Top-level domain (first segment) */
  domain: string
  /** Category (second segment, if present) */
  category: string | undefined
  /** Specialization (third segment, if present) */
  specialization: string | undefined
  /** Depth of the hierarchy (number of segments) */
  depth: number
}

/**
 * Validates a capability name string.
 *
 * Rules:
 * - 1-5 dot-separated segments
 * - Each segment: lowercase alphanumeric + hyphens, 1-64 chars
 * - No leading/trailing dots or consecutive dots
 *
 * @returns `{ valid: true }` or `{ valid: false, error: string }`
 */
export function validateCapabilityName(
  name: string
): { valid: true } | { valid: false; error: string } {
  if (!name || name.length === 0) {
    return { valid: false, error: 'Capability name must not be empty' }
  }

  const segments = name.split('.')
  if (segments.length < 1 || segments.length > 5) {
    return { valid: false, error: `Capability name must have 1-5 segments, got ${segments.length}` }
  }

  const segmentPattern = /^[a-z][a-z0-9-]{0,63}$/
  for (const seg of segments) {
    if (!segmentPattern.test(seg)) {
      return {
        valid: false,
        error: `Invalid segment "${seg}": must be lowercase alphanumeric + hyphens, 1-64 chars, starting with a letter`,
      }
    }
  }

  return { valid: true }
}

/**
 * Parse a capability name into its hierarchical components.
 */
export function parseCapability(name: string): ParsedCapability {
  const segments = name.split('.')
  return {
    full: name,
    segments,
    domain: segments[0]!,
    category: segments[1],
    specialization: segments[2],
    depth: segments.length,
  }
}

/**
 * Check whether `candidate` is a prefix-match or exact match for `query`.
 *
 * - `matchCapability('code.review', 'code.review.security')` => true (prefix)
 * - `matchCapability('code.review.security', 'code.review.security')` => true (exact)
 * - `matchCapability('code.generate', 'code.review.security')` => false
 */
export function matchCapability(query: string, candidate: string): boolean {
  return candidate === query || candidate.startsWith(query + '.')
}

/**
 * Check whether a capability name exists in the standard taxonomy.
 */
export function isStandardCapability(name: string): boolean {
  const segments = name.split('.')
  let node: Record<string, unknown> = STANDARD_CAPABILITIES as Record<string, unknown>
  for (const seg of segments) {
    const child = node[seg]
    if (child === undefined) return false
    if (typeof child === 'string') return true // leaf
    node = child as Record<string, unknown>
  }
  return true // intermediate node
}

/**
 * Get all standard capabilities as a flat list of full names.
 */
export function listStandardCapabilities(): string[] {
  const result: string[] = []

  function walk(node: Record<string, unknown>, prefix: string): void {
    for (const [key, value] of Object.entries(node)) {
      const fullName = prefix ? `${prefix}.${key}` : key
      if (typeof value === 'string') {
        result.push(fullName)
      } else if (typeof value === 'object' && value !== null) {
        walk(value as Record<string, unknown>, fullName)
      }
    }
  }

  walk(STANDARD_CAPABILITIES as Record<string, unknown>, '')
  return result
}
```

#### 2.3 Capability Matcher

```typescript
// --- packages/forgeagent-core/src/registry/capability-matcher.ts ---

import type {
  CapabilityDescriptor,
  RegisteredAgent,
  DiscoveryQuery,
  ScoreBreakdown,
} from './types.js'
import { matchCapability, parseCapability } from './capability-taxonomy.js'

/**
 * Configuration for score weighting in capability matching.
 */
export interface CapabilityMatcherConfig {
  /** Weight for capability name matching (default: 0.5) */
  capabilityWeight: number
  /** Weight for semantic similarity (default: 0.3) */
  semanticWeight: number
  /** Weight for tag overlap (default: 0.1) */
  tagWeight: number
  /** Weight for health adjustment (default: 0.1) */
  healthWeight: number
}

const DEFAULT_MATCHER_CONFIG: CapabilityMatcherConfig = {
  capabilityWeight: 0.5,
  semanticWeight: 0.3,
  tagWeight: 0.1,
  healthWeight: 0.1,
}

/**
 * Scores an agent against a discovery query using deterministic matching.
 *
 * Semantic scoring is handled externally (by SemanticCapabilitySearch in
 * `@dzipagent/registry`). This matcher handles capability-name prefix matching,
 * tag overlap, and health adjustments.
 *
 * @param agent - The candidate agent to score
 * @param query - The discovery query
 * @param semanticScore - Pre-computed semantic similarity (0.0-1.0), default 0
 * @param config - Scoring weight configuration
 * @returns Combined score (0.0-1.0) and breakdown
 */
export function scoreAgent(
  agent: RegisteredAgent,
  query: DiscoveryQuery,
  semanticScore: number = 0,
  config: CapabilityMatcherConfig = DEFAULT_MATCHER_CONFIG,
): { score: number; breakdown: ScoreBreakdown } {
  // --- Capability name matching ---
  let capabilityScore = 0
  if (query.capability) {
    const matches = agent.capabilities.filter(cap =>
      matchCapability(query.capability!, cap.name),
    )
    if (matches.length > 0) {
      // Score based on match specificity: exact match = 1.0, prefix match = 0.5-0.9
      const bestMatch = matches.reduce((best, cap) => {
        const queryDepth = parseCapability(query.capability!).depth
        const capDepth = parseCapability(cap.name).depth
        const specificity = capDepth === queryDepth ? 1.0 : Math.max(0.5, 1.0 - (capDepth - queryDepth) * 0.1)
        return specificity > best ? specificity : best
      }, 0)
      capabilityScore = bestMatch
    }
  }
  if (query.capabilityExact) {
    const exact = agent.capabilities.find(cap => cap.name === query.capabilityExact!.name)
    if (exact) {
      capabilityScore = Math.max(capabilityScore, 1.0)
      // Version check: if minVersion specified, penalize if below
      if (query.capabilityExact.minVersion && exact.version < query.capabilityExact.minVersion) {
        capabilityScore *= 0.5
      }
    }
  }

  // --- Tag overlap ---
  let tagScore = 0
  if (query.tags && query.tags.length > 0) {
    const agentTags = new Set(
      agent.capabilities.flatMap(cap => cap.tags ?? []),
    )
    const matchCount = query.tags.filter(t => agentTags.has(t)).length
    tagScore = matchCount / query.tags.length
  }

  // --- Health adjustment ---
  let healthAdjustment = 0
  switch (agent.health.status) {
    case 'healthy': healthAdjustment = 0.2; break
    case 'degraded': healthAdjustment = 0.0; break
    case 'unhealthy': healthAdjustment = -0.1; break
    case 'unreachable': healthAdjustment = -0.2; break
    case 'unknown': healthAdjustment = -0.05; break
  }

  // --- Weighted combination ---
  const score = Math.max(0, Math.min(1,
    capabilityScore * config.capabilityWeight +
    semanticScore * config.semanticWeight +
    tagScore * config.tagWeight +
    healthAdjustment * config.healthWeight,
  ))

  return {
    score,
    breakdown: {
      capabilityScore,
      semanticScore,
      tagScore,
      healthAdjustment,
    },
  }
}

/**
 * Filters agents based on hard constraints in the query.
 * Returns agents that pass ALL specified filters.
 * Scoring is applied separately via `scoreAgent()`.
 */
export function filterAgents(
  agents: RegisteredAgent[],
  query: DiscoveryQuery,
): RegisteredAgent[] {
  return agents.filter(agent => {
    // Protocol filter
    if (query.protocols && query.protocols.length > 0) {
      if (!query.protocols.some(p => agent.protocols.includes(p))) return false
    }

    // Exclude IDs
    if (query.excludeIds && query.excludeIds.includes(agent.id)) return false

    // Name substring
    if (query.nameContains) {
      if (!agent.name.toLowerCase().includes(query.nameContains.toLowerCase())) return false
    }

    // Health filter
    if (query.healthFilter) {
      const hf = query.healthFilter
      if (hf.minStatus) {
        const order: Record<string, number> = {
          healthy: 4, degraded: 3, unhealthy: 2, unreachable: 1, unknown: 0,
        }
        if ((order[agent.health.status] ?? 0) < (order[hf.minStatus] ?? 0)) return false
      }
      if (hf.maxLatencyP95 !== undefined && agent.health.latency.p95 > hf.maxLatencyP95) return false
      if (hf.maxErrorRate !== undefined && agent.health.errorRate > hf.maxErrorRate) return false
      if (hf.circuitClosed && agent.health.circuitState !== 'closed') return false
    }

    // SLA filter
    if (query.slaFilter) {
      const sf = query.slaFilter
      if (sf.maxLatencyMs !== undefined && agent.sla?.maxLatencyMs !== undefined) {
        if (agent.sla.maxLatencyMs > sf.maxLatencyMs) return false
      }
      if (sf.minUptimeRatio !== undefined && agent.sla?.minUptimeRatio !== undefined) {
        if (agent.sla.minUptimeRatio < sf.minUptimeRatio) return false
      }
    }

    return true
  })
}
```

#### 2.4 Capability Versioning

Capability versions follow semver. The `capabilityExact.minVersion` field in `DiscoveryQuery` performs a simple string comparison. For a production system, a proper semver comparator should be used. The recommended approach:

```typescript
/**
 * Compare two semver strings. Returns:
 *  -1 if a < b
 *   0 if a == b
 *   1 if a > b
 *
 * Only handles major.minor.patch (no pre-release or build metadata).
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0
    const vb = pb[i] ?? 0
    if (va < vb) return -1
    if (va > vb) return 1
  }
  return 0
}
```

---

### F3: InMemoryRegistry

**Priority:** P0 | **Effort:** 4h (included with F1) | **Package:** `@dzipagent/core`

A `Map`-based implementation for development and testing. Full interface compliance, no external dependencies.

```typescript
// --- packages/forgeagent-core/src/registry/in-memory-registry.ts ---

import { randomUUID } from 'node:crypto'
import type {
  AgentRegistry,
  RegisterAgentInput,
  RegisteredAgent,
  AgentHealth,
  AgentHealthStatus,
  DiscoveryQuery,
  DiscoveryResultPage,
  DiscoveryResult,
  RegistryEvent,
  RegistrySubscriptionFilter,
  RegistryStats,
  DeregistrationReason,
} from './types.js'
import type { DzipEventBus } from '../events/event-bus.js'
import { ForgeError } from '../errors/forge-error.js'
import { scoreAgent, filterAgents } from './capability-matcher.js'

/**
 * In-memory AgentRegistry for development and testing.
 *
 * - Stores all agents in a `Map<string, RegisteredAgent>`
 * - Emits registry events through the provided `DzipEventBus`
 * - Supports TTL-based auto-deregistration via `evictExpired()`
 * - No persistence -- all data lost on process restart
 *
 * @example
 * ```ts
 * const bus = createEventBus()
 * const registry = new InMemoryRegistry(bus)
 *
 * await registry.register({
 *   name: 'my-agent',
 *   description: 'Does things',
 *   endpoint: 'http://localhost:3000',
 *   protocols: ['http'],
 *   capabilities: [{ name: 'code.generate.feature', version: '1.0.0', description: 'Generates features' }],
 *   authentication: { type: 'none' },
 *   version: '1.0.0',
 * })
 *
 * const page = await registry.discover({ capability: 'code.generate' })
 * // page.results[0].agent.name === 'my-agent'
 * ```
 */
export class InMemoryRegistry implements AgentRegistry {
  private agents = new Map<string, RegisteredAgent>()
  private eventBus: DzipEventBus

  constructor(eventBus: DzipEventBus) {
    this.eventBus = eventBus
  }

  async register(input: RegisterAgentInput): Promise<RegisteredAgent> {
    const id = input.id ?? randomUUID()

    if (this.agents.has(id)) {
      throw new ForgeError('REGISTRY_DUPLICATE', `Agent "${id}" is already registered`)
    }

    const now = new Date()
    const agent: RegisteredAgent = {
      id,
      name: input.name,
      description: input.description,
      endpoint: input.endpoint,
      protocols: input.protocols,
      capabilities: input.capabilities,
      authentication: input.authentication,
      version: input.version,
      sla: input.sla,
      metadata: input.metadata,
      ttlMs: input.ttlMs ?? 300_000,
      registeredAt: now,
      lastUpdatedAt: now,
      health: createDefaultHealth(),
    }

    this.agents.set(id, agent)
    this.emitEvent({
      type: 'registry:agent_registered',
      agentId: id,
      agentName: input.name,
      capabilities: input.capabilities.map(c => c.name),
    })

    return agent
  }

  async deregister(agentId: string, reason: DeregistrationReason = 'manual'): Promise<void> {
    if (!this.agents.has(agentId)) return // idempotent
    this.agents.delete(agentId)
    this.emitEvent({ type: 'registry:agent_deregistered', agentId, reason })
  }

  async update(agentId: string, update: Partial<RegisterAgentInput>): Promise<RegisteredAgent> {
    const existing = this.agents.get(agentId)
    if (!existing) {
      throw new ForgeError('REGISTRY_NOT_FOUND', `Agent "${agentId}" not found`)
    }

    const fields: string[] = []
    if (update.name !== undefined) { existing.name = update.name; fields.push('name') }
    if (update.description !== undefined) { existing.description = update.description; fields.push('description') }
    if (update.endpoint !== undefined) { existing.endpoint = update.endpoint; fields.push('endpoint') }
    if (update.protocols !== undefined) { existing.protocols = update.protocols; fields.push('protocols') }
    if (update.capabilities !== undefined) { existing.capabilities = update.capabilities; fields.push('capabilities') }
    if (update.authentication !== undefined) { existing.authentication = update.authentication; fields.push('authentication') }
    if (update.version !== undefined) { existing.version = update.version; fields.push('version') }
    if (update.sla !== undefined) { existing.sla = update.sla; fields.push('sla') }
    if (update.metadata !== undefined) { existing.metadata = update.metadata; fields.push('metadata') }
    if (update.ttlMs !== undefined) { existing.ttlMs = update.ttlMs; fields.push('ttlMs') }
    existing.lastUpdatedAt = new Date()

    this.emitEvent({ type: 'registry:agent_updated', agentId, fields })
    return existing
  }

  async discover(query: DiscoveryQuery): Promise<DiscoveryResultPage> {
    const start = Date.now()
    const limit = query.limit ?? 20
    const offset = query.offset ?? 0

    // Apply hard filters
    const candidates = filterAgents([...this.agents.values()], query)

    // Score remaining candidates
    const scored: DiscoveryResult[] = candidates.map(agent => {
      const { score, breakdown } = scoreAgent(agent, query)
      return { agent, matchScore: score, scoreBreakdown: breakdown }
    })

    // Sort
    const sortField = query.sortBy ?? 'relevance'
    scored.sort((a, b) => {
      switch (sortField) {
        case 'relevance': return b.matchScore - a.matchScore
        case 'latency': return a.agent.health.latency.p95 - b.agent.health.latency.p95
        case 'errorRate': return a.agent.health.errorRate - b.agent.health.errorRate
        case 'uptimeRatio': return b.agent.health.uptimeRatio - a.agent.health.uptimeRatio
        case 'registeredAt': return b.agent.registeredAt.getTime() - a.agent.registeredAt.getTime()
        case 'name': return a.agent.name.localeCompare(b.agent.name)
        default: return b.matchScore - a.matchScore
      }
    })

    const total = scored.length
    const page = scored.slice(offset, offset + limit)
    const queryTimeMs = Date.now() - start

    this.emitEvent({
      type: 'registry:query_executed',
      query,
      resultCount: page.length,
      queryTimeMs,
    })

    return { results: page, total, limit, offset, queryTimeMs }
  }

  async getAgent(agentId: string): Promise<RegisteredAgent | null> {
    return this.agents.get(agentId) ?? null
  }

  async getHealth(agentId: string): Promise<AgentHealth | null> {
    const agent = this.agents.get(agentId)
    return agent?.health ?? null
  }

  async updateHealth(agentId: string, healthUpdate: Partial<AgentHealth>): Promise<void> {
    const agent = this.agents.get(agentId)
    if (!agent) return

    const previousStatus = agent.health.status
    Object.assign(agent.health, healthUpdate)
    agent.lastUpdatedAt = new Date()

    if (healthUpdate.status && healthUpdate.status !== previousStatus) {
      this.emitEvent({
        type: 'registry:health_changed',
        agentId,
        previousStatus,
        newStatus: healthUpdate.status,
      })
    }
  }

  subscribe(
    handler: (event: RegistryEvent) => void | Promise<void>,
    filter?: RegistrySubscriptionFilter,
  ): () => void {
    // Registry events are a subset of DzipEvent. Subscribe to all registry:* types
    // and apply the filter locally.
    const registryTypes: RegistryEvent['type'][] = [
      'registry:agent_registered',
      'registry:agent_deregistered',
      'registry:agent_updated',
      'registry:health_changed',
      'registry:query_executed',
    ]

    const unsubs = registryTypes.map(eventType =>
      this.eventBus.on(eventType, (event) => {
        const re = event as unknown as RegistryEvent
        if (this.matchesFilter(re, filter)) {
          handler(re)
        }
      }),
    )

    return () => { unsubs.forEach(fn => fn()) }
  }

  async listAgents(
    limit: number = 100,
    offset: number = 0,
  ): Promise<{ agents: RegisteredAgent[]; total: number }> {
    const all = [...this.agents.values()]
    return {
      agents: all.slice(offset, offset + limit),
      total: all.length,
    }
  }

  async registerFromCard(
    cardUrl: string,
    overrides?: Partial<RegisterAgentInput>,
  ): Promise<RegisteredAgent> {
    // Resolve the card URL -- try both /.well-known/agent-card.json and /.well-known/agent.json
    let cardData: Record<string, unknown>
    try {
      const response = await fetch(cardUrl)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      cardData = (await response.json()) as Record<string, unknown>
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ForgeError('REGISTRY_FETCH_FAILED', `Failed to fetch agent card from ${cardUrl}: ${message}`)
    }

    // Validate minimum required fields
    if (!cardData['name'] || !cardData['url']) {
      throw new ForgeError('REGISTRY_INVALID_CARD', 'Agent card must have at least "name" and "url" fields')
    }

    // Convert Agent Card format to RegisterAgentInput
    const capabilities = Array.isArray(cardData['capabilities'])
      ? (cardData['capabilities'] as Array<Record<string, unknown>>).map(cap => ({
          name: String(cap['name'] ?? ''),
          version: String(cap['version'] ?? '1.0.0'),
          description: String(cap['description'] ?? ''),
          inputSchema: cap['inputSchema'] as Record<string, unknown> | undefined,
          outputSchema: cap['outputSchema'] as Record<string, unknown> | undefined,
          tags: cap['tags'] as string[] | undefined,
        }))
      : []

    const input: RegisterAgentInput = {
      name: String(cardData['name']),
      description: String(cardData['description'] ?? ''),
      endpoint: String(cardData['url']),
      protocols: ['http'], // default, can be overridden
      capabilities,
      authentication: (cardData['authentication'] as RegisterAgentInput['authentication']) ?? { type: 'none' },
      version: String(cardData['version'] ?? '1.0.0'),
      ...overrides,
    }

    return this.register(input)
  }

  async evictExpired(): Promise<string[]> {
    const now = Date.now()
    const evicted: string[] = []

    for (const [id, agent] of this.agents) {
      if (agent.ttlMs > 0) {
        const elapsed = now - agent.lastUpdatedAt.getTime()
        if (elapsed > agent.ttlMs) {
          evicted.push(id)
          this.agents.delete(id)
          this.emitEvent({ type: 'registry:agent_deregistered', agentId: id, reason: 'ttl_expired' })
        }
      }
    }

    return evicted
  }

  async stats(): Promise<RegistryStats> {
    const agents = [...this.agents.values()]
    const byStatus = (s: AgentHealthStatus) => agents.filter(a => a.health.status === s).length
    const capSet = new Set<string>()
    let totalP50 = 0
    let totalP95 = 0

    for (const a of agents) {
      for (const c of a.capabilities) capSet.add(c.name)
      totalP50 += a.health.latency.p50
      totalP95 += a.health.latency.p95
    }

    const count = agents.length || 1
    return {
      totalAgents: agents.length,
      healthyAgents: byStatus('healthy'),
      degradedAgents: byStatus('degraded'),
      unhealthyAgents: byStatus('unhealthy'),
      unreachableAgents: byStatus('unreachable'),
      capabilityCount: capSet.size,
      avgLatencyP50: totalP50 / count,
      avgLatencyP95: totalP95 / count,
    }
  }

  // --- Private helpers ---

  private emitEvent(event: RegistryEvent): void {
    this.eventBus.emit(event as unknown as import('../events/event-types.js').DzipEvent)
  }

  private matchesFilter(event: RegistryEvent, filter?: RegistrySubscriptionFilter): boolean {
    if (!filter) return true
    if (filter.eventTypes && !filter.eventTypes.includes(event.type)) return false
    if (filter.agentIds && 'agentId' in event && !filter.agentIds.includes(event.agentId)) return false
    if (filter.capabilities && event.type === 'registry:agent_registered') {
      const caps = event.capabilities
      if (!filter.capabilities.some(fc => caps.some(ac => ac.startsWith(fc)))) return false
    }
    return true
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function createDefaultHealth(): AgentHealth {
  return {
    status: 'unknown',
    lastCheckedAt: null,
    lastSuccessAt: null,
    latency: { p50: 0, p95: 0, p99: 0 },
    errorRate: 0,
    consecutiveSuccesses: 0,
    consecutiveFailures: 0,
    uptimeRatio: 0,
    circuitState: 'closed',
  }
}
```

---

### F4: PostgresRegistry

**Priority:** P1 | **Effort:** 8h | **Package:** `@dzipagent/server`

Persistent registry backed by Drizzle ORM. Extends the existing `forge_*` schema with two new tables and uses GIN indexes on the capabilities JSONB column for efficient querying.

#### 4.1 Drizzle Schema

```typescript
// --- packages/forgeagent-server/src/persistence/registry-schema.ts ---

import {
  pgTable,
  uuid,
  varchar,
  text,
  real,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core'

/**
 * Registry of agents available for discovery.
 *
 * Separate from `dzip_agents` (which stores agent *definitions* for this server).
 * `forge_registry_agents` stores *external* agents registered for discovery
 * by the orchestrator and other consumers.
 */
export const forgeRegistryAgents = pgTable('forge_registry_agents', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description').notNull(),
  endpoint: varchar('endpoint', { length: 2048 }).notNull(),
  protocols: jsonb('protocols').$type<string[]>().notNull().default([]),
  capabilities: jsonb('capabilities').$type<Array<{
    name: string
    version: string
    description: string
    inputSchema?: Record<string, unknown>
    outputSchema?: Record<string, unknown>
    tags?: string[]
  }>>().notNull().default([]),
  /** Flattened capability names for GIN indexing */
  capabilityNames: jsonb('capability_names').$type<string[]>().notNull().default([]),
  /** Flattened tags from all capabilities for GIN indexing */
  capabilityTags: jsonb('capability_tags').$type<string[]>().notNull().default([]),
  authentication: jsonb('authentication').$type<{
    type: string
    tokenUrl?: string
    scopes?: string[]
  }>().notNull().default({ type: 'none' }),
  version: varchar('version', { length: 50 }).notNull(),
  sla: jsonb('sla').$type<{
    maxLatencyMs?: number
    minUptimeRatio?: number
    maxErrorRate?: number
    maxRps?: number
  }>(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  ttlMs: integer('ttl_ms').notNull().default(300_000),
  /** Embedding vector for semantic search (stored as float array) */
  embedding: jsonb('embedding').$type<number[]>(),
  registeredAt: timestamp('registered_at').defaultNow().notNull(),
  lastUpdatedAt: timestamp('last_updated_at').defaultNow().notNull(),
}, (table) => ({
  // GIN index on capability names for @> (contains) queries
  capabilityNamesIdx: index('idx_registry_capability_names').using('gin', table.capabilityNames),
  // GIN index on tags for tag-based discovery
  capabilityTagsIdx: index('idx_registry_capability_tags').using('gin', table.capabilityTags),
  // B-tree index on endpoint for dedup checks
  endpointIdx: index('idx_registry_endpoint').on(table.endpoint),
  // B-tree index on name for name searches
  nameIdx: index('idx_registry_name').on(table.name),
}))

/**
 * Health probe history for registered agents.
 *
 * Stores individual probe results. Aggregated stats (p50, p95, error rate)
 * are computed from recent rows when updating the agent's health snapshot.
 */
export const forgeRegistryHealth = pgTable('forge_registry_health', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: uuid('agent_id')
    .references(() => forgeRegistryAgents.id, { onDelete: 'cascade' })
    .notNull(),
  /** Whether this probe succeeded */
  success: boolean('success').notNull(),
  /** Response latency in ms */
  latencyMs: real('latency_ms'),
  /** HTTP status code, if applicable */
  statusCode: integer('status_code'),
  /** Error message, if probe failed */
  errorMessage: text('error_message'),
  /** Timestamp of this probe */
  probedAt: timestamp('probed_at').defaultNow().notNull(),
}, (table) => ({
  // Index for efficient aggregation queries per agent
  agentTimeIdx: index('idx_registry_health_agent_time').on(table.agentId, table.probedAt),
}))

/**
 * Agent card version history (for F7: Agent Card Versioning).
 */
export const forgeRegistryCardVersions = pgTable('forge_registry_card_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: uuid('agent_id')
    .references(() => forgeRegistryAgents.id, { onDelete: 'cascade' })
    .notNull(),
  version: varchar('version', { length: 50 }).notNull(),
  card: jsonb('card').$type<Record<string, unknown>>().notNull(),
  /** Whether this version is deprecated */
  deprecated: boolean('deprecated').default(false).notNull(),
  deprecationMessage: text('deprecation_message'),
  /** What changed from the previous version */
  changeType: varchar('change_type', { length: 20 }).$type<'major' | 'minor' | 'patch'>(),
  changeSummary: text('change_summary'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  agentVersionIdx: index('idx_registry_card_versions_agent').on(table.agentId, table.version),
}))
```

#### 4.2 PostgresRegistry Implementation Outline

The `PostgresRegistry` class implements `AgentRegistry` using Drizzle queries. Key design points:

- **Capability name denormalization**: On `register()` and `update()`, the `capabilityNames` and `capabilityTags` JSONB columns are populated as flat arrays extracted from the `capabilities` JSONB. This enables efficient GIN index queries without needing to unnest nested JSON.

- **Discovery query translation**: `discover()` builds a Drizzle `where` clause from `DiscoveryQuery` filters. Capability prefix matching uses `sql\`capability_names ?| array[${prefixes}]\`` (the `?|` operator checks if any array element matches, leveraging the GIN index). Tag matching uses the same operator on `capabilityTags`.

- **Health aggregation**: `updateHealth()` queries the last N rows from `forge_registry_health` for the agent, computes p50/p95/p99 latencies, and writes the aggregated snapshot back to `forge_registry_agents` (or a separate column). The sliding window size is configurable (default: 100 probes).

- **Pagination**: All list/discover operations use SQL `LIMIT`/`OFFSET`. Total count is computed with a separate `COUNT(*)` query (or a window function for single-query pagination).

- **Transaction safety**: `register()` uses `INSERT ... ON CONFLICT DO NOTHING` with a subsequent check to distinguish "inserted" from "already exists" without race conditions.

```typescript
// --- packages/forgeagent-server/src/registry/postgres-registry.ts ---

// Implementation signature (full implementation deferred to forgeagent-server-dev agent)

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type {
  AgentRegistry,
  RegisterAgentInput,
  RegisteredAgent,
  AgentHealth,
  DiscoveryQuery,
  DiscoveryResultPage,
  RegistryEvent,
  RegistrySubscriptionFilter,
  RegistryStats,
  DeregistrationReason,
} from '@dzipagent/core'
import type { DzipEventBus } from '@dzipagent/core'

type DB = PostgresJsDatabase<Record<string, never>>

export interface PostgresRegistryConfig {
  /** Drizzle database instance */
  db: DB
  /** Event bus for registry events */
  eventBus: DzipEventBus
  /** Number of recent health probes to aggregate (default: 100) */
  healthWindowSize?: number
  /** Whether to compute embeddings on registration for semantic search (default: false) */
  enableEmbeddings?: boolean
  /** Embedding function, required if enableEmbeddings is true */
  embedFn?: (text: string) => Promise<number[]>
}

/**
 * PostgreSQL-backed AgentRegistry using Drizzle ORM.
 *
 * Features:
 * - GIN-indexed capability and tag search
 * - Health probe history with aggregated statistics
 * - Optional embedding computation for semantic search
 * - Transactional registration with conflict detection
 * - Agent card version history
 */
export class PostgresRegistry implements AgentRegistry {
  constructor(private config: PostgresRegistryConfig) {}

  // All AgentRegistry methods implemented against Drizzle schema.
  // Implementation delegated to forgeagent-server-dev agent.
  // See F4 acceptance criteria below.

  async register(_input: RegisterAgentInput): Promise<RegisteredAgent> { throw new Error('Not implemented') }
  async deregister(_agentId: string, _reason?: DeregistrationReason): Promise<void> { throw new Error('Not implemented') }
  async update(_agentId: string, _update: Partial<RegisterAgentInput>): Promise<RegisteredAgent> { throw new Error('Not implemented') }
  async discover(_query: DiscoveryQuery): Promise<DiscoveryResultPage> { throw new Error('Not implemented') }
  async getAgent(_agentId: string): Promise<RegisteredAgent | null> { throw new Error('Not implemented') }
  async getHealth(_agentId: string): Promise<AgentHealth | null> { throw new Error('Not implemented') }
  async updateHealth(_agentId: string, _health: Partial<AgentHealth>): Promise<void> { throw new Error('Not implemented') }
  subscribe(
    _handler: (event: RegistryEvent) => void | Promise<void>,
    _filter?: RegistrySubscriptionFilter,
  ): () => void { throw new Error('Not implemented') }
  async listAgents(_limit?: number, _offset?: number): Promise<{ agents: RegisteredAgent[]; total: number }> { throw new Error('Not implemented') }
  async registerFromCard(_cardUrl: string, _overrides?: Partial<RegisterAgentInput>): Promise<RegisteredAgent> { throw new Error('Not implemented') }
  async evictExpired(): Promise<string[]> { throw new Error('Not implemented') }
  async stats(): Promise<RegistryStats> { throw new Error('Not implemented') }
}
```

#### 4.3 Acceptance Criteria for F4 Implementation

1. All `AgentRegistry` interface methods are implemented.
2. `register()` inserts into `forge_registry_agents` with denormalized `capabilityNames` and `capabilityTags`.
3. `discover()` uses GIN index queries for capability/tag filtering.
4. `discover()` supports all `DiscoveryQuery` fields including pagination, sorting, health/SLA filters.
5. `updateHealth()` reads last N probes from `forge_registry_health`, computes percentiles, writes aggregated snapshot.
6. `evictExpired()` deletes agents whose `lastUpdatedAt + ttlMs < now`.
7. All mutations emit `RegistryEvent`s through `DzipEventBus`.
8. TypeScript strict mode, no `any`.
9. Tests pass with a real Postgres (via testcontainers or test database).

---

### F5: Semantic Capability Search

**Priority:** P1 | **Effort:** 8h | **Package:** `@dzipagent/registry`

Enables natural-language discovery: "find an agent that can review TypeScript code for security issues" resolves to agents with `code.review.security` capability and TypeScript tags.

#### 5.1 Architecture

Semantic search operates as an enhancement layer on top of the base `AgentRegistry`. It does not replace capability-name matching -- it supplements it for cases where the caller does not know the exact taxonomy.

```
Caller
  │
  │ DiscoveryQuery { semanticQuery: "review TS security" }
  │
  ▼
SemanticCapabilitySearch
  │
  ├──► Embed query text ──► embedding vector
  │
  ├──► Vector search against agent embeddings ──► ranked agent IDs + scores
  │
  ├──► Merge with AgentRegistry.discover() results
  │        (combine semantic scores with capability/tag/health scores)
  │
  └──► Return DiscoveryResultPage with fused ranking
```

#### 5.2 Interface

```typescript
// --- packages/forgeagent-registry/src/semantic-search.ts ---

import type {
  AgentRegistry,
  DiscoveryQuery,
  DiscoveryResultPage,
  RegisteredAgent,
} from '@dzipagent/core'

/**
 * Configuration for semantic capability search.
 */
export interface SemanticSearchConfig {
  /** Underlying registry to enhance with semantic search */
  registry: AgentRegistry
  /** Function to compute embedding vectors from text */
  embedFn: (text: string) => Promise<number[]>
  /** Vector similarity search function. Returns agent IDs sorted by similarity. */
  vectorSearch: (embedding: number[], limit: number) => Promise<Array<{ agentId: string; similarity: number }>>
  /** Function to index an agent's capabilities as an embedding */
  indexAgent: (agentId: string, text: string, embedding: number[]) => Promise<void>
  /** Function to remove an agent's embedding from the index */
  removeAgent: (agentId: string) => Promise<void>
  /** Weight for semantic score in final ranking (default: 0.3) */
  semanticWeight?: number
  /** Minimum semantic similarity threshold (default: 0.4) */
  minSimilarity?: number
}

/**
 * Enhances an AgentRegistry with embedding-based semantic discovery.
 *
 * This is a decorator/wrapper, not a registry implementation. It:
 * 1. Listens for `registry:agent_registered` events to auto-index new agents
 * 2. Listens for `registry:agent_deregistered` events to remove from index
 * 3. Intercepts `discover()` calls with `semanticQuery` to add semantic scoring
 *
 * @example
 * ```ts
 * const semanticSearch = new SemanticCapabilitySearch({
 *   registry: postgresRegistry,
 *   embedFn: openaiEmbed,
 *   vectorSearch: qdrantSearch,
 *   indexAgent: qdrantUpsert,
 *   removeAgent: qdrantDelete,
 * })
 *
 * // On registration, capabilities are auto-embedded
 * await semanticSearch.onAgentRegistered(agent)
 *
 * // Discovery with semantic query
 * const results = await semanticSearch.discover({
 *   semanticQuery: 'find agent that reviews TypeScript code for security',
 *   healthFilter: { minStatus: 'healthy' },
 * })
 * ```
 */
export class SemanticCapabilitySearch {
  private config: Required<SemanticSearchConfig>

  constructor(config: SemanticSearchConfig) {
    this.config = {
      ...config,
      semanticWeight: config.semanticWeight ?? 0.3,
      minSimilarity: config.minSimilarity ?? 0.4,
    }
  }

  /**
   * Build a searchable text representation of an agent's capabilities.
   * Combines name, description, capability names, descriptions, and tags.
   */
  buildAgentText(agent: RegisteredAgent): string {
    const parts = [
      agent.name,
      agent.description,
      ...agent.capabilities.map(c => `${c.name}: ${c.description}`),
      ...agent.capabilities.flatMap(c => c.tags ?? []),
    ]
    return parts.join(' | ')
  }

  /**
   * Index an agent for semantic search. Called on registration.
   */
  async onAgentRegistered(agent: RegisteredAgent): Promise<void> {
    const text = this.buildAgentText(agent)
    const embedding = await this.config.embedFn(text)
    await this.config.indexAgent(agent.id, text, embedding)
  }

  /**
   * Remove an agent from the semantic index. Called on deregistration.
   */
  async onAgentDeregistered(agentId: string): Promise<void> {
    await this.config.removeAgent(agentId)
  }

  /**
   * Enhanced discovery that fuses semantic similarity with registry results.
   */
  async discover(query: DiscoveryQuery): Promise<DiscoveryResultPage> {
    // If no semantic query, delegate entirely to base registry
    if (!query.semanticQuery) {
      return this.config.registry.discover(query)
    }

    // Step 1: Get semantic matches
    const queryEmbedding = await this.config.embedFn(query.semanticQuery)
    const limit = (query.limit ?? 20) * 3 // over-fetch for fusion
    const semanticHits = await this.config.vectorSearch(queryEmbedding, limit)

    // Step 2: Get base registry results (without semantic, to avoid recursion)
    const baseQuery = { ...query, semanticQuery: undefined }
    const baseResults = await this.config.registry.discover({
      ...baseQuery,
      limit: limit,
    })

    // Step 3: Build semantic score map
    const semanticScores = new Map(
      semanticHits
        .filter(h => h.similarity >= this.config.minSimilarity)
        .map(h => [h.agentId, h.similarity]),
    )

    // Step 4: Fuse scores -- re-score base results with semantic signal
    const fused = baseResults.results.map(result => {
      const semScore = semanticScores.get(result.agent.id) ?? 0
      const adjustedScore =
        result.matchScore * (1 - this.config.semanticWeight) +
        semScore * this.config.semanticWeight

      return {
        ...result,
        matchScore: adjustedScore,
        scoreBreakdown: {
          ...result.scoreBreakdown,
          semanticScore: semScore,
        },
      }
    })

    // Step 5: Include semantic-only hits not in base results
    const baseIds = new Set(baseResults.results.map(r => r.agent.id))
    for (const [agentId, similarity] of semanticScores) {
      if (!baseIds.has(agentId)) {
        const agent = await this.config.registry.getAgent(agentId)
        if (agent) {
          fused.push({
            agent,
            matchScore: similarity * this.config.semanticWeight,
            scoreBreakdown: {
              capabilityScore: 0,
              semanticScore: similarity,
              tagScore: 0,
              healthAdjustment: 0,
            },
          })
        }
      }
    }

    // Step 6: Sort and paginate
    fused.sort((a, b) => b.matchScore - a.matchScore)
    const offset = query.offset ?? 0
    const pageLimit = query.limit ?? 20
    const page = fused.slice(offset, offset + pageLimit)

    return {
      results: page,
      total: fused.length,
      limit: pageLimit,
      offset,
      queryTimeMs: baseResults.queryTimeMs,
    }
  }
}
```

#### 5.3 Embedding Strategy

The text indexed for each agent is a concatenation of:
1. Agent name
2. Agent description
3. Each capability as `"capability.name: capability description"`
4. All tags across all capabilities

This produces a single embedding per agent. When the agent's capabilities change, the embedding is recomputed and updated.

For the embedding function itself, the system uses whatever `embedFn` is injected -- typically OpenAI `text-embedding-3-small` or a local model. The vector store can be Qdrant (already used in the RAG subsystem), pgvector, or an in-memory HNSW index for development.

---

### F6: Health Monitoring

**Priority:** P1 | **Effort:** 6h | **Package:** `@dzipagent/core` (interface + types), `@dzipagent/server` (scheduler)

Periodic health probing for registered agents. Integrates with the existing `CircuitBreaker` from `@dzipagent/core` and the `HealthAggregator` pattern.

#### 6.1 Health Monitor Interface and Implementation

```typescript
// --- packages/forgeagent-core/src/registry/health-monitor.ts ---

import type { AgentRegistry, RegisteredAgent, AgentHealth, AgentHealthStatus } from './types.js'
import type { DzipEventBus } from '../events/event-bus.js'
import { CircuitBreaker } from '../llm/circuit-breaker.js'

/**
 * Configuration for the health monitoring subsystem.
 */
export interface HealthMonitorConfig {
  /** Registry to monitor */
  registry: AgentRegistry
  /** Event bus for health events */
  eventBus: DzipEventBus
  /** Interval between probe cycles in ms (default: 30_000) */
  probeIntervalMs?: number
  /** Timeout for individual health probes in ms (default: 5_000) */
  probeTimeoutMs?: number
  /** Number of recent probes to keep in the sliding window (default: 100) */
  slidingWindowSize?: number
  /** Number of consecutive failures before marking as unhealthy (default: 3) */
  unhealthyThreshold?: number
  /** Number of consecutive failures before opening circuit (default: 5) */
  circuitBreakerThreshold?: number
  /** Time in ms before circuit breaker transitions to half-open (default: 60_000) */
  circuitResetMs?: number
  /**
   * Custom probe function. If not provided, sends GET to `{agent.endpoint}/health`.
   * Must return `{ ok: boolean; latencyMs: number; statusCode?: number }`.
   */
  probeFn?: (agent: RegisteredAgent) => Promise<ProbeResult>
  /** Whether to auto-evict expired TTL agents during probe cycles (default: true) */
  autoEvict?: boolean
}

export interface ProbeResult {
  ok: boolean
  latencyMs: number
  statusCode?: number
  errorMessage?: string
}

/**
 * Sliding window of probe results for computing aggregated health stats.
 */
interface ProbeWindow {
  results: ProbeResult[]
  maxSize: number
}

/**
 * Monitors the health of agents registered in an AgentRegistry.
 *
 * On each probe cycle:
 * 1. Lists all registered agents
 * 2. Sends a health probe to each (GET /health by default)
 * 3. Records the result in a sliding window
 * 4. Computes p50/p95/p99 latency, error rate, uptime ratio
 * 5. Updates the circuit breaker state
 * 6. Writes the aggregated health snapshot via registry.updateHealth()
 * 7. Optionally evicts expired TTL agents
 *
 * @example
 * ```ts
 * const monitor = new HealthMonitor({
 *   registry,
 *   eventBus,
 *   probeIntervalMs: 30_000,
 * })
 *
 * monitor.start()    // begins periodic probing
 * monitor.stop()     // stops the loop
 * await monitor.probeAll()  // manual probe
 * ```
 */
export class HealthMonitor {
  private config: Required<HealthMonitorConfig>
  private windows = new Map<string, ProbeWindow>()
  private breakers = new Map<string, CircuitBreaker>()
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(config: HealthMonitorConfig) {
    this.config = {
      registry: config.registry,
      eventBus: config.eventBus,
      probeIntervalMs: config.probeIntervalMs ?? 30_000,
      probeTimeoutMs: config.probeTimeoutMs ?? 5_000,
      slidingWindowSize: config.slidingWindowSize ?? 100,
      unhealthyThreshold: config.unhealthyThreshold ?? 3,
      circuitBreakerThreshold: config.circuitBreakerThreshold ?? 5,
      circuitResetMs: config.circuitResetMs ?? 60_000,
      probeFn: config.probeFn ?? defaultProbeFn(config.probeTimeoutMs ?? 5_000),
      autoEvict: config.autoEvict ?? true,
    }
  }

  /** Start periodic health probing. */
  start(): void {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => {
      this.probeAll().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        // eslint-disable-next-line no-console
        console.error(`[HealthMonitor] probe cycle failed: ${msg}`)
      })
    }, this.config.probeIntervalMs)
  }

  /** Stop periodic probing. */
  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Run a single probe cycle across all registered agents. */
  async probeAll(): Promise<void> {
    // Evict expired agents first
    if (this.config.autoEvict) {
      await this.config.registry.evictExpired()
    }

    const { agents } = await this.config.registry.listAgents(10_000, 0)

    // Probe in parallel with concurrency limit
    const CONCURRENCY = 20
    for (let i = 0; i < agents.length; i += CONCURRENCY) {
      const batch = agents.slice(i, i + CONCURRENCY)
      await Promise.allSettled(batch.map(agent => this.probeAgent(agent)))
    }
  }

  /** Probe a single agent and update its health record. */
  async probeAgent(agent: RegisteredAgent): Promise<void> {
    const breaker = this.getBreaker(agent.id)

    // If circuit is open, record a synthetic failure
    if (!breaker.canExecute()) {
      this.recordProbe(agent.id, { ok: false, latencyMs: 0, errorMessage: 'Circuit open' })
      await this.updateAgentHealth(agent.id)
      return
    }

    try {
      const result = await this.config.probeFn(agent)
      this.recordProbe(agent.id, result)

      if (result.ok) {
        breaker.recordSuccess()
      } else {
        breaker.recordFailure()
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.recordProbe(agent.id, { ok: false, latencyMs: 0, errorMessage: message })
      breaker.recordFailure()
    }

    await this.updateAgentHealth(agent.id)
  }

  /** Get current health stats for an agent from the sliding window. */
  getWindowStats(agentId: string): {
    p50: number
    p95: number
    p99: number
    errorRate: number
    consecutiveSuccesses: number
    consecutiveFailures: number
  } | null {
    const window = this.windows.get(agentId)
    if (!window || window.results.length === 0) return null

    const results = window.results
    const successfulLatencies = results
      .filter(r => r.ok)
      .map(r => r.latencyMs)
      .sort((a, b) => a - b)

    const p50 = percentile(successfulLatencies, 0.50)
    const p95 = percentile(successfulLatencies, 0.95)
    const p99 = percentile(successfulLatencies, 0.99)
    const errorRate = results.filter(r => !r.ok).length / results.length

    // Consecutive counts from the tail
    let consecutiveSuccesses = 0
    let consecutiveFailures = 0
    for (let i = results.length - 1; i >= 0; i--) {
      if (results[i]!.ok) {
        if (consecutiveFailures > 0) break
        consecutiveSuccesses++
      } else {
        if (consecutiveSuccesses > 0) break
        consecutiveFailures++
      }
    }

    return { p50, p95, p99, errorRate, consecutiveSuccesses, consecutiveFailures }
  }

  // --- Private ---

  private getBreaker(agentId: string): CircuitBreaker {
    let breaker = this.breakers.get(agentId)
    if (!breaker) {
      breaker = new CircuitBreaker({
        failureThreshold: this.config.circuitBreakerThreshold,
        resetTimeoutMs: this.config.circuitResetMs,
        halfOpenMaxAttempts: 1,
      })
      this.breakers.set(agentId, breaker)
    }
    return breaker
  }

  private recordProbe(agentId: string, result: ProbeResult): void {
    let window = this.windows.get(agentId)
    if (!window) {
      window = { results: [], maxSize: this.config.slidingWindowSize }
      this.windows.set(agentId, window)
    }
    window.results.push(result)
    if (window.results.length > window.maxSize) {
      window.results.shift()
    }
  }

  private async updateAgentHealth(agentId: string): Promise<void> {
    const stats = this.getWindowStats(agentId)
    if (!stats) return

    const breaker = this.getBreaker(agentId)
    const status = this.deriveStatus(stats, breaker)

    const healthUpdate: Partial<AgentHealth> = {
      status,
      lastCheckedAt: new Date(),
      latency: { p50: stats.p50, p95: stats.p95, p99: stats.p99 },
      errorRate: stats.errorRate,
      consecutiveSuccesses: stats.consecutiveSuccesses,
      consecutiveFailures: stats.consecutiveFailures,
      circuitState: breaker.getState(),
    }

    if (stats.consecutiveSuccesses > 0) {
      healthUpdate.lastSuccessAt = new Date()
    }

    await this.config.registry.updateHealth(agentId, healthUpdate)
  }

  private deriveStatus(
    stats: NonNullable<ReturnType<HealthMonitor['getWindowStats']>>,
    breaker: CircuitBreaker,
  ): AgentHealthStatus {
    if (breaker.getState() === 'open') return 'unreachable'
    if (stats.consecutiveFailures >= this.config.unhealthyThreshold) return 'unhealthy'
    if (stats.errorRate > 0.1) return 'degraded'
    if (stats.consecutiveFailures > 0) return 'degraded'
    return 'healthy'
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function defaultProbeFn(timeoutMs: number): (agent: RegisteredAgent) => Promise<ProbeResult> {
  return async (agent) => {
    const url = `${agent.endpoint.replace(/\/$/, '')}/health`
    const start = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(url, { signal: controller.signal })
      const latencyMs = Date.now() - start
      return {
        ok: res.ok,
        latencyMs,
        statusCode: res.status,
      }
    } catch (err) {
      const latencyMs = Date.now() - start
      return {
        ok: false,
        latencyMs,
        errorMessage: err instanceof Error ? err.message : String(err),
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil(p * sorted.length) - 1
  return sorted[Math.max(0, idx)]!
}
```

---

### F7: Agent Card Versioning

**Priority:** P2 | **Effort:** 4h | **Package:** `@dzipagent/server`

Tracks version history for agent cards, detects breaking changes, and supports deprecation notices.

```typescript
// --- packages/forgeagent-server/src/registry/card-versioning.ts ---

import type { RegisteredAgent, CapabilityDescriptor } from '@dzipagent/core'

/**
 * A versioned agent card snapshot.
 */
export interface AgentCardVersion {
  agentId: string
  version: string
  card: RegisteredAgent
  changeType: 'major' | 'minor' | 'patch'
  changeSummary: string
  deprecated: boolean
  deprecationMessage?: string
  createdAt: Date
}

/**
 * Result of comparing two agent card versions.
 */
export interface CardDiff {
  /** Whether this is a breaking change */
  breaking: boolean
  /** Overall change classification */
  changeType: 'major' | 'minor' | 'patch'
  /** Human-readable summary */
  summary: string
  /** Individual changes detected */
  changes: CardChange[]
}

export interface CardChange {
  field: string
  type: 'added' | 'removed' | 'modified'
  breaking: boolean
  description: string
}

/**
 * Detects changes between two agent card versions.
 *
 * Breaking changes (major):
 * - Removing a capability
 * - Changing a capability's inputSchema incompatibly
 * - Changing endpoint URL
 * - Changing authentication type to a stricter mode
 *
 * Non-breaking additions (minor):
 * - Adding a new capability
 * - Adding optional fields to inputSchema
 * - Adding new tags
 *
 * Metadata-only changes (patch):
 * - Description changes
 * - Tag reordering
 * - Metadata changes
 *
 * @param previous - The previous version of the agent card
 * @param current - The current version of the agent card
 * @returns A diff describing all changes and whether they are breaking
 */
export function diffAgentCards(
  previous: RegisteredAgent,
  current: RegisteredAgent,
): CardDiff {
  const changes: CardChange[] = []

  // Check endpoint change
  if (previous.endpoint !== current.endpoint) {
    changes.push({
      field: 'endpoint',
      type: 'modified',
      breaking: true,
      description: `Endpoint changed from "${previous.endpoint}" to "${current.endpoint}"`,
    })
  }

  // Check authentication change
  if (previous.authentication.type !== current.authentication.type) {
    const strictOrder = ['none', 'api-key', 'bearer', 'oauth2', 'mtls', 'delegation-token']
    const prevIdx = strictOrder.indexOf(previous.authentication.type)
    const currIdx = strictOrder.indexOf(current.authentication.type)
    const breaking = currIdx > prevIdx // stricter auth = breaking
    changes.push({
      field: 'authentication',
      type: 'modified',
      breaking,
      description: `Authentication changed from "${previous.authentication.type}" to "${current.authentication.type}"`,
    })
  }

  // Check capability removals (breaking)
  const prevCaps = new Map(previous.capabilities.map(c => [c.name, c]))
  const currCaps = new Map(current.capabilities.map(c => [c.name, c]))

  for (const [name] of prevCaps) {
    if (!currCaps.has(name)) {
      changes.push({
        field: `capabilities.${name}`,
        type: 'removed',
        breaking: true,
        description: `Capability "${name}" was removed`,
      })
    }
  }

  // Check capability additions (non-breaking)
  for (const [name, cap] of currCaps) {
    if (!prevCaps.has(name)) {
      changes.push({
        field: `capabilities.${name}`,
        type: 'added',
        breaking: false,
        description: `Capability "${name}" was added: ${cap.description}`,
      })
    }
  }

  // Determine overall change type
  const hasBreaking = changes.some(c => c.breaking)
  const hasAdditions = changes.some(c => c.type === 'added')
  const changeType: CardDiff['changeType'] = hasBreaking ? 'major' : hasAdditions ? 'minor' : 'patch'

  // Build summary
  const parts: string[] = []
  const removals = changes.filter(c => c.type === 'removed').length
  const additions = changes.filter(c => c.type === 'added').length
  const modifications = changes.filter(c => c.type === 'modified').length
  if (removals > 0) parts.push(`${removals} removal(s)`)
  if (additions > 0) parts.push(`${additions} addition(s)`)
  if (modifications > 0) parts.push(`${modifications} modification(s)`)

  return {
    breaking: hasBreaking,
    changeType,
    summary: parts.length > 0 ? parts.join(', ') : 'No changes detected',
    changes,
  }
}

/**
 * Interface for persisting agent card version history.
 * Implemented by PostgresRegistry using the forge_registry_card_versions table.
 */
export interface CardVersionStore {
  /** Record a new version of an agent card */
  saveVersion(version: AgentCardVersion): Promise<void>
  /** Get all versions for an agent, newest first */
  getVersions(agentId: string): Promise<AgentCardVersion[]>
  /** Get a specific version */
  getVersion(agentId: string, version: string): Promise<AgentCardVersion | null>
  /** Mark a version as deprecated */
  deprecateVersion(agentId: string, version: string, message: string): Promise<void>
}
```

---

### F8: Registry Federation

**Priority:** P3 | **Effort:** 16h | **Package:** `@dzipagent/registry`

Enables synchronization between multiple registry instances across clusters, organizations, or public registries like a2aregistry.org.

#### 8.1 Architecture

Federation uses a hub-and-spoke or mesh model:

```
  Registry A                    Registry B
  (local)                       (remote)
      │                             │
      ├──── Pull sync ─────────────►│
      │◄──── Push notification ─────┤
      │                             │
      ├──── Conflict resolution ────┤
      │     (last-write-wins or     │
      │      source-priority)       │
      │                             │
  Local agents                 Remote agents
  + synced copies              + synced copies
  from B                       from A
```

#### 8.2 Interface

```typescript
// --- packages/forgeagent-registry/src/federation.ts ---

import type {
  AgentRegistry,
  RegisteredAgent,
  RegisterAgentInput,
  DiscoveryQuery,
  DiscoveryResultPage,
  RegistryEvent,
  RegistrySubscriptionFilter,
  RegistryStats,
  AgentHealth,
  DeregistrationReason,
} from '@dzipagent/core'

/**
 * A remote registry endpoint that can be synced with.
 */
export interface RemoteRegistryConfig {
  /** Unique identifier for this remote */
  id: string
  /** Human-readable name */
  name: string
  /** Base URL of the remote registry API */
  baseUrl: string
  /** Authentication for accessing the remote registry */
  auth?: { type: 'bearer' | 'api-key'; token: string }
  /** Sync direction */
  direction: 'pull' | 'push' | 'bidirectional'
  /** Sync interval in ms (default: 60_000) */
  syncIntervalMs?: number
  /** Capability prefix filter -- only sync agents matching these prefixes */
  capabilityPrefixes?: string[]
  /** Priority for conflict resolution (higher = wins) */
  priority?: number
}

/**
 * Conflict resolution strategy when the same agent ID exists in multiple registries.
 */
export type ConflictStrategy =
  | 'last-write-wins'     // Most recent lastUpdatedAt wins
  | 'source-priority'     // Higher-priority source wins
  | 'merge-capabilities'  // Merge capabilities from both, keep newest metadata

/**
 * Result of a sync operation.
 */
export interface SyncResult {
  remoteId: string
  remoteName: string
  syncedAt: Date
  agentsPulled: number
  agentsPushed: number
  conflictsResolved: number
  errors: Array<{ agentId: string; error: string }>
  durationMs: number
}

/**
 * Configuration for the federated registry.
 */
export interface FederatedRegistryConfig {
  /** The local registry to federate */
  localRegistry: AgentRegistry
  /** Remote registries to sync with */
  remotes: RemoteRegistryConfig[]
  /** How to resolve conflicts (default: 'last-write-wins') */
  conflictStrategy?: ConflictStrategy
  /** Whether to start sync timers on construction (default: false) */
  autoStart?: boolean
}

/**
 * A registry that federates across multiple local and remote registries.
 *
 * The FederatedRegistry wraps a local AgentRegistry and synchronizes with
 * one or more remote registries. Discovery queries search across all synced
 * agents. Mutations (register/deregister) apply to the local registry only;
 * sync propagates them to remotes based on direction config.
 *
 * Consistency model: **eventual consistency**. After a sync cycle completes,
 * all registries converge to the same set of agents (modulo conflict resolution).
 * Between syncs, registries may diverge.
 *
 * @example
 * ```ts
 * const federated = new FederatedRegistry({
 *   localRegistry: postgresRegistry,
 *   remotes: [
 *     {
 *       id: 'a2a-public',
 *       name: 'A2A Public Registry',
 *       baseUrl: 'https://a2aregistry.org/api',
 *       direction: 'pull',
 *       syncIntervalMs: 300_000,
 *       capabilityPrefixes: ['code.', 'data.'],
 *     },
 *     {
 *       id: 'team-b',
 *       name: 'Team B Registry',
 *       baseUrl: 'https://team-b.internal/registry',
 *       auth: { type: 'bearer', token: process.env.TEAM_B_TOKEN! },
 *       direction: 'bidirectional',
 *       syncIntervalMs: 60_000,
 *     },
 *   ],
 *   conflictStrategy: 'last-write-wins',
 * })
 *
 * federated.startSync()
 * ```
 */
export class FederatedRegistry implements AgentRegistry {
  // Implementation delegates to local registry for all operations,
  // with sync overlay for remote agents.
  //
  // Full implementation deferred to forgeagent-registry-dev agent.
  // See F8 acceptance criteria below.

  constructor(private config: FederatedRegistryConfig) {}

  /** Start all sync timers. */
  startSync(): void { /* ... */ }

  /** Stop all sync timers. */
  stopSync(): void { /* ... */ }

  /** Manually trigger a sync with a specific remote. */
  async syncWith(remoteId: string): Promise<SyncResult> { throw new Error('Not implemented') }

  /** Manually trigger sync with all remotes. */
  async syncAll(): Promise<SyncResult[]> { throw new Error('Not implemented') }

  /** Get the last sync result for a remote. */
  getLastSync(remoteId: string): SyncResult | null { return null }

  // AgentRegistry interface -- delegates to local registry
  async register(input: RegisterAgentInput): Promise<RegisteredAgent> { throw new Error('Not implemented') }
  async deregister(agentId: string, reason?: DeregistrationReason): Promise<void> { throw new Error('Not implemented') }
  async update(agentId: string, update: Partial<RegisterAgentInput>): Promise<RegisteredAgent> { throw new Error('Not implemented') }
  async discover(query: DiscoveryQuery): Promise<DiscoveryResultPage> { throw new Error('Not implemented') }
  async getAgent(agentId: string): Promise<RegisteredAgent | null> { throw new Error('Not implemented') }
  async getHealth(agentId: string): Promise<AgentHealth | null> { throw new Error('Not implemented') }
  async updateHealth(agentId: string, health: Partial<AgentHealth>): Promise<void> { throw new Error('Not implemented') }
  subscribe(handler: (event: RegistryEvent) => void | Promise<void>, filter?: RegistrySubscriptionFilter): () => void { throw new Error('Not implemented') }
  async listAgents(limit?: number, offset?: number): Promise<{ agents: RegisteredAgent[]; total: number }> { throw new Error('Not implemented') }
  async registerFromCard(cardUrl: string, overrides?: Partial<RegisterAgentInput>): Promise<RegisteredAgent> { throw new Error('Not implemented') }
  async evictExpired(): Promise<string[]> { throw new Error('Not implemented') }
  async stats(): Promise<RegistryStats> { throw new Error('Not implemented') }
}
```

#### 8.3 Sync Protocol

The sync protocol uses a simple REST API that remote registries expose:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/registry/agents` | GET | List agents (with `since` timestamp for incremental sync) |
| `/registry/agents/:id` | GET | Get a single agent |
| `/registry/agents` | POST | Register an agent (for push direction) |
| `/registry/agents/:id` | DELETE | Deregister an agent (for push direction) |
| `/registry/sync/status` | GET | Get sync metadata (last sync time, agent count) |

Incremental sync uses `since` parameter: `GET /registry/agents?since=2026-03-24T00:00:00Z` returns only agents updated after that timestamp. This avoids full-table scans on each cycle.

#### 8.4 Conflict Resolution

When the same agent ID exists in both local and remote:

- **last-write-wins**: Compare `lastUpdatedAt` timestamps. The newer record wins.
- **source-priority**: Compare `RemoteRegistryConfig.priority` values. Higher priority wins. Ties fall back to last-write-wins.
- **merge-capabilities**: Keep the union of capabilities from both records. For all other fields, use the newest record.

Agents are tagged with `metadata._source: 'local' | '<remoteId>'` to track provenance.

---

### F9: OpenAPI/AsyncAPI Generation

**Priority:** P2 | **Effort:** 8h | **Package:** `@dzipagent/registry`

Auto-generates API specifications from agent capabilities, making agents discoverable by traditional API tooling.

```typescript
// --- packages/forgeagent-registry/src/spec-generator.ts ---

import type { RegisteredAgent, CapabilityDescriptor } from '@dzipagent/core'

/**
 * Options for OpenAPI/AsyncAPI spec generation.
 */
export interface SpecGeneratorOptions {
  /** Base URL for the API spec */
  baseUrl: string
  /** API title (default: agent name) */
  title?: string
  /** API version (default: agent version) */
  version?: string
  /** Contact information */
  contact?: { name?: string; email?: string; url?: string }
  /** Additional OpenAPI info */
  description?: string
}

/**
 * Generated OpenAPI 3.1 specification.
 */
export interface OpenAPISpec {
  openapi: '3.1.0'
  info: {
    title: string
    version: string
    description?: string
    contact?: Record<string, string>
  }
  servers: Array<{ url: string; description?: string }>
  paths: Record<string, Record<string, unknown>>
  components: {
    schemas: Record<string, unknown>
    securitySchemes?: Record<string, unknown>
  }
  security?: Array<Record<string, string[]>>
}

/**
 * Generated AsyncAPI 3.0 specification for streaming capabilities.
 */
export interface AsyncAPISpec {
  asyncapi: '3.0.0'
  info: {
    title: string
    version: string
    description?: string
  }
  servers: Record<string, { host: string; protocol: string }>
  channels: Record<string, unknown>
  operations: Record<string, unknown>
}

/**
 * Generate an OpenAPI 3.1 spec from a registered agent's capabilities.
 *
 * Each capability becomes a POST endpoint:
 *   POST /capabilities/{capability.name}
 *
 * The capability's inputSchema becomes the request body schema.
 * The capability's outputSchema becomes the response schema.
 *
 * @example
 * ```ts
 * const spec = generateOpenAPI(agent, { baseUrl: 'https://agents.example.com' })
 * // Serve at /api/docs
 * app.get('/api/docs/openapi.json', (c) => c.json(spec))
 * ```
 */
export function generateOpenAPI(
  agent: RegisteredAgent,
  options: SpecGeneratorOptions,
): OpenAPISpec {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const cap of agent.capabilities) {
    const pathKey = `/capabilities/${cap.name.replace(/\./g, '/')}`
    paths[pathKey] = {
      post: {
        operationId: cap.name.replace(/\./g, '_'),
        summary: cap.description,
        tags: [cap.name.split('.')[0]],
        requestBody: cap.inputSchema
          ? {
              required: true,
              content: {
                'application/json': {
                  schema: cap.inputSchema,
                },
              },
            }
          : undefined,
        responses: {
          '200': {
            description: 'Successful capability invocation',
            content: cap.outputSchema
              ? {
                  'application/json': {
                    schema: cap.outputSchema,
                  },
                }
              : {
                  'application/json': {
                    schema: { type: 'object' },
                  },
                },
          },
          '400': {
            description: 'Invalid input',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: {
                      type: 'object',
                      properties: {
                        code: { type: 'string' },
                        message: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }
  }

  // Security scheme based on agent authentication
  const securitySchemes: Record<string, unknown> = {}
  const security: Array<Record<string, string[]>> = []
  switch (agent.authentication.type) {
    case 'bearer':
      securitySchemes['bearerAuth'] = { type: 'http', scheme: 'bearer' }
      security.push({ bearerAuth: [] })
      break
    case 'api-key':
      securitySchemes['apiKeyAuth'] = { type: 'apiKey', in: 'header', name: 'X-API-Key' }
      security.push({ apiKeyAuth: [] })
      break
    case 'oauth2':
      securitySchemes['oauth2'] = {
        type: 'oauth2',
        flows: {
          clientCredentials: {
            tokenUrl: agent.authentication.tokenUrl ?? '/oauth/token',
            scopes: Object.fromEntries((agent.authentication.scopes ?? []).map(s => [s, s])),
          },
        },
      }
      security.push({ oauth2: agent.authentication.scopes ?? [] })
      break
  }

  return {
    openapi: '3.1.0',
    info: {
      title: options.title ?? agent.name,
      version: options.version ?? agent.version,
      description: options.description ?? agent.description,
      ...(options.contact ? { contact: options.contact as Record<string, string> } : {}),
    },
    servers: [{ url: options.baseUrl, description: 'Agent endpoint' }],
    paths,
    components: {
      schemas: {},
      ...(Object.keys(securitySchemes).length > 0 ? { securitySchemes } : {}),
    },
    ...(security.length > 0 ? { security } : {}),
  }
}

/**
 * Generate an AsyncAPI 3.0 spec for an agent's streaming capabilities.
 *
 * Streaming capabilities are identified by having `ws` in the agent's
 * protocols list. Each capability becomes a channel with subscribe/publish
 * operations.
 */
export function generateAsyncAPI(
  agent: RegisteredAgent,
  options: SpecGeneratorOptions,
): AsyncAPISpec {
  const url = new URL(options.baseUrl)
  const channels: Record<string, unknown> = {}
  const operations: Record<string, unknown> = {}

  for (const cap of agent.capabilities) {
    const channelName = cap.name.replace(/\./g, '/')
    channels[channelName] = {
      address: `/stream/${channelName}`,
      messages: {
        input: {
          payload: cap.inputSchema ?? { type: 'object' },
        },
        output: {
          payload: cap.outputSchema ?? { type: 'object' },
        },
      },
    }
    operations[`invoke_${cap.name.replace(/\./g, '_')}`] = {
      action: 'send',
      channel: { $ref: `#/channels/${channelName}` },
      summary: cap.description,
    }
  }

  return {
    asyncapi: '3.0.0',
    info: {
      title: options.title ?? `${agent.name} Streaming API`,
      version: options.version ?? agent.version,
      description: options.description ?? agent.description,
    },
    servers: {
      production: {
        host: url.host,
        protocol: 'ws',
      },
    },
    channels,
    operations,
  }
}
```

---

## 3. Data Models

### 3.1 Drizzle Schema Summary

Three new tables added to `@dzipagent/server`:

| Table | Purpose | Key Columns | Indexes |
|-------|---------|-------------|---------|
| `forge_registry_agents` | Agent records for discovery | id, name, endpoint, capabilities (JSONB), capability_names (JSONB), capability_tags (JSONB), authentication (JSONB), health snapshot, embedding | GIN on capability_names, GIN on capability_tags, B-tree on endpoint, B-tree on name |
| `forge_registry_health` | Health probe history | agent_id, success, latency_ms, status_code, error_message, probed_at | Composite (agent_id, probed_at) |
| `forge_registry_card_versions` | Agent card version history | agent_id, version, card (JSONB), deprecated, change_type, change_summary | Composite (agent_id, version) |

### 3.2 Capability Taxonomy Data Structure

The taxonomy is a nested `const` object in TypeScript. Leaf values are description strings. Intermediate nodes are objects containing children. The shape:

```typescript
type TaxonomyNode = string | { [segment: string]: TaxonomyNode }
type TaxonomyTree = { [domain: string]: TaxonomyNode }
```

Standard domains: `code`, `data`, `memory`, `devops`, `docs`, `chat`.

### 3.3 Health Metrics Storage

Health is stored at two levels:

1. **Per-probe** in `forge_registry_health`: individual probe results with timestamp, latency, success/failure. Retained for `healthWindowSize` probes per agent (default 100). Older probes are pruned during aggregation.

2. **Aggregated snapshot** in `forge_registry_agents`: computed from the sliding window and written on each probe cycle. Contains p50/p95/p99 latency, error rate, consecutive success/failure counts, circuit state.

The `HealthMonitor` (in-memory or server-side) maintains sliding windows in memory for fast computation. The Postgres implementation also writes individual probes for historical analysis.

---

## 4. Data Flow Diagrams

### 4.1 Agent Registration Flow

```
Caller                      AgentRegistry              DzipEventBus
  │                              │                          │
  │  register(input)             │                          │
  │─────────────────────────────►│                          │
  │                              │                          │
  │                    Validate input                       │
  │                    - Check for duplicates               │
  │                    - Validate capability names          │
  │                    - Denormalize cap names/tags         │
  │                              │                          │
  │                    Store agent record                   │
  │                    - InMemory: Map.set()                │
  │                    - Postgres: INSERT INTO              │
  │                              │                          │
  │                              │  emit(registry:          │
  │                              │    agent_registered)     │
  │                              │─────────────────────────►│
  │                              │                          │
  │  ◄── RegisteredAgent ────────│                          │
  │                              │                          │
  │                    HealthMonitor picks up new agent     │
  │                    on next probe cycle                  │
```

### 4.2 Discovery Query Resolution

```
Caller                      AgentRegistry         CapabilityMatcher    SemanticSearch
  │                              │                       │                  │
  │  discover(query)             │                       │                  │
  │─────────────────────────────►│                       │                  │
  │                              │                       │                  │
  │                    Apply hard filters                 │                  │
  │                    (protocol, health,                 │                  │
  │                     SLA, excludeIds)                  │                  │
  │                              │                       │                  │
  │                    If semanticQuery:                  │                  │
  │                              │  embedQuery            │                  │
  │                              │──────────────────────────────────────────►│
  │                              │                       │  vectorSearch     │
  │                              │◄─────── semanticScores ──────────────────│
  │                              │                       │                  │
  │                    For each candidate:               │                  │
  │                              │  scoreAgent(agent,    │                  │
  │                              │    query, semScore)   │                  │
  │                              │──────────────────────►│                  │
  │                              │◄── { score, breakdown}│                  │
  │                              │                       │                  │
  │                    Sort by matchScore                 │                  │
  │                    Apply limit/offset                 │                  │
  │                              │                       │                  │
  │                              │  emit(registry:       │                  │
  │                              │    query_executed)     │                  │
  │                              │                       │                  │
  │  ◄── DiscoveryResultPage ────│                       │                  │
```

### 4.3 Health Monitoring Loop

```
HealthMonitor                AgentRegistry           Agent Endpoint
  │                              │                        │
  │  [Timer fires every 30s]     │                        │
  │                              │                        │
  │  evictExpired()              │                        │
  │─────────────────────────────►│                        │
  │  ◄── evictedIds[] ──────────│                        │
  │                              │                        │
  │  listAgents()                │                        │
  │─────────────────────────────►│                        │
  │  ◄── agents[] ──────────────│                        │
  │                              │                        │
  │  For each agent (batched):   │                        │
  │                              │                        │
  │  1. Check circuit breaker    │                        │
  │     If open: record synthetic failure, skip probe     │
  │                              │                        │
  │  2. GET /health              │                        │
  │──────────────────────────────────────────────────────►│
  │  ◄── { status, latency } ───────────────────────────│
  │                              │                        │
  │  3. Record in sliding window │                        │
  │  4. Update circuit breaker   │                        │
  │  5. Compute p50/p95/p99      │                        │
  │  6. Derive health status     │                        │
  │                              │                        │
  │  updateHealth(agentId, health)                        │
  │─────────────────────────────►│                        │
  │                              │  emit(registry:        │
  │                              │    health_changed)     │
  │                              │  (if status changed)   │
```

### 4.4 Federation Sync

```
FederatedRegistry      Local Registry       Remote Registry API
  │                        │                       │
  │  [Timer fires]         │                       │
  │                        │                       │
  │  GET /registry/agents?since=<lastSync>         │
  │────────────────────────────────────────────────►│
  │  ◄── remoteAgents[] ──────────────────────────│
  │                        │                       │
  │  For each remote agent:│                       │
  │                        │                       │
  │  getAgent(id)          │                       │
  │───────────────────────►│                       │
  │  ◄── localAgent | null │                       │
  │                        │                       │
  │  If conflict:          │                       │
  │    Apply conflict strategy                     │
  │    (last-write-wins / source-priority / merge) │
  │                        │                       │
  │  register() or update()│                       │
  │───────────────────────►│                       │
  │                        │                       │
  │  If push direction:    │                       │
  │  listAgents() (local only)                     │
  │───────────────────────►│                       │
  │  ◄── localAgents[] ───│                       │
  │                        │                       │
  │  POST /registry/agents │                       │
  │────────────────────────────────────────────────►│
  │  ◄── ack ─────────────────────────────────────│
```

---

## 5. File Structure

### 5.1 `@dzipagent/core` additions

```
packages/forgeagent-core/src/
  registry/
    types.ts                    # AgentRegistry interface, all data types (F1)
    capability-taxonomy.ts      # STANDARD_CAPABILITIES, validate, parse, match (F2)
    capability-matcher.ts       # scoreAgent(), filterAgents() (F2)
    in-memory-registry.ts       # InMemoryRegistry class (F3)
    health-monitor.ts           # HealthMonitor class (F6)
    index.ts                    # Barrel re-exports
  errors/
    error-codes.ts              # Add REGISTRY_* error codes
  events/
    event-types.ts              # Add registry:* event types
```

### 5.2 `@dzipagent/server` additions

```
packages/forgeagent-server/src/
  persistence/
    registry-schema.ts          # Drizzle tables: forge_registry_agents,
                                #   forge_registry_health, forge_registry_card_versions (F4)
  registry/
    postgres-registry.ts        # PostgresRegistry class (F4)
    card-versioning.ts          # diffAgentCards(), CardVersionStore (F7)
    index.ts                    # Barrel re-exports
  routes/
    registry.ts                 # REST routes: /registry/agents, /registry/discover,
                                #   /registry/agents/:id/health, /registry/agents/:id/versions
```

### 5.3 `@dzipagent/registry` (new package)

```
packages/forgeagent-registry/
  package.json                  # peer deps: @dzipagent/core, @dzipagent/server
  tsconfig.json
  tsup.config.ts
  src/
    semantic-search.ts          # SemanticCapabilitySearch (F5)
    federation.ts               # FederatedRegistry (F8)
    spec-generator.ts           # generateOpenAPI(), generateAsyncAPI() (F9)
    index.ts                    # Barrel re-exports
```

### 5.4 Export Additions to `@dzipagent/core/src/index.ts`

```typescript
// --- Registry ---
export { InMemoryRegistry } from './registry/in-memory-registry.js'
export { HealthMonitor } from './registry/health-monitor.js'
export {
  validateCapabilityName,
  parseCapability,
  matchCapability,
  isStandardCapability,
  listStandardCapabilities,
  STANDARD_CAPABILITIES,
} from './registry/capability-taxonomy.js'
export { scoreAgent, filterAgents } from './registry/capability-matcher.js'
export type {
  AgentRegistry,
  RegisterAgentInput,
  RegisteredAgent,
  AgentHealth,
  AgentHealthStatus,
  AgentProtocol,
  AgentAuthentication,
  AgentSLA,
  CapabilityDescriptor,
  DiscoveryQuery,
  DiscoveryResult,
  DiscoveryResultPage,
  DiscoverySortField,
  HealthFilter,
  SLAFilter,
  ScoreBreakdown,
  RegistryEvent,
  RegistrySubscriptionFilter,
  RegistryStats,
  DeregistrationReason,
  LatencyPercentiles,
  ParsedCapability,
} from './registry/types.js'
export type {
  HealthMonitorConfig,
  ProbeResult,
} from './registry/health-monitor.js'
export type {
  CapabilityMatcherConfig,
} from './registry/capability-matcher.js'
```

---

## 6. Testing Strategy

### 6.1 Unit Tests (in each package)

**`@dzipagent/core` registry tests:**

| Test File | Coverage |
|-----------|----------|
| `registry/__tests__/capability-taxonomy.test.ts` | `validateCapabilityName()` with valid/invalid inputs, `parseCapability()`, `matchCapability()` prefix/exact/mismatch, `isStandardCapability()`, `listStandardCapabilities()` |
| `registry/__tests__/capability-matcher.test.ts` | `scoreAgent()` with various query shapes, weight configuration, `filterAgents()` with protocol/health/SLA/name/exclude filters |
| `registry/__tests__/in-memory-registry.test.ts` | Full CRUD lifecycle, duplicate detection, TTL eviction, discovery with all filter combinations, event emission verification, `registerFromCard()` (mocked fetch), pagination, sorting |
| `registry/__tests__/health-monitor.test.ts` | Probe scheduling (start/stop), sliding window stats computation, percentile calculation, circuit breaker integration, status derivation, concurrent probe batching |

**`@dzipagent/server` registry tests:**

| Test File | Coverage |
|-----------|----------|
| `registry/__tests__/postgres-registry.test.ts` | Same test suite as InMemoryRegistry but against real Postgres (testcontainers), plus GIN index query verification, transaction safety, concurrent registration |
| `registry/__tests__/card-versioning.test.ts` | `diffAgentCards()` with breaking/non-breaking/patch changes, version store persistence |
| `routes/__tests__/registry-routes.test.ts` | HTTP endpoint tests for all REST routes, auth enforcement, error responses |

**`@dzipagent/registry` tests:**

| Test File | Coverage |
|-----------|----------|
| `__tests__/semantic-search.test.ts` | Embedding computation, vector search fusion with base results, minimum similarity threshold, agent text building |
| `__tests__/federation.test.ts` | Pull sync, push sync, bidirectional sync, conflict resolution (all 3 strategies), incremental sync with `since`, error handling for unreachable remotes |
| `__tests__/spec-generator.test.ts` | OpenAPI generation from capabilities, security scheme mapping, AsyncAPI generation, edge cases (no capabilities, no auth) |

### 6.2 Integration Tests

1. **End-to-end registration and discovery**: Register 10 agents with various capabilities, run discovery queries, verify ranking order.
2. **Health monitoring integration**: Start a mock HTTP server, register it, run health probes, verify health status transitions (healthy -> degraded -> unhealthy -> circuit open -> half-open -> healthy).
3. **Federation roundtrip**: Spin up two InMemoryRegistries, configure bidirectional federation, register agents on each side, trigger sync, verify convergence.
4. **Semantic search accuracy**: Register agents with known capabilities, run natural-language queries, verify that the correct agents rank highest.

### 6.3 Property-Based Tests

1. **Capability name validation**: Generate random strings, verify that `validateCapabilityName()` accepts only strings matching the grammar.
2. **Score monotonicity**: For a fixed query, if agent A has strictly more matching capabilities than agent B, then `scoreAgent(A) >= scoreAgent(B)`.
3. **Filter correctness**: For any query with health/SLA filters, every result in `discover()` satisfies those filters.

---

## 7. Migration from Current State

### 7.1 Backward Compatibility

The existing `AgentCard` type in `@dzipagent/server/src/a2a/agent-card.ts` and the `PluginRegistry` in `@dzipagent/core/src/plugin/plugin-registry.ts` are not modified. The new `AgentRegistry` is a separate system.

However, a bridge is provided:

```typescript
/**
 * Convert an existing AgentCard to a RegisterAgentInput.
 * Allows registering agents that were built with the current buildAgentCard() API.
 */
export function agentCardToRegistration(
  card: import('@dzipagent/server').AgentCard,
): RegisterAgentInput {
  return {
    name: card.name,
    description: card.description,
    endpoint: card.url,
    protocols: ['http'],
    capabilities: card.capabilities.map(cap => ({
      name: cap.name,
      version: '1.0.0',
      description: cap.description,
      inputSchema: cap.inputSchema,
    })),
    authentication: card.authentication ?? { type: 'none' },
    version: card.version,
  }
}
```

### 7.2 Adoption Path

1. **Phase 1 (P0)**: Ship `AgentRegistry` interface, `InMemoryRegistry`, and `CapabilityTaxonomy` in core. Existing code is unaffected. New consumers can opt in.

2. **Phase 2 (P1)**: Ship `PostgresRegistry` in server, `HealthMonitor` in core, semantic search in registry. The server's `/registry/*` routes are added alongside existing `/a2a/*` routes.

3. **Phase 3 (P2-P3)**: Ship federation, card versioning, spec generation. These are purely additive.

The existing `/.well-known/agent.json` route continues to work. A new `/.well-known/agent-card.json` route (A2A v2 standard path) is added alongside it, serving an enriched card that includes capability taxonomy names and health metadata.

---

## Appendix A: Error Code Definitions

| Code | HTTP Status | When |
|------|-------------|------|
| `REGISTRY_DUPLICATE` | 409 | `register()` called with an ID that already exists |
| `REGISTRY_NOT_FOUND` | 404 | `update()` or `getAgent()` for non-existent agent |
| `REGISTRY_FETCH_FAILED` | 502 | `registerFromCard()` cannot reach the card URL |
| `REGISTRY_INVALID_CARD` | 422 | `registerFromCard()` receives an invalid card |
| `REGISTRY_SYNC_FAILED` | 502 | Federation sync fails for a remote |

## Appendix B: REST API Routes (for `@dzipagent/server`)

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/registry/agents` | List agents (paginated) | operator+ |
| POST | `/registry/agents` | Register an agent | admin |
| GET | `/registry/agents/:id` | Get agent by ID | operator+ |
| PATCH | `/registry/agents/:id` | Update agent | admin |
| DELETE | `/registry/agents/:id` | Deregister agent | admin |
| GET | `/registry/discover` | Discovery query (query params) | operator+ |
| POST | `/registry/discover` | Discovery query (JSON body, for complex queries) | operator+ |
| GET | `/registry/agents/:id/health` | Get agent health | operator+ |
| GET | `/registry/agents/:id/versions` | Get card version history | operator+ |
| GET | `/registry/stats` | Registry statistics | operator+ |
| POST | `/registry/agents/from-card` | Register from remote Agent Card URL | admin |
| POST | `/registry/sync/:remoteId` | Trigger federation sync | admin |

## Appendix C: Relation to Existing DzipAgent Types

| Existing Type | Relation to Registry |
|---------------|---------------------|
| `AgentCard` (server/a2a) | Subset of `RegisteredAgent`. Bridge function `agentCardToRegistration()` converts between them. |
| `AgentDefinition` (core/persistence) | Internal agent definition for *this* server. `RegisteredAgent` is for *external* agents discoverable in the registry. They may overlap when this server registers its own agents. |
| `DzipPlugin` (core/plugin) | Plugins extend DzipAgent functionality. Registry agents are external services. A plugin could register agents into the registry via its `onRegister` hook. |
| `HealthAggregator` (core/observability) | Monitors internal subsystem health. `HealthMonitor` monitors external agent health. Both emit events through `DzipEventBus`. |
| `CircuitBreaker` (core/llm) | Reused by `HealthMonitor` for per-agent circuit breaking. Same implementation, different scope. |
| `DzipEventBus` (core/events) | Registry events are new additions to the `DzipEvent` discriminated union. |
