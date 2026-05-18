# Registry Architecture (`packages/core/src/registry`)

## Scope
This document describes the registry subsystem in `packages/core/src/registry`.

Included:
- Public registry contracts and exports in `index.ts` and `types.ts`.
- In-memory registry implementation and helper modules:
  - `in-memory-registry-core.ts`
  - `in-memory-registry-errors.ts`
  - `in-memory-registry-events.ts`
  - `in-memory-registry-mutations.ts`
  - `in-memory-registry-queries.ts`
  - `in-memory-registry-scoring.ts`
  - `in-memory-registry-types.ts`
  - `in-memory-registry.ts` (re-export surface)
- Capability taxonomy and matching utilities:
  - `capability-taxonomy.ts`
  - `capability-matcher.ts`
- Semantic-search contracts and implementations:
  - `semantic-search.ts`
  - `vector-semantic-search.ts`
- Tests:
  - `src/registry/__tests__/registry.test.ts`
  - `src/registry/__tests__/semantic-search.test.ts`
  - `src/registry/__tests__/vector-semantic-search.test.ts`
  - `src/__tests__/registry-idcounter.test.ts`

Out of scope:
- Any persistent/remote registry implementation.
- HTTP/API route layers outside `packages/core`.

## Responsibilities
The registry subsystem provides:
- A typed `AgentRegistry` contract for registration, updates, discovery, health updates, subscriptions, listing, TTL eviction, and stats.
- An in-process `InMemoryRegistry` implementation backed by a `Map<string, RegisteredAgent>`.
- Discovery ranking based on capability, tag, health, and SLA scoring.
- Typed registry domain events with in-process subscriptions and optional forwarding to `DzupEventBus`.
- Shared capability utilities:
  - standard taxonomy lookup/listing,
  - hierarchical and wildcard matching,
  - numeric semver comparison.
- Semantic-search provider building blocks:
  - keyword fallback (`KeywordFallbackSearch`),
  - vector-backed implementation (`VectorStoreSemanticSearch`).

## Structure
- `index.ts`
  - Barrel exports for registry types, matcher/taxonomy helpers, `InMemoryRegistry`, and semantic search providers.
- `types.ts`
  - Public contracts: `RegisteredAgent`, `RegisterAgentInput`, `DiscoveryQuery`, `RegistryEvent` union, `RegistryStats`, and `AgentRegistry`.
  - `CapabilityDescriptor` alias to `ForgeCapability`.
- `in-memory-registry-core.ts`
  - `InMemoryRegistry` class and lifecycle orchestration.
- `in-memory-registry.ts`
  - Backward-compatible module that re-exports `InMemoryRegistry` plus helper functions/types from split modules.
- `in-memory-registry-errors.ts`
  - Validation and error helpers using `ForgeError`:
    - `REGISTRY_INVALID_INPUT`
    - `REGISTRY_AGENT_NOT_FOUND`
    - `REGISTRY_CARD_FETCH_FAILED`
- `in-memory-registry-events.ts`
  - Subscription filter matching (`matchesFilter`) and fan-out/forwarding (`dispatchRegistryEvent`).
- `in-memory-registry-mutations.ts`
  - Pure mutation helpers:
    - `buildRegisteredAgent`
    - `applyUpdateChanges`
- `in-memory-registry-queries.ts`
  - Pure query helpers:
    - `discoverAgents`
    - `computeRegistryStats`
    - `findExpiredAgents`
- `in-memory-registry-scoring.ts`
  - Discovery scoring primitives:
    - `isUnfilteredQuery`
    - `healthScore`
    - `scoreAgent`
    - `computeMatchScore`
- `in-memory-registry-types.ts`
  - Internal `Subscription` shape.
- `capability-taxonomy.ts`
  - `STANDARD_CAPABILITIES` tree + lazy flattened index.
- `capability-matcher.ts`
  - `CapabilityMatcher` and `compareSemver`.
- `semantic-search.ts`
  - `SemanticSearchProvider` interface + `KeywordFallbackSearch`.
- `vector-semantic-search.ts`
  - `VectorStoreSemanticSearch` over `SemanticStore` collection `agent_registry`.

## Runtime and Control Flow
1. Registration
- `register(input)` validates required fields with `assertValidRegistrationInput`.
- IDs are generated as `agent-${Date.now().toString(36)}-${idCounter.toString(36)}`.
- `buildRegisteredAgent` creates a new immutable snapshot with:
  - `health.status = 'unknown'`
  - copied arrays/objects for capabilities, protocols, SLA, metadata, identity.
- Snapshot is stored in `agents` map and `registry:agent_registered` is emitted.

2. Update flow
- `update(agentId, changes)` resolves the current record via `getRegisteredAgentOrThrow`.
- `applyUpdateChanges` returns:
  - `updated` snapshot
  - `changedFields`
  - `addedCapabilities` (by capability name)
- For each added capability, `registry:capability_added` is emitted.
- Updated snapshot replaces existing map value.
- If `changedFields.length > 0`, `registry:agent_updated` is emitted.

3. Discovery flow
- `discover(query)` delegates to `discoverAgents`.
- Pre-scoring filters:
  - `healthFilter` against `agent.health.status`
  - `protocols` against `agent.protocols`
- Scoring:
  - `capabilityScore`
    - prefix matching uses `CapabilityMatcher.match`
    - exact/min-version matching uses `compareSemver`
  - `tagScore` from capability tags
  - `healthAdjustment` from `healthScore`
  - `slaScore` from comparable SLA fields
- Final score:

```text
capabilityScore * 0.4 + tagScore * 0.2 + healthAdjustment * 0.3 + slaScore * 0.1
```

- Results with positive score are kept; for unfiltered queries (`isUnfilteredQuery`) zero-score results are also kept.
- Results are sorted descending by score and paginated using `offset`/`limit` (defaults `0`/`10`).

4. Health and lifecycle
- `updateHealth` merges partial health, updates `lastUpdatedAt`, and emits `registry:health_changed` only when `status` changed.
- `deregister` removes the agent and emits `registry:agent_deregistered`.
- `evictExpired` removes agents whose `registeredAt + ttlMs` is older than `now` and emits deregistration with reason `ttl_expired`.
- `registerFromCard` currently always throws `REGISTRY_CARD_FETCH_FAILED` in this implementation.

5. Event dispatch
- `subscribe(filter, handler)` stores subscriptions in an internal `Set`.
- `dispatchRegistryEvent`:
  - delivers to matching subscribers using `matchesFilter`
  - swallows subscriber exceptions (non-fatal behavior)
  - forwards to `eventBus.emit(...)` when registry was created with `{ eventBus }`.

6. Semantic search providers
- `KeywordFallbackSearch`
  - indexes agent text (`name`, `description`, capability names/descriptions/tags),
  - tokenizes query text,
  - scores via TF-IDF-style weighting.
- `VectorStoreSemanticSearch`
  - delegates query embedding to `semanticStore.embedding.embedQuery`,
  - searches vector store collection `agent_registry`,
  - indexes/removes agents with fire-and-forget async `upsert`/`delete`.
- `InMemoryRegistry.discover` does not call `SemanticSearchProvider` today; semantic provider wiring is separate.

## Key APIs and Types
Main public API:
- `InMemoryRegistry` (`implements AgentRegistry`)

Core types:
- `AgentRegistry`, `AgentRegistryConfig`
- `RegisteredAgent`, `RegisterAgentInput`
- `AgentHealth`, `AgentHealthStatus`
- `AgentSLA`, `AgentAuthentication`
- `DeregistrationReason`
- `DiscoveryQuery`, `DiscoveryResult`, `DiscoveryResultPage`, `ScoreBreakdown`
- `RegistryEventType`, `RegistryEvent`, `RegistrySubscriptionFilter`
- `RegistryStats`

Capability utilities:
- `STANDARD_CAPABILITIES`
- `isStandardCapability(name)`
- `getCapabilityDescription(name)`
- `listStandardCapabilities()`
- `CapabilityMatcher`
- `compareSemver(a, b)`

Semantic-search APIs:
- `SemanticSearchProvider`
- `KeywordFallbackSearch`
- `createKeywordFallbackSearch()`
- `VectorStoreSemanticSearch`

## Dependencies
Internal dependencies in this subsystem:
- `../errors/forge-error.js` for typed domain errors.
- `../events/event-bus.js` and `../events/event-types.js` for optional event forwarding.
- `../identity/index.js` type imports (`ForgeCapability`, `ForgeIdentityRef`).
- `../vectordb/semantic-store.js` for vector-backed semantic search.

Dependency characteristics:
- Registry modules themselves do not import third-party packages directly.
- Vector/embedding provider specifics stay behind `SemanticStore` abstractions.
- `@dzupagent/core` package-level dependencies relevant here are internal workspace packages (`@dzupagent/agent-types`, `@dzupagent/runtime-contracts`, `@dzupagent/security`), while vector/LLM libraries are peer dependencies and consumed by other layers.

## Integration Points
Public export integration:
- Registry APIs are exported from:
  - `src/index.ts` (main `@dzupagent/core` entry)
  - `src/pipeline.ts` (`@dzupagent/core/pipeline` surface)
- `package.json` does not expose a dedicated `./registry` subpath export; consumers access registry APIs through the main or pipeline entrypoints.

Internal integration in `packages/core`:
- Registry event shapes are included in `src/events/event-types-platform.ts` (`PlatformDomainEvent` union).
- `CapabilityMatcher` is reused by identity modules:
  - `src/identity/capability-checker.ts`
  - `src/identity/delegation-manager.ts`
- `AgentRegistry` is referenced in flow handle contracts (`src/flow/handle-types.ts`) as a resolver source for `ResolvedAgentHandle`.
- `VectorStoreSemanticSearch` composes with `src/vectordb/semantic-store.ts`.

## Testing and Observability
Test coverage in scope:
- `registry.test.ts`
  - semver comparison
  - capability matcher and taxonomy helpers
  - `InMemoryRegistry` lifecycle (`register`, `update`, `deregister`, `listAgents`, `discover`, `updateHealth`, `evictExpired`, `stats`, `registerFromCard`)
  - subscription filtering and unsubscribe behavior
  - event bus forwarding
  - identity/URI registration behavior
- `semantic-search.test.ts`
  - keyword indexing, relevance scoring, removal, and limit behavior.
- `vector-semantic-search.test.ts`
  - embedding delegation, index/search/remove behavior, and non-throwing upsert/delete failure paths.
- `registry-idcounter.test.ts`
  - per-instance `idCounter` isolation semantics.

Observability:
- Registry emits typed `RegistryEvent` values and can bridge them into `DzupEventBus`.
- No dedicated metrics/tracing/logging instrumentation exists in `src/registry`; operational visibility depends on subscribers and event-bus consumers.

## Risks and TODOs
- `DiscoveryQuery.semanticQuery` exists but is not currently consumed by `discoverAgents`/`scoreAgent`.
- `registerFromCard` is intentionally unimplemented in `InMemoryRegistry` and always throws.
- `update` treats `undefined` as "no change"; there is no explicit clear/remove operation for optional fields.
- Returned objects are shallow copies; nested mutable structures are not deep-frozen.
- `slaFilter` contributes to score rather than hard-filtering non-compliant agents.
- TTL expiration uses `registeredAt`, not `lastUpdatedAt`, so updates do not extend TTL.
- ID generation is process-local and time-based; collisions across independent processes are still possible.
- `VectorStoreSemanticSearch` swallows async `upsert`/`delete` errors, so vector index drift can be silent without external monitoring.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-05-17: full rewrite aligned to current `packages/core/src/registry` implementation, exports, and tests.