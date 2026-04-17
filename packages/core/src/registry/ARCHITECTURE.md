# Registry Architecture (`packages/core/src/registry`)

## Scope
This document covers the registry module implemented under `packages/core/src/registry` in `@dzupagent/core`.

Included in scope:
- registry domain types and the `AgentRegistry` contract
- the in-memory registry implementation (`InMemoryRegistry`)
- capability taxonomy and matching utilities
- semantic search providers shipped in this package (`KeywordFallbackSearch`, `VectorStoreSemanticSearch`)
- module-level integration inside `@dzupagent/core`

Out of scope:
- server-side persistence implementations outside this directory
- API gateway/HTTP route behavior from other packages

## Responsibilities
The registry module is responsible for:
- managing agent lifecycle in memory (`register`, `update`, `deregister`, `list`, `evictExpired`)
- exposing typed discovery APIs with capability/tag/health/SLA scoring
- tracking and updating per-agent health snapshots
- emitting typed registry events to local subscribers and optionally to `DzupEventBus`
- providing reusable capability hierarchy utilities (`STANDARD_CAPABILITIES`, `CapabilityMatcher`, `compareSemver`)
- providing pluggable semantic-search provider implementations (keyword fallback and vector-store-backed)

## Structure
| File | Purpose |
| --- | --- |
| `types.ts` | Core contract and domain types (`RegisteredAgent`, `DiscoveryQuery`, `RegistryEvent`, `AgentRegistry`, etc.). |
| `in-memory-registry.ts` | Default in-process `AgentRegistry` implementation, including scoring, filtering, event emission, and TTL eviction. |
| `capability-taxonomy.ts` | Built-in hierarchical capability catalog plus lookup helpers. |
| `capability-matcher.ts` | Hierarchy-aware capability scoring, wildcard matching, and numeric semver comparison. |
| `semantic-search.ts` | `SemanticSearchProvider` interface and TF-IDF-style keyword fallback implementation. |
| `vector-semantic-search.ts` | `SemanticSearchProvider` backed by `SemanticStore` (`vectordb`). |
| `index.ts` | Barrel exports for the registry module. |
| `__tests__/registry.test.ts` | Unit tests for registry behaviors, matcher, taxonomy, and event bus forwarding. |
| `__tests__/semantic-search.test.ts` | Unit tests for keyword semantic search indexing/scoring/removal. |
| `__tests__/vector-semantic-search.test.ts` | Unit tests for vector semantic provider behavior and failure handling. |

## Runtime and Control Flow
### Registration and Deregistration
1. `register(input)` validates required fields (`name`, `description`, non-empty `capabilities`).
2. ID is generated as `agent-${Date.now().toString(36)}-${counter.toString(36)}`.
3. Agent is stored with default `health.status = 'unknown'`.
4. `registry:agent_registered` is emitted.
5. `deregister(agentId, reason)` removes the record and emits `registry:agent_deregistered`.

### Update and Health
1. `update(agentId, changes)` builds a new object (spread-based immutable update pattern).
2. New capabilities emit `registry:capability_added` events per new capability name.
3. If any fields changed, `registry:agent_updated` is emitted with changed field names.
4. `updateHealth(agentId, patch)` merges health and emits `registry:health_changed` only when status changes.

### Discovery and Scoring
Filtering (pre-score):
- `healthFilter`
- `protocols`

Per-agent score breakdown:
- `capabilityScore`
- `tagScore`
- `healthAdjustment`
- `slaScore`

Final score formula:
```text
matchScore = capabilityScore * 0.4 + tagScore * 0.2 + healthAdjustment * 0.3 + slaScore * 0.1
```

Scoring details from code:
- `capabilityPrefix` uses `CapabilityMatcher.match(...)` and keeps best capability score.
- `capabilityExact` can enforce `minVersion` using numeric `compareSemver`.
- no capability query defaults `capabilityScore` to `1.0`.
- no tag query defaults `tagScore` to `1.0`.
- health adjustment mapping: `healthy=1.0`, `degraded=0.5`, `unknown=0.3`, `unhealthy=0.1`.
- SLA scoring starts at `1.0`; it is reduced only when comparable SLA fields are present.

Pagination:
- default `limit=10`, `offset=0`
- sorted by descending `matchScore`

### Subscriptions and Event Fanout
- Local subscribers register via `subscribe(filter, handler)`.
- Filters can target `eventTypes`, `agentIds`, and capability name (for `registry:capability_added`).
- Handler failures are swallowed (non-fatal).
- If configured with `eventBus`, events are forwarded as `DzupEvent`.

### TTL Eviction
- `evictExpired()` checks `registeredAt + ttlMs` for each agent.
- expired agents are removed and emit `registry:agent_deregistered` with reason `ttl_expired`.

### Semantic Providers (Standalone)
- `KeywordFallbackSearch` indexes agent text (`name`, `description`, capability names/descriptions/tags`) and ranks via TF-IDF-style scoring.
- `VectorStoreSemanticSearch` delegates embedding/search to `SemanticStore` using collection `agent_registry`.
- vector index/remove operations are fire-and-forget and intentionally non-fatal.
- current `InMemoryRegistry.discover()` does not call a semantic provider directly.

## Key APIs and Types
### Primary interface
`AgentRegistry` defines:
- `register(input)`
- `deregister(agentId, reason?)`
- `update(agentId, changes)`
- `discover(query)`
- `getAgent(agentId)`
- `getHealth(agentId)`
- `updateHealth(agentId, healthPatch)`
- `subscribe(filter, handler)`
- `listAgents(limit?, offset?)`
- `registerFromCard(cardUrl)`
- `evictExpired()`
- `stats()`

### Core domain types
- `RegisteredAgent`
- `RegisterAgentInput`
- `DiscoveryQuery`
- `DiscoveryResult` / `DiscoveryResultPage`
- `ScoreBreakdown`
- `AgentHealth`, `AgentHealthStatus`
- `AgentSLA`
- `RegistryStats`
- `RegistryEvent` and `RegistryEventType`
- `RegistrySubscriptionFilter`

### Capability helpers
- `STANDARD_CAPABILITIES`
- `isStandardCapability(name)`
- `getCapabilityDescription(name)`
- `listStandardCapabilities()`
- `CapabilityMatcher.match(query, candidate)`
- `CapabilityMatcher.matchesPattern(pattern, capability)`
- `compareSemver(a, b)`

### Semantic interfaces
- `SemanticSearchProvider`
- `KeywordFallbackSearch`
- `createKeywordFallbackSearch()`
- `VectorStoreSemanticSearch`

## Dependencies
Direct internal dependencies used by registry source files:
- `../identity/index.js` for `ForgeCapability` and `ForgeIdentityRef` type usage in registry models
- `../events/event-bus.js` and `../events/event-types.js` for optional bus forwarding
- `../errors/forge-error.js` for structured registry errors
- `../vectordb/semantic-store.js` for vector-backed semantic provider

Runtime dependency profile:
- registry files do not import third-party packages directly
- vector semantic search depends on caller-supplied `SemanticStore` configuration (embedding provider + vector store + collection lifecycle)

## Integration Points
- Module exports are provided by `src/registry/index.ts` and re-exported from `src/index.ts`.
- `CapabilityMatcher` is reused by identity authorization components:
  - `src/identity/capability-checker.ts`
  - `src/identity/delegation-manager.ts`
- Registry event names are part of the global event union in `src/events/event-types.ts`.
- `InMemoryRegistry` can bridge events into shared observability/event pipelines through injected `DzupEventBus`.
- Semantic provider implementations integrate with the `vectordb` subsystem but are currently separate from `discover()` execution.

## Testing and Observability
Automated tests in scope:
- `src/registry/__tests__/registry.test.ts`
- `src/registry/__tests__/semantic-search.test.ts`
- `src/registry/__tests__/vector-semantic-search.test.ts`
- `src/__tests__/registry-idcounter.test.ts`

Current tested behaviors include:
- validation, registration lifecycle, immutable update behavior, and deletion
- capability matching, wildcard behavior, and numeric semver comparisons
- discovery filtering/scoring/pagination across capability/tags/health/protocol/SLA paths
- health transitions and event emission
- TTL eviction
- stats aggregation
- event subscription filtering and optional `DzupEventBus` forwarding
- identity/URI passthrough fields on registration
- semantic indexing/search/removal for both keyword and vector providers

Observability posture:
- registry emits typed domain events and can forward them to shared event infrastructure
- no built-in metrics collector or tracing instrumentation exists inside `src/registry`

## Risks and TODOs
- `DiscoveryQuery.semanticQuery` is defined but not used in `InMemoryRegistry.discover()` scoring/filtering.
- `registerFromCard()` in `InMemoryRegistry` always throws (`REGISTRY_CARD_FETCH_FAILED`); card-based onboarding is not implemented in this module.
- `update()` treats `undefined` as “no change”, so optional fields cannot be explicitly cleared via update.
- returned agent objects are shallow copies; nested structures (for example arrays/objects under capabilities/metadata) are not deeply cloned.
- generated IDs are process-local (`timestamp + instance counter`), so independent registry instances can produce colliding IDs in the same millisecond.
- vector semantic indexing/deletion intentionally swallows async failures, which avoids hard failures but also hides indexing errors unless callers instrument the underlying store.

## Changelog
- 2026-04-16: automated refresh via scripts/refresh-architecture-docs.js