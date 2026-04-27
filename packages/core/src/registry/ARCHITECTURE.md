# Registry Architecture (`packages/core/src/registry`)

## Scope
This document covers the registry subsystem implemented in `packages/core/src/registry` within `@dzupagent/core`.

In scope:
- Registry contracts and models in `types.ts`
- In-process registry implementation in `in-memory-registry.ts`
- Capability taxonomy and matcher utilities
- Semantic search provider interfaces and implementations in `semantic-search.ts` and `vector-semantic-search.ts`
- Registry exports and direct integration points inside `packages/core/src`

Out of scope:
- Any persistent registry implementation outside this folder
- HTTP/API delivery in other packages

## Responsibilities
The module currently provides:
- Typed agent registration and lifecycle management (`register`, `update`, `deregister`, `evictExpired`)
- Agent discovery with weighted scoring over capabilities, tags, health, and SLA data
- Health snapshot tracking (`getHealth`, `updateHealth`)
- Registry event emission to local subscribers and optional forwarding to `DzupEventBus`
- Reusable capability utilities:
  - standard capability tree (`STANDARD_CAPABILITIES`)
  - hierarchy/wildcard matching (`CapabilityMatcher`)
  - numeric semantic version comparison (`compareSemver`)
- Pluggable semantic search provider contracts plus two implementations:
  - TF-IDF-like keyword fallback
  - vector-backed search via `SemanticStore`

## Structure
- `types.ts`: core contracts and domain types (`RegisteredAgent`, `DiscoveryQuery`, `RegistryEvent`, `AgentRegistry`, `RegistryStats`, etc.)
- `in-memory-registry.ts`: `AgentRegistry` implementation backed by in-memory `Map`, including scoring, filters, event fanout, and TTL eviction
- `capability-taxonomy.ts`: hierarchical standard capability catalog with lookup helpers
- `capability-matcher.ts`: capability hierarchy scoring, wildcard suffix matching, and `compareSemver`
- `semantic-search.ts`: `SemanticSearchProvider` contract and `KeywordFallbackSearch`
- `vector-semantic-search.ts`: `VectorStoreSemanticSearch` implementation using `SemanticStore`
- `index.ts`: barrel exports for the registry surface
- `__tests__/registry.test.ts`: lifecycle, scoring, events, matcher, taxonomy, identity field passthrough
- `__tests__/semantic-search.test.ts`: keyword index/search/remove behavior
- `__tests__/vector-semantic-search.test.ts`: vector provider behavior and failure tolerance

## Runtime and Control Flow
1. Registration path:
- `register` validates `name`, `description`, and non-empty `capabilities`.
- It generates an ID with `agent-${Date.now().toString(36)}-${counter.toString(36)}`.
- It stores a new `RegisteredAgent` with default `health.status = 'unknown'`.
- It emits `registry:agent_registered`.

2. Update path:
- `update` reads the existing agent and rebuilds a new object via spread updates.
- Field updates are tracked in `changedFields`.
- When capabilities are replaced, newly introduced capability names trigger `registry:capability_added`.
- If any field changed, it emits `registry:agent_updated`.

3. Discovery path:
- `discover` applies pre-score filters for `healthFilter` and `protocols`.
- Per-agent scoring uses:
  - `capabilityScore` from `capabilityPrefix` / `capabilityExact` matching
  - `tagScore` from capability tags
  - `healthAdjustment` from status map
  - `slaScore` from comparable SLA fields
- Final score is:
```text
matchScore = capabilityScore * 0.4 + tagScore * 0.2 + healthAdjustment * 0.3 + slaScore * 0.1
```
- Results are sorted descending by `matchScore`, then paginated with `limit`/`offset` defaults (`10`/`0`).
- If query is effectively unfiltered, zero-score agents are still included.

4. Health and lifecycle path:
- `updateHealth` merges patch data and emits `registry:health_changed` only when status changes.
- `deregister` removes agent and emits `registry:agent_deregistered`.
- `evictExpired` removes entries where `registeredAt + ttlMs < now` and emits deregistration with `ttl_expired`.

5. Event fanout path:
- `subscribe` stores filter+handler entries.
- `emitRegistryEvent` notifies matching subscribers; handler exceptions are swallowed.
- When `eventBus` is configured, the event is also emitted on `DzupEventBus`.

6. Semantic provider path (separate from `discover`):
- `KeywordFallbackSearch` tokenizes agent text (name, description, capabilities, tags) and scores query relevance with TF-IDF-like logic.
- `VectorStoreSemanticSearch` indexes/searches collection `agent_registry` through `SemanticStore`.
- Vector `indexAgent` and `removeAgent` are fire-and-forget and intentionally non-fatal.

## Key APIs and Types
- Primary interface:
  - `AgentRegistry`
  - `AgentRegistryConfig`
- Core models:
  - `RegisteredAgent`
  - `RegisterAgentInput`
  - `AgentHealth`, `AgentHealthStatus`
  - `AgentSLA`
  - `AgentAuthentication`
  - `DeregistrationReason`
- Discovery contracts:
  - `DiscoveryQuery`
  - `DiscoveryResult`
  - `DiscoveryResultPage`
  - `ScoreBreakdown`
- Events and subscriptions:
  - `RegistryEventType`
  - `RegistryEvent`
  - `RegistrySubscriptionFilter`
- Registry metrics:
  - `RegistryStats`
- Capability utilities:
  - `STANDARD_CAPABILITIES`
  - `isStandardCapability`
  - `getCapabilityDescription`
  - `listStandardCapabilities`
  - `CapabilityMatcher`
  - `compareSemver`
- Semantic search surface:
  - `SemanticSearchProvider`
  - `KeywordFallbackSearch`
  - `createKeywordFallbackSearch`
  - `VectorStoreSemanticSearch`

## Dependencies
Internal dependencies in this module:
- `../errors/forge-error.js` for typed registry errors
- `../events/event-bus.js` and `../events/event-types.js` for optional bus forwarding type compatibility
- `../identity/index.js` for `ForgeCapability` and `ForgeIdentityRef` typing in registry models
- `../vectordb/semantic-store.js` for vector-backed semantic search

External dependency posture:
- Registry source files do not import third-party libraries directly.
- Vector-backed semantic search depends on a caller-provided `SemanticStore` (embedding provider + vector store + collection setup).

## Integration Points
- Export wiring:
  - `src/registry/index.ts` is re-exported by `src/index.ts`.
  - `InMemoryRegistry`, matcher/taxonomy helpers, and semantic providers are available from the core root export surface.
- Event model integration:
  - Registry event names are included in the global `DzupEvent` union (`src/events/event-types.ts`).
  - `InMemoryRegistry` can emit into shared event pipelines through injected `DzupEventBus`.
- Identity integration:
  - `CapabilityMatcher` is reused by `src/identity/capability-checker.ts` and `src/identity/delegation-manager.ts`.
- Flow contract integration:
  - `src/flow/handle-types.ts` references registry-backed resolution as a source for available handles/tools.
- Semantic integration:
  - Semantic providers integrate with `src/vectordb/*`, but `InMemoryRegistry.discover` currently does not call semantic providers.

## Testing and Observability
Registry-focused tests:
- `src/registry/__tests__/registry.test.ts`
- `src/registry/__tests__/semantic-search.test.ts`
- `src/registry/__tests__/vector-semantic-search.test.ts`
- `src/__tests__/registry-idcounter.test.ts`

Verified behaviors in current tests include:
- Input validation and lifecycle operations (`register`, `update`, `deregister`)
- Numeric semver comparison and hierarchical/wildcard capability matching
- Discovery filters and score ordering across capability/tags/health/protocol/SLA
- Pagination and empty-query behavior
- Health transition events, capability-added events, and event subscription filtering
- TTL eviction and stats aggregation
- Event bus forwarding when registry is constructed with `eventBus`
- Identity/URI persistence in registry records
- Keyword and vector semantic indexing/search/removal behavior, including non-throwing vector failure paths
- Per-instance ID counter behavior (`registry-idcounter`)

Observability posture:
- Registry emits typed domain events and supports optional forwarding to `DzupEventBus`.
- No module-local metrics/tracing collector is implemented in `src/registry`.

## Risks and TODOs
- `DiscoveryQuery.semanticQuery` exists in the type contract but is not consumed by `InMemoryRegistry.discover`.
- `registerFromCard` in `InMemoryRegistry` is intentionally unimplemented and always throws `REGISTRY_CARD_FETCH_FAILED`.
- `update` cannot clear optional fields via `undefined`; `undefined` is treated as "no change."
- Returned objects are shallow copies; nested arrays/objects are not deeply cloned.
- ID generation is process-local timestamp + counter and can collide across separate registry instances in the same millisecond.
- `VectorStoreSemanticSearch` intentionally swallows async indexing/deletion failures, so indexing drift can go unnoticed unless instrumentation exists around `SemanticStore`.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

