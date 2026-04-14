# Registry Architecture (`packages/core/src/registry`)

## Scope
This document covers the agent registry subsystem in `@dzupagent/core`, including:

- data model and API contract
- capability taxonomy and matching
- in-memory registry behavior and scoring
- semantic search providers (keyword fallback + vector-backed)
- event model integration
- cross-package usage in this monorepo
- test coverage and current validation status

Primary entrypoint: `packages/core/src/registry/index.ts`.
Public re-export: `packages/core/src/index.ts`.

## Module Layout

| File | Responsibility |
| --- | --- |
| `types.ts` | Registry domain types and `AgentRegistry` interface contract. |
| `capability-taxonomy.ts` | Standard hierarchical capability catalog and lookup helpers. |
| `capability-matcher.ts` | Capability hierarchy scoring + wildcard matching + numeric semver comparison. |
| `in-memory-registry.ts` | Default in-process `AgentRegistry` implementation with discovery scoring and event fanout. |
| `semantic-search.ts` | `SemanticSearchProvider` interface and TF-IDF keyword fallback implementation. |
| `vector-semantic-search.ts` | Vector-store-backed semantic search provider implementation. |
| `index.ts` | Barrel exports. |

## Core Contract (`types.ts`)

### Main entities
- `RegisteredAgent`: canonical runtime record for an agent instance.
- `RegisterAgentInput`: input payload for `register` and partial payload for `update`.
- `AgentHealth`: health snapshot and SLO telemetry.
- `AgentSLA`: declared latency/error/uptime constraints.
- `DiscoveryQuery`: filter/query shape for discovery.
- `DiscoveryResultPage`: scored, paginated discovery response.

### Registry interface (`AgentRegistry`)
The contract defines 12 operations:

1. `register`
2. `deregister`
3. `update`
4. `discover`
5. `getAgent`
6. `getHealth`
7. `updateHealth`
8. `subscribe`
9. `listAgents`
10. `registerFromCard`
11. `evictExpired`
12. `stats`

This contract is implemented by:
- `InMemoryRegistry` in `core`
- `PostgresRegistry` in `server` (same interface, persistent backend)

## Feature Set

### 1) Capability taxonomy and canonical names
`capability-taxonomy.ts` defines `STANDARD_CAPABILITIES` as a dot-separated hierarchy (`code.review.security`, `planning.decompose`, etc.) and provides:

- `isStandardCapability(name)`
- `getCapabilityDescription(name)`
- `listStandardCapabilities()`

Implementation detail:
- lookups are backed by a lazily-built flattened index for efficient repeated checks.

### 2) Capability matching and semver handling
`capability-matcher.ts` provides:

- `CapabilityMatcher.match(query, candidate)` scoring:
  - exact match -> `1.0`
  - candidate is a deeper child path -> reduced positive score
  - candidate is a parent path -> lower positive score
  - unrelated path -> `0`
- `CapabilityMatcher.matchesPattern(pattern, capability)`:
  - exact support
  - suffix wildcard support (`code.*`, `code.review.*`)
- `compareSemver(a, b)`:
  - numeric segment comparison (`10.0.0` > `2.0.0`)
  - avoids lexicographic ordering bugs

### 3) In-memory registration lifecycle
`InMemoryRegistry` supports:

- input validation (`name`, `description`, non-empty `capabilities`)
- generated IDs (`agent-<timestamp-base36>-<counter-base36>`)
- immutable update strategy (new objects stored, shallow copies returned)
- optional identity metadata passthrough (`identity`, `uri`)
- TTL eviction (`evictExpired`) with event emission

### 4) Discovery and scoring
`discover(query)` computes a weighted score per candidate agent:

- capability score (40%)
- tag score (20%)
- health adjustment (30%)
- SLA score (10%)

Score formula:

```text
matchScore = capabilityScore * 0.4 + tagScore * 0.2 + healthAdjustment * 0.3 + slaScore * 0.1
```

Health contribution defaults:
- `healthy = 1.0`
- `degraded = 0.5`
- `unknown = 0.3`
- `unhealthy = 0.1`

Filtering happens before scoring for:
- `healthFilter`
- `protocols`

Pagination:
- `limit` default `10`
- `offset` default `0`

### 5) Eventing and subscriptions
Registry emits typed domain events:

- `registry:agent_registered`
- `registry:agent_deregistered`
- `registry:agent_updated`
- `registry:health_changed`
- `registry:capability_added`

Events are delivered to:
- local subscribers (`subscribe(filter, handler)`)
- optional shared `DzupEventBus` (if injected via config)

### 6) Semantic search providers
`semantic-search.ts` defines `SemanticSearchProvider` and ships `KeywordFallbackSearch`:

- indexes agent text (`name`, `description`, capability names/descriptions/tags)
- tokenizes and ranks via TF-IDF-style scoring
- does not require external embedding services

`vector-semantic-search.ts` ships `VectorStoreSemanticSearch`:

- delegates query embedding to configured embedding provider
- searches vector store collection `agent_registry`
- asynchronously upserts/deletes index records
- non-fatal error policy for indexing/deletion failures

## Runtime Flows

### Flow A: Register -> emit -> discover
1. Caller invokes `registry.register(input)`.
2. Registry validates required fields.
3. Registry creates/stores a `RegisteredAgent` (default health `unknown`).
4. Registry emits `registry:agent_registered`.
5. Discovery calls include this agent in future scoring/filtering.

### Flow B: Update capabilities -> capability event -> ranked discovery
1. Caller invokes `registry.update(agentId, { capabilities })`.
2. Registry detects newly added capability names.
3. Emits `registry:capability_added` per new capability.
4. Emits `registry:agent_updated` with changed field list.
5. Updated capabilities alter capability/tag discovery scores.

### Flow C: Health monitoring integration
1. `HealthMonitor` (server package) probes registered agent endpoints.
2. It calls `registry.updateHealth(agentId, healthPatch)`.
3. Registry persists health and emits `registry:health_changed` when status changes.
4. Discovery scoring adjusts via `healthAdjustment` weight.

### Flow D: TTL lifecycle
1. Agent registered with `ttlMs`.
2. `evictExpired()` checks `registeredAt + ttlMs`.
3. Expired agents are deleted.
4. `registry:agent_deregistered` emitted with reason `ttl_expired`.

## Usage Examples

### Example 1: Basic in-memory registration and discovery
```ts
import { InMemoryRegistry, type RegisterAgentInput } from '@dzupagent/core'

const registry = new InMemoryRegistry()

const input: RegisterAgentInput = {
  name: 'reviewer-1',
  description: 'Security-focused code review agent',
  protocols: ['a2a'],
  capabilities: [
    { name: 'code.review.security', version: '1.2.0', tags: ['security', 'typescript'] },
  ],
}

const agent = await registry.register(input)

const page = await registry.discover({
  capabilityPrefix: 'code.review',
  tags: ['security'],
  healthFilter: ['healthy', 'unknown'],
  limit: 5,
})

console.log(agent.id, page.results.map(r => [r.agent.name, r.matchScore]))
```

### Example 2: Subscribe to registry events
```ts
import { InMemoryRegistry } from '@dzupagent/core'

const registry = new InMemoryRegistry()

const sub = registry.subscribe(
  { eventTypes: ['registry:agent_registered', 'registry:health_changed'] },
  (event) => {
    console.log('registry event', event.type, event.agentId)
  },
)

// ... perform register / updateHealth operations

sub.unsubscribe()
```

### Example 3: Use vector-backed semantic search provider directly
```ts
import { VectorStoreSemanticSearch, SemanticStore } from '@dzupagent/core'

const semanticStore = new SemanticStore({ embedding: embeddingProvider, vectorStore })
await semanticStore.ensureCollection('agent_registry', { dimensions: 1536 })

const semantic = new VectorStoreSemanticSearch(semanticStore)
semantic.indexAgent(agent)

const q = await semantic.embedQuery('best agent for secure code review')
const ranked = await semantic.search(q, 3)
```

## Cross-Package References and Usage

### `@dzupagent/server`
- `src/routes/registry.ts`
  - exposes HTTP CRUD/discovery/stats endpoints backed by `AgentRegistry`
  - maps query params (`capabilityPrefix`, `capabilityExact`, `q`, `tags`, `health`, `protocols`) into `DiscoveryQuery`
- `src/registry/health-monitor.ts`
  - periodic probes call `registry.updateHealth`
  - uses `listAgents` for probe fanout
- `src/persistence/postgres-registry.ts`
  - persistent `AgentRegistry` implementation using `RegistryStore`
  - mirrors core events and similar scoring model

### `@dzupagent/core` (other modules)
- `src/identity/capability-checker.ts`
  - reuses `CapabilityMatcher` for direct capability grants and wildcard/role scope checks
- `src/identity/delegation-manager.ts`
  - reuses `CapabilityMatcher` for scope narrowing and chain capability checks

### `@dzupagent/otel`
- `src/event-metric-map/platform-registry-protocol.ts`
  - consumes registry event names for metrics extraction
- tests confirm counters are emitted for all registry event types

### `@dzupagent/agent-adapters`
- `src/registry/adapter-registry.ts`
  - emits a subset of registry event names (`registry:agent_registered`, `registry:agent_deregistered`) to shared event bus for consistent observability semantics

### Export surface
- All registry public types/classes are re-exported by `@dzupagent/core` root index.
- Consumers in `server` import `InMemoryRegistry`, `AgentRegistry`, and related types directly from `@dzupagent/core`.

## Current Integration Notes

### Semantic query wiring status
`DiscoveryQuery` includes `semanticQuery`, and server routes map `q -> semanticQuery`, but current `InMemoryRegistry.discover()` and `PostgresRegistry.discover()` do not use semantic providers in scoring/filtering yet.

Implication:
- semantic search providers are currently standalone utilities, not integrated into registry discovery path.

### `registerFromCard` support
Both `InMemoryRegistry` and `PostgresRegistry` currently throw for `registerFromCard`.

Implication:
- card-based registry onboarding is a planned/placeholder contract, not active runtime behavior.

### Scoring parity divergence between implementations
- `InMemoryRegistry` supports capability exact + `minVersion` checks using numeric semver.
- `PostgresRegistry` currently checks exact capability name, but does not apply `minVersion` semver filtering in scoring.

Implication:
- discovery ranking/qualification may differ between in-memory and server persistent implementations for versioned queries.

## Test Coverage

### Executed test runs (April 3, 2026)

1. `yarn workspace @dzupagent/core test -- src/registry/__tests__/registry.test.ts src/registry/__tests__/semantic-search.test.ts src/registry/__tests__/vector-semantic-search.test.ts src/__tests__/registry-idcounter.test.ts`
- Result: passed
- Files: 4 passed
- Tests: 70 passed

2. `yarn workspace @dzupagent/server test -- src/routes/__tests__/registry.test.ts src/registry/__tests__/health-monitor.test.ts src/persistence/__tests__/postgres-registry.test.ts`
- Result: passed
- Files: 3 passed
- Tests: 23 passed

### Registry module coverage snapshot (`core`, targeted run)
From a focused `vitest --coverage` run of registry tests:

| File | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| `capability-matcher.ts` | 97.97% | 92.00% | 100.00% | 97.97% |
| `capability-taxonomy.ts` | 100.00% | 86.66% | 100.00% | 100.00% |
| `in-memory-registry.ts` | 85.92% | 79.33% | 95.00% | 85.92% |
| `semantic-search.ts` | 100.00% | 90.47% | 100.00% | 100.00% |
| `vector-semantic-search.ts` | 100.00% | 90.00% | 100.00% | 100.00% |
| `src/registry` aggregate | 91.78% | 83.33% | 97.67% | 91.78% |

Notes:
- The focused coverage command exits non-zero because package-wide global coverage thresholds apply to the whole `core` package when only a subset of tests is run.
- The registry-specific numbers above are still valid and extracted from the generated coverage report.

### Behavior coverage by test suite
- `src/registry/__tests__/registry.test.ts`
  - validation, register/get/update/deregister
  - discovery filters and scoring
  - semver min-version behavior
  - health update events
  - TTL eviction
  - stats aggregation
  - subscription filtering and event bus forwarding
  - identity/uri passthrough
- `src/registry/__tests__/semantic-search.test.ts`
  - indexing, relevance scoring, limits, removals, no-match behavior
- `src/registry/__tests__/vector-semantic-search.test.ts`
  - embedding delegation, store indexing/search/delete, failure swallowing
- `src/__tests__/registry-idcounter.test.ts`
  - instance-level ID counter isolation
- `server` integration tests
  - HTTP route wiring (`routes/registry.test.ts`)
  - health monitor -> registry health updates (`health-monitor.test.ts`)
  - persistent implementation conversions/field mapping (`postgres-registry.test.ts`)

## Practical Guidance

Use `InMemoryRegistry` when:
- running local development
- writing deterministic unit/integration tests
- deploying single-process runtime where in-memory state is acceptable

Use `PostgresRegistry` (server package) when:
- registry state must survive process restarts
- multi-instance/server deployments require shared persistent state

Use semantic providers when:
- you need semantic ranking utilities today (direct provider usage)
- you are prepared to wire provider output into a custom `discover` pipeline until native integration is added
