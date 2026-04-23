# Agent Naming And Rename Plan (2026-04-23)

## Goal

Reduce ambiguity caused by the same broad names being used for different concepts across `core`, `server`, `playground`, `connectors`, and `agent-adapters`.

This plan is intentionally bounded:

- keep the control-plane vocabulary stable where it is already correct
- rename the ambiguous local/runtime names around it
- avoid a big-bang rename across the whole monorepo

Related decisions:
- [`ADR-002-agent-registry-primary-control-plane.md`](./ADR-002-agent-registry-primary-control-plane.md)
- [`AGENT_CONTROL_PLANE_ROADMAP_2026-04-23.md`](./AGENT_CONTROL_PLANE_ROADMAP_2026-04-23.md)

## Current Tranche Status

Status as of 2026-04-23 after the twelfth focused implementation pass:

- `done`: canonical execution-spec aliases exist in `core`
  - `AgentExecutionSpec`
  - `AgentExecutionSpecFilter`
  - `AgentExecutionSpecStore`
- `done`: canonical resolved-handle alias exists in `core`
  - `ResolvedAgentHandle`
- `done`: server now exposes canonical agent-definition routes on `/api/agent-definitions`
- `done`: server keeps `/api/agents` as a compatibility alias
- `done`: `createAgentDefinitionRoutes` exists and `createAgentRoutes` remains as a compatibility alias
- `done`: playground now uses `/api/agent-definitions` for definition CRUD and active-definition discovery
- `done`: playground now exposes `/agent-definitions` as the canonical UI route and keeps `/agents` as a redirect-only compatibility route
- `done`: playground user-facing labels now distinguish agent definitions from the control-plane agent concept
- `done`: canonical playground files now own the implementation
  - `AgentDefinitionsView.vue`
  - `agent-definitions-store.ts`
- `done`: legacy playground filenames are now thin compatibility wrappers
  - `AgentsView.vue`
  - `agent-store.ts`
- `done`: narrow server/runtime hotspots now use `AgentExecutionSpecStore` / `AgentExecutionSpec` terminology
- `done`: a first small server-side `AgentDefinitionService` seam now owns definition CRUD policy behind the route layer
- `done`: `agent-adapters` now exposes compatibility-first alias exports for the provider-registry vocabulary
  - `ProviderAdapterRegistry`
  - `ProviderAdapterRegistryConfig`
  - `ProviderAdapterHealthDetail`
  - `ProviderAdapterRegistryHealthStatus`
- `done`: adapter-registry lifecycle events now use a separate adapter namespace
  - `adapter_registry:provider_registered`
  - `adapter_registry:provider_deregistered`
- `done`: OTEL/event-metric mappings now distinguish adapter-provider lifecycle from real control-plane registry lifecycle
- `done`: server runtime now resolves execution specs through an explicit `ExecutableAgentResolver` seam
- `done`: high-leverage internal `server` and `core` hotspots now prefer canonical execution-spec and resolved-handle names
  - `packages/server/src/persistence/postgres-stores.ts`
  - `packages/server/src/__tests__/openai-adapter.test.ts`
  - `packages/server/src/routes/openai-compat/__tests__/*`
  - `packages/core/src/flow/__tests__/handle-types.test.ts`
- `done`: `AgentControlPlaneService` now owns the first registry-aware local execution-projection rule
- `done`: `createForgeApp()` now accepts a first-class `registry` config and mounts `/api/registry` when present
- `done`: first-party server tests now teach canonical `/api/agent-definitions` routes by default
- `done`: first-party playground store tests now teach `useAgentDefinitionsStore` by default
- `done`: server docs now present canonical routes first and keep alias routes only as deprecation notes
- `done`: the legacy playground store wrapper now re-exports only `useAgentStore`, so the canonical store is no longer taught through the legacy file path
- `done`: the server root API surface now marks `createAgentRoutes` as deprecated
- `done`: active `agent-adapters` implementation files now prefer `ProviderAdapterRegistry*`
- `done`: focused `agent-adapters` docs and focused tests now teach `ProviderAdapterRegistry*` by default
- `done`: secondary `agent-adapters` architecture docs now teach `ProviderAdapterRegistry*`
- `done`: additional focused tests now teach `ProviderAdapterRegistry*`
  - `provider-execution-port-branches.test.ts`
  - `adapter-plugin-sdk.test.ts`
  - `adapter-plugin-lifecycle.test.ts`
  - `ab-test-runner.test.ts`
- `done`: the next behavioral test cluster now teaches `ProviderAdapterRegistry*`
  - `adapter-lifecycle.test.ts`
  - `adapter-registry-production-gate.test.ts`
  - `workflow-skip.test.ts`
  - `workflow-loop.test.ts`
- `done`: the next integration test cluster now teaches `ProviderAdapterRegistry*`
  - `correlation-warmup.test.ts`
  - `agent-bridge.test.ts`
  - `contract-net.test.ts`
  - `gemini-sdk-adapter.test.ts`
- `done`: the secondary `agent-adapters/docs/analyze_codex.md` doc now teaches `ProviderAdapterRegistry`
- `done`: the router compatibility test now asserts `/agents` redirect behavior directly
- `done`: the legacy playground wrapper files now describe themselves as deprecated compatibility-only entrypoints
- `done`: focused package verification passed for `core`, `agent-adapters`, `otel`, and impacted `server` checks
- `not done`: internal imports across packages still mostly use legacy names
- `not done`: registry implementation/export renames (`InMemoryRegistry`, `PostgresRegistry`) have not started
- `not done`: connectors-side resolver rename has not started
- `not done`: legacy compatibility filenames still exist and need an explicit removal window

## Naming Policy

Use these terms consistently by bounded context:

- `Registry` = live operational control-plane entities
- `Store` = persistence only
- `Definition` or `Spec` = static configuration
- `Handle` = resolved invocation object
- `Resolver` = lookup or projection boundary
- `Catalog` = product/UI listing
- `ProviderAdapter` = execution-provider integration, not a managed agent

## What To Keep

These names are already correct and should remain the anchors of the vocabulary:

- `AgentRegistry`
- `createRegistryRoutes`
- `DiscoveryQuery`
- `RegistryStats`
- `RegistryEvent`

Reason:
- they already name the control-plane concept cleanly in `packages/core/src/registry/types.ts`
- changing them now would create churn without solving the actual ambiguity

## Main Sources Of Ambiguity

### 1. Execution-spec types are named like canonical agents

Current examples:

- `AgentDefinition` in [`packages/core/src/persistence/store-interfaces.ts`](../packages/core/src/persistence/store-interfaces.ts)
- `AgentStore` in [`packages/core/src/persistence/store-interfaces.ts`](../packages/core/src/persistence/store-interfaces.ts)
- `createAgentRoutes` and `/api/agents` in [`packages/server/src/routes/agents.ts`](../packages/server/src/routes/agents.ts)
- `/agents` and `AgentsView` in [`packages/playground/src/router/index.ts`](../packages/playground/src/router/index.ts)

Problem:
- these are not the canonical managed-agent objects anymore
- they represent local runnable configuration, not control-plane fleet records

### 2. Adapter/provider registry uses the same “registry” and “agent” language

Current example:

- `AdapterRegistry` in [`packages/agent-adapters/src/registry/adapter-registry.ts`](../packages/agent-adapters/src/registry/adapter-registry.ts)

Problem:
- this is a provider-adapter routing registry, not an agent control plane
- it currently emits `registry:agent_*` events, which collide conceptually with real `AgentRegistry` events

### 3. Flow/compiler uses `AgentHandle` for a resolved invocation object

Current example:

- `AgentHandle` in [`packages/core/src/flow/handle-types.ts`](../packages/core/src/flow/handle-types.ts)

Problem:
- this is not an agent entity
- it is a resolved callable handle produced by a registry/resolver

### 4. Remote HTTP resolver is named like an in-process registry abstraction

Current example:

- `AgentRegistryAsyncToolResolver` in [`packages/connectors/src/agent-registry-resolver.ts`](../packages/connectors/src/agent-registry-resolver.ts)

Problem:
- it does not implement the registry
- it resolves tools against a remote registry service over HTTP

### 5. Generic implementation names leak domain context

Current examples:

- `InMemoryRegistry`
- `PostgresRegistry`
- `RegistryStore`
- `AgentRow`
- `HealthMonitor`

Problem:
- the repo already has multiple registry-like concepts
- these names are too generic once exported from package boundaries

## Proposed Rename Matrix

### Priority A: Rename now

These remove the most ambiguity for the least conceptual cost.

| Current | Proposed | Scope | Reason |
|---|---|---|---|
| `AgentDefinition` | `AgentExecutionSpec` | `core`, `server`, `playground` | Clarifies that this is local runnable configuration, not the control-plane agent entity. |
| `AgentStore` | `AgentExecutionSpecStore` | `core`, `server` | Makes persistence scope explicit. |
| `AgentFilter` | `AgentExecutionSpecFilter` | `core`, `server` | Keeps filter naming aligned with the renamed store/spec model. |
| `createAgentRoutes` | `createAgentDefinitionRoutes` | `server` | Route factory manages stored definitions, not registry-managed agents. |
| `/api/agents` | `/api/agent-definitions` | `server`, `playground`, docs | Removes operator-facing ambiguity with registry-managed agents. |
| `/agents` | `/agent-definitions` | `playground` | Keeps UI naming aligned with the actual route purpose. |
| `AgentsView` | `AgentDefinitionsView` | `playground` | Reflects current usage accurately. |
| `useAgentStore` / `agent-store.ts` | `useAgentDefinitionsStore` / `agent-definitions-store.ts` | `playground` | Clarifies that the store drives CRUD over definitions, not the fleet registry. |
| `AgentSummary` / `AgentDetail` | `AgentDefinitionSummary` / `AgentDefinitionDetail` | `playground` | Removes type ambiguity in the UI layer. |
| `AdapterRegistry` | `ProviderAdapterRegistry` | `agent-adapters` | Distinguishes provider routing from agent control-plane management. |
| `AdapterRegistryConfig` | `ProviderAdapterRegistryConfig` | `agent-adapters` | Same bounded-context clarification. |
| `AdapterHealthDetail` | `ProviderAdapterHealthDetail` | `agent-adapters` | Explicitly names the health subject. |
| `DetailedHealthStatus` | `ProviderAdapterRegistryHealthStatus` | `agent-adapters` | Avoids another generic “health status” type. |
| `AgentHandle` | `ResolvedAgentHandle` | `core`, `flow-*` | Makes it clear this is a resolved invocation handle, not the agent entity itself. |
| `AgentRegistryAsyncToolResolver` | `RemoteAgentRegistryResolver` | `connectors` | Matches actual behavior: remote HTTP resolver over the registry API. |
| `InMemoryRegistry` | `InMemoryAgentRegistry` | `core` exports | Domain-qualifies a very generic exported name. |
| `PostgresRegistry` | `PostgresAgentRegistry` | `server` exports | Same reason. |
| `RegistryStore` | `AgentRegistryStore` | `server` | Clarifies persistence purpose. |
| `AgentRow` | `RegisteredAgentRow` | `server` | Better matches stored data shape. |
| `HealthMonitor` | `AgentRegistryHealthMonitor` | `server` exports | Reduces exported-name ambiguity. |

### Priority B: Optional second-phase renames

These are useful, but can wait until the first pass is stable.

| Current | Proposed | Reason |
|---|---|---|
| `RegisteredAgent` | keep, or later `ManagedAgent` | `RegisteredAgent` is already acceptable; rename only if service/UI readability still suffers after Priority A. |
| `RegisterAgentInput` | keep, or later `RegisterManagedAgentInput` | Same logic: not urgent if the registry remains the canonical “agent” context. |
| `createRegistryRoutes` | keep | Already correctly scoped. |
| `registry.ts` route module | keep | Module name matches the canonical control plane. |

## Event Taxonomy Cleanup

This is a required rename area, not optional.

Resolved problem:
- `agent-adapters` previously emitted `registry:agent_registered` and `registry:agent_deregistered` from `AdapterRegistry`
- those names overlapped with the real `AgentRegistry` event family in `core`

Relevant references:
- real registry events are defined in `packages/core/src/registry/types.ts`
- adapter registry now emits the separated adapter-provider lifecycle names in `packages/agent-adapters/src/registry/adapter-registry.ts`

Recommendation:

- keep `registry:*` for the real control-plane registry only
- rename adapter-registry events to a provider-adapter family

Recommended event names:

| Current | Proposed |
|---|---|
| `registry:agent_registered` emitted by `AdapterRegistry` | `adapter_registry:provider_registered` |
| `registry:agent_deregistered` emitted by `AdapterRegistry` | `adapter_registry:provider_deregistered` |

Possible future follow-on:
- if more adapter-registry events appear, keep them under the same `adapter_registry:*` namespace

## Observed Drift After Tranche 4

The first four tranches intentionally reduced risk by introducing aliases before doing broad migration. That leaves controlled drift in place, but the highest-value consumer-facing ambiguity is now materially lower and the adapter-vs-control-plane event collision is gone.

### Acceptable temporary drift

1. Dual naming at the type/export layer
- both old and new names exist in `core`, `server`, and `agent-adapters`
- this is acceptable only during the compatibility window

2. Dual route surface on the server and in the playground
- `/api/agent-definitions` is canonical
- `/api/agents` still exists for compatibility
- `/agent-definitions` is canonical
- `/agents` remains as a redirect-only compatibility route
- this is acceptable until external consumers migrate and the alias can be removed on purpose

### Drift still creating confusion

1. Compatibility-wrapper drift
- playground legacy filenames now wrap the canonical modules instead of owning logic
- this is materially better, but it still leaves developer-facing alias surfaces that need a removal decision

2. Internal import drift
- most package-local code still imports `AgentDefinition`, `AgentStore`, and `AgentHandle`
- this is now survivable because aliases exist, but it still hides the new vocabulary from developers

3. Export-surface drift
- registry implementation names are still generic: `InMemoryRegistry`, `PostgresRegistry`, `HealthMonitor`

4. Compatibility-surface drift
- server and playground intentionally carry compatibility exports and routes
- this needs an explicit removal gate rather than indefinite coexistence

5. Naming-surface drift
- canonical names exist for execution specs and provider registries, but many internal files and imports still prefer the legacy names
- this is now the main source of day-to-day developer confusion

6. Worktree drift
- the repo has substantial unrelated in-flight changes outside this program
- that makes broad repo-wide conclusions less reliable unless every tranche uses narrow verification and targeted `rg` ledgers

## Current Legacy Hotspots

The remaining rename debt is now concentrated enough to target by file instead of by broad package area.

Highest-leverage execution-spec hotspots:

- `packages/server/src/persistence/postgres-stores.ts`
  - resolved in tranche 6; now uses `AgentExecutionSpecStore`, `AgentExecutionSpec`, and `AgentExecutionSpecFilter`
- `packages/server/src/__tests__/openai-adapter.test.ts`
  - resolved in tranche 6; the internal test harness now teaches `AgentExecutionSpec*`
- `packages/server/src/routes/openai-compat/__tests__/*`
  - resolved in tranche 6; fixtures now use `AgentExecutionSpec`
- `packages/core/src/flow/index.ts`
  - still re-exports `AgentHandle` intentionally as a compatibility alias
- `packages/server/src/services/agent-control-plane-service.ts`
  - new canonical home for registry-to-execution projection policy
- `packages/core/src/flow/__tests__/handle-types.test.ts`
  - resolved in tranche 6; canonical flow tests now teach `ResolvedAgentHandle`

Highest-leverage provider-registry hotspots:

- `packages/agent-adapters/src/index.ts`
  - still exports `AdapterRegistry` and `DetailedHealthStatus` for compatibility, but canonical exports now come first
- `packages/agent-adapters/src/integration/*`
  - resolved in tranche 9; active integration seams now use `ProviderAdapterRegistry`
- `packages/agent-adapters/src/__tests__/*`
  - focused canonical tests were migrated in tranches 9 and 10; the broader suite still mostly uses `AdapterRegistry`
- `packages/agent-adapters/README.md`
  - resolved in tranche 9; focused examples now teach `ProviderAdapterRegistry`
- `packages/agent-adapters/docs/ARCHITECTURE.md`
  - resolved in tranche 10; secondary package docs now teach `ProviderAdapterRegistry`

## Compatibility Removal Ledger

These are the current first-party consumers that keep the compatibility surfaces alive.

### `/api/agents`

Current first-party consumers:
- `packages/server/src/app.ts`
  - mounts the compatibility alias intentionally
- `packages/server/src/__tests__/routes.test.ts`
  - now contains only explicit alias compatibility coverage
- `packages/server/src/__tests__/agent-routes-branches.test.ts`
  - now contains only explicit alias compatibility coverage
- server docs:
  - `packages/server/README.md`
  - `packages/server/docs/ARCHITECTURE.md`
  - roadmap/ADR docs in `docs/`

Removal gate:
- keep until first-party tests have equivalent canonical-path coverage
- keep until server docs stop teaching the alias except in one deprecation note
- remove only after the app no longer mounts the alias route by default

### `/agents`

Current first-party consumers:
- `packages/playground/src/router/index.ts`
  - compatibility redirect only
- `packages/playground/src/__tests__/router.test.ts`
  - now contains only the explicit legacy redirect assertion
- `packages/playground/docs/ARCHITECTURE.md`
  - documents the legacy redirect
- roadmap/rename docs in `docs/`

Removal gate:
- keep until registry/fleet UI and canonical definition UI are both stable
- keep until router tests no longer depend on the redirect path
- remove only after docs describe the redirect as removed, not active

### `createAgentRoutes`

Current first-party consumers:
- `packages/server/src/index.ts`
  - compatibility re-export only
- docs:
  - `docs/SERVER_API_SURFACE_INDEX.md`
  - capability/export inventories

Removal gate:
- keep until no first-party package imports it
- keep until public API inventories record the removal window
- remove only after one compatibility window with `createAgentDefinitionRoutes` as the only documented factory

### `useAgentStore` and wrapper modules

Current first-party consumers:
- `packages/playground/src/stores/agent-store.ts`
  - compatibility wrapper export
- `packages/playground/src/__tests__/agent-store.test.ts`
  - now contains only the alias-equality compatibility assertion; normal store behavior uses the canonical store
- `packages/playground/src/views/AgentsView.vue`
  - compatibility view wrapper

Removal gate:
- keep until no first-party tests import the alias store/view names
- keep until the playground route redirect and menu/docs no longer refer to legacy naming
- remove wrappers only after the compatibility redirect and alias export are both ready to be deleted in the same wave

## Drift-Control Rules

To minimize drift and maximize code quality during the rename program:

1. Do not rename two bounded contexts in the same PR unless one is only a compatibility alias export.
2. Prefer alias-first changes for exported/public symbols; prefer direct renames only for private/internal code.
3. Every route rename must keep a compatibility path until the main consumer has migrated.
4. Every event-family rename must include the observing metrics/tests in the same wave.
5. Every rename tranche must end with:
   - package-local typecheck
   - focused tests for changed runtime behavior
   - `rg` scan proving the old names are either still intentional aliases or migration debt
6. Canonical names should move in this order:
   - types/interfaces
   - canonical routes
   - primary UI labels/navigation
   - internal imports
   - filenames/module names
   - alias removal
7. Alias removal should happen only after:
   - no first-party package imports the legacy symbol
   - legacy routes are covered by a deprecation note
   - docs explicitly record the removal version/window

## Package-Specific Rename Plan

### `packages/core`

Targets:

1. `AgentDefinition` -> `AgentExecutionSpec`
2. `AgentStore` -> `AgentExecutionSpecStore`
3. `AgentFilter` -> `AgentExecutionSpecFilter`
4. `AgentHandle` -> `ResolvedAgentHandle`
5. `InMemoryRegistry` -> `InMemoryAgentRegistry`

Notes:
- this package should preserve deprecated aliases for one compatibility window because many packages import these types directly

### `packages/server`

Targets:

1. `createAgentRoutes` -> `createAgentDefinitionRoutes`
2. `/api/agents` -> canonical `/api/agent-definitions` with deprecated alias
3. `PostgresRegistry` -> `PostgresAgentRegistry`
4. `RegistryStore` -> `AgentRegistryStore`
5. `AgentRow` -> `RegisteredAgentRow`
6. `HealthMonitor` -> `AgentRegistryHealthMonitor`

Notes:
- route aliases should exist during the deprecation window
- server root exports should expose the new names first and old names as deprecated aliases

### `packages/playground`

Targets:

1. `/agents` -> `/agent-definitions`
2. `AgentsView` -> `AgentDefinitionsView`
3. `agent-store.ts` -> `agent-definitions-store.ts`
4. `AgentSummary` / `AgentDetail` -> `AgentDefinitionSummary` / `AgentDefinitionDetail`

Notes:
- the visible operator terminology should stop using plain “agents” for definition CRUD once a registry/fleet UI exists

### `packages/connectors`

Targets:

1. `AgentRegistryAsyncToolResolver` -> `RemoteAgentRegistryResolver`
2. `AgentRegistryAsyncToolResolverOptions` -> `RemoteAgentRegistryResolverOptions`

Notes:
- keep a deprecated alias because this symbol may be used externally by integrators

### `packages/agent-adapters`

Targets:

1. `AdapterRegistry` -> `ProviderAdapterRegistry`
2. `AdapterRegistryConfig` -> `ProviderAdapterRegistryConfig`
3. `AdapterHealthDetail` -> `ProviderAdapterHealthDetail`
4. `DetailedHealthStatus` -> `ProviderAdapterRegistryHealthStatus`
5. `registry:agent_*` adapter events -> `adapter_registry:*`

Notes:
- this package is the largest non-control-plane source of naming collision
- event rename must be coordinated with any metric bridges and tests

## Migration Strategy

Do not do this as a single giant rename.

### Phase 1: Introduce canonical names with aliases

Actions:

1. Add new type/class/function names in code.
2. Re-export old names as deprecated aliases.
3. Mark deprecated names in TSDoc and package docs.

Exit condition:
- all packages can compile against the new names
- no external surface is broken yet

### Phase 2: Migrate internal imports package by package

Recommended order:

1. `core`
2. `server`
3. `playground`
4. `connectors`
5. `agent-adapters`

Rule:
- complete one package boundary at a time instead of mixing rename waves across the whole repo

Exit condition:
- internal source imports prefer the new names everywhere
- old names remain only as deprecated aliases and compatibility shims

Detailed approach:

1. Migrate source imports first, tests second, docs last within each package.
2. Avoid changing route paths and type names in the same commit unless the route already has a compatibility alias.
3. For each package, maintain a short migration ledger:
   - which old names remain
   - why they remain
   - whether they are internal debt or public compatibility shims

### Phase 3: API and route compatibility window

Actions:

1. Add `/api/agent-definitions` as canonical route.
2. Keep `/api/agents` as a deprecated alias for at least one compatibility window.
3. Add playground redirects from `/agents` to `/agent-definitions`.
4. Update docs and examples to use only the new route names.

Exit condition:
- canonical docs and UI use the new names
- old route continues to function with explicit deprecation notice

### Phase 4: Event-family split

Actions:

1. Rename adapter-registry events to `adapter_registry:*`.
2. Update OTEL/metrics bridges if they observe adapter-registry events.
3. Keep a temporary compatibility mapper if downstream consumers depend on the old event names.

Exit condition:
- `registry:*` means only the real agent control plane
- adapter/provider events no longer masquerade as control-plane registry events

Implementation status:
- done
- adapter-registry now emits `adapter_registry:provider_registered` and `adapter_registry:provider_deregistered`
- OTEL mappings and focused tests were updated in the same wave
- no compatibility mapper was required for first-party packages

### Phase 5: Remove deprecated aliases

Only do this after:

1. internal imports have moved
2. docs and tests use the new names
3. route/event compatibility windows have expired

## Recommended Execution Order

### First tranche

1. `AgentDefinition` -> `AgentExecutionSpec`
2. `AgentStore` -> `AgentExecutionSpecStore`
3. `createAgentRoutes` -> `createAgentDefinitionRoutes`
4. `AdapterRegistry` -> `ProviderAdapterRegistry`
5. `AgentHandle` -> `ResolvedAgentHandle`

Reason:
- these deliver the largest clarity gain and establish the bounded-context vocabulary

Implementation status:
- mostly done
- route compatibility and export aliases are in place
- internal consumer migration is still pending

### Second tranche

1. `/api/agents` -> `/api/agent-definitions`
2. playground `/agents` and `AgentsView` renames
3. `AgentRegistryAsyncToolResolver` -> `RemoteAgentRegistryResolver`
4. `InMemoryRegistry` / `PostgresRegistry` export renames

Reason:
- these touch more public/API surface and should follow once internal naming is stable

Detailed next tasks:

1. Migrate `packages/playground` to canonical terminology and route paths.
Scope:
   - `src/router/index.ts`
   - `src/views/AgentsView.vue`
   - `src/stores/agent-store.ts`
   - matching tests and docs
Expected result:
   - UI uses `/agent-definitions` and “agent definitions” terminology by default
Verification:
   - `yarn workspace @dzupagent/playground test`
   - targeted `rg "/api/agents|/agents|AgentsView|AgentSummary|AgentDetail" packages/playground`

2. Migrate internal `core` and `server` imports to the new execution-spec names.
Scope:
   - private/internal imports only
   - keep public aliases exported
Expected result:
   - developers see `AgentExecutionSpec*` and `ResolvedAgentHandle` in active codepaths
Verification:
   - `yarn workspace @dzupagent/core typecheck`
   - `yarn workspace @dzupagent/server typecheck`
   - targeted `rg "AgentDefinition|AgentStore|AgentFilter|AgentHandle" packages/core packages/server`

3. Add connectors-side resolver alias and migrate internal references where safe.
Scope:
   - `packages/connectors/src/agent-registry-resolver.ts`
   - package exports and tests
Expected result:
   - canonical name becomes `RemoteAgentRegistryResolver`
Verification:
   - `yarn workspace @dzupagent/connectors typecheck`
   - `yarn workspace @dzupagent/connectors test src/__tests__/agent-registry-resolver.test.ts`

4. Rename exported registry implementation names without changing registry semantics.
Scope:
   - `InMemoryRegistry` -> `InMemoryAgentRegistry`
   - `PostgresRegistry` -> `PostgresAgentRegistry`
   - `HealthMonitor` -> `AgentRegistryHealthMonitor`
Expected result:
   - export surface stops leaking generic registry names
Verification:
   - `yarn workspace @dzupagent/core typecheck`
   - `yarn workspace @dzupagent/server typecheck`
   - focused registry tests

Implementation status:
- substantially done
- playground source/tests/docs now use canonical route and terminology by default
- canonical playground files now own the implementation and legacy files are wrappers
- narrow `server` runtime/openai-compat hotspots now use `AgentExecutionSpec*`
- route-owned CRUD behavior is now behind `AgentDefinitionService`
- connectors-side resolver rename and registry implementation/export renames are still pending

### Third tranche

1. adapter event-family rename
2. remaining export cleanup
3. optional second-phase registry type renames if still needed

Reason:
- event renames had the widest observability blast radius and needed to happen before broader control-plane cleanup

Implementation status:
- adapter event-family rename is done
- remaining export cleanup and second-phase registry implementation renames are still pending

Detailed next tasks:

1. Migrate internal imports to canonical execution-spec and provider-registry names.
Scope:
   - `packages/core`
   - `packages/server`
   - `packages/agent-adapters`
Expected result:
   - active codepaths prefer `AgentExecutionSpec*`, `ResolvedAgentHandle`, and `ProviderAdapterRegistry*`
Verification:
   - `yarn workspace @dzupagent/core typecheck`
   - `yarn workspace @dzupagent/server typecheck`
   - `yarn workspace @dzupagent/agent-adapters typecheck`
   - targeted `rg "AgentDefinition|AgentStore|AgentFilter|AgentHandle|AdapterRegistry\\b|DetailedHealthStatus\\b" packages/core packages/server packages/agent-adapters`

2. Rename exported registry implementation classes without changing behavior.
Scope:
   - `InMemoryRegistry` -> `InMemoryAgentRegistry`
   - `PostgresRegistry` -> `PostgresAgentRegistry`
   - `HealthMonitor` -> `AgentRegistryHealthMonitor`
Expected result:
   - the export surface stops leaking generic names in the control-plane package boundary
Verification:
   - `yarn workspace @dzupagent/core typecheck`
   - `yarn workspace @dzupagent/server typecheck`
   - focused registry tests in `core` and `server`

3. Define explicit compatibility-removal gates for wrapper modules, alias exports, and legacy routes.
Scope:
   - `/api/agents`
   - `/agents`
   - `createAgentRoutes`
   - `useAgentStore`
   - wrapper filenames in `packages/playground`
Expected result:
   - compatibility surfaces become scheduled debt with removal criteria instead of indefinite aliases
Verification:
   - docs record removal windows and owner packages
   - `rg` scans show whether each alias still has intentional first-party consumers

4. Introduce a rename ledger for remaining first-party legacy imports.
Scope:
   - update this document with package-by-package counts or explicit hotspots
Expected result:
   - future rename tranches can be scoped by evidence rather than intuition
Verification:
   - targeted `rg` outputs are recorded as the migration ledger

Focused verification already completed for the event-family split:
- `yarn workspace @dzupagent/core typecheck`
- `yarn workspace @dzupagent/agent-adapters typecheck`
- `yarn workspace @dzupagent/agent-adapters test src/__tests__/adapter-registry.test.ts src/__tests__/adapter-registry-circuit-breaker-deep.test.ts src/__tests__/event-bus-bridge.test.ts`
- `yarn workspace @dzupagent/otel test src/__tests__/event-metric-map.test.ts src/__tests__/otel-bridge-extended.test.ts`
- `yarn workspace @dzupagent/server typecheck`
   - package-local typecheck/test remain green

Focused verification completed for tranche 6 hotspot migration:
- `yarn workspace @dzupagent/server typecheck`
- `yarn workspace @dzupagent/server test src/__tests__/postgres-stores.test.ts src/__tests__/openai-adapter.test.ts src/routes/openai-compat/__tests__/routes.test.ts src/routes/openai-compat/__tests__/completions.test.ts`
- `yarn workspace @dzupagent/core typecheck`
- `yarn workspace @dzupagent/core test src/flow/__tests__/handle-types.test.ts`

Focused verification completed for tranche 7 control-plane service wiring:
- `yarn workspace @dzupagent/server typecheck`
- `yarn workspace @dzupagent/server test src/services/__tests__/agent-control-plane-service.test.ts src/services/__tests__/executable-agent-resolver.test.ts src/__tests__/routes.test.ts`

Focused verification completed for tranche 8 alias-reduction wave:
- `yarn workspace @dzupagent/server test src/__tests__/routes.test.ts src/__tests__/agent-routes-branches.test.ts src/__tests__/app-error-handler.test.ts src/__tests__/auth-middleware.test.ts`
- `yarn workspace @dzupagent/playground test src/__tests__/agent-store.test.ts src/__tests__/router.test.ts`
- `yarn workspace @dzupagent/server typecheck`
- `yarn workspace @dzupagent/playground typecheck`

## Verification Plan

For each tranche:

1. Run targeted typecheck for affected packages.
2. Run package-local tests covering renamed routes, exports, and events.
3. Search for old symbol imports/usages and reduce them to approved compatibility aliases only.
4. Update docs in the same wave as the rename.

Suggested command pattern:

- `yarn typecheck --filter=@dzupagent/<package>`
- `yarn test --filter=@dzupagent/<package>`
- `rg "<old-name>" packages docs`

Verification snapshot for tranche 1:

- `yarn workspace @dzupagent/core typecheck` — passed
- `yarn workspace @dzupagent/server typecheck` — passed
- `yarn workspace @dzupagent/agent-adapters typecheck` — passed
- `yarn workspace @dzupagent/server test src/__tests__/routes.test.ts src/__tests__/agent-routes-branches.test.ts` — passed
- `yarn workspace @dzupagent/agent-adapters test src/__tests__/adapter-registry.test.ts` — passed

Verification snapshot for tranche 2:

- `yarn workspace @dzupagent/playground typecheck` — passed
- `yarn workspace @dzupagent/playground test src/__tests__/agent-store.test.ts src/__tests__/agents-view.test.ts src/__tests__/config-tab.test.ts src/__tests__/chat-store.test.ts src/__tests__/useApi.test.ts src/__tests__/useApi-deep.test.ts src/__tests__/router.test.ts` — passed
- `yarn workspace @dzupagent/server typecheck` — passed
- `yarn workspace @dzupagent/server test src/__tests__/routes.test.ts src/__tests__/agent-routes-branches.test.ts` — passed

Verification snapshot for tranche 3:

- `yarn workspace @dzupagent/playground typecheck` — passed
- `yarn workspace @dzupagent/playground test src/__tests__/agent-store.test.ts src/__tests__/agents-view.test.ts src/__tests__/config-tab.test.ts src/__tests__/chat-store.test.ts src/__tests__/useApi.test.ts src/__tests__/useApi-deep.test.ts src/__tests__/router.test.ts` — passed
- `yarn workspace @dzupagent/server test src/__tests__/routes.test.ts src/__tests__/agent-routes-branches.test.ts src/services/__tests__/agent-definition-service.test.ts` — passed
- `yarn workspace @dzupagent/server typecheck` — blocked by existing `@dzupagent/agent-adapters` declaration-resolution errors outside the direct rename/service diff

## Recommended Next Focused Tranche

Objective:
- remove remaining developer-facing drift without widening the compatibility blast radius

Tasks:

1. `packages/agent-adapters`
- migrate the next coherent test cluster from `AdapterRegistry` to `ProviderAdapterRegistry`
- prioritize:
  - `src/__tests__/workflow-timeout.test.ts`
  - `src/__tests__/adapter-workflow.test.ts`
  - `src/__tests__/orchestration-branches-2.test.ts`
  - `src/__tests__/map-reduce.test.ts`
- keep explicit compatibility alias tests separate from normal behavioral tests

2. `packages/playground`
- reduce the remaining alias teaching surfaces to pure compatibility wrappers
- prioritize:
  - `src/views/AgentsView.vue`
  - `src/stores/agent-store.ts`
  - `src/__tests__/agent-store.test.ts`
  - `src/__tests__/router.test.ts`
- do not add new behavior to `/agents` or `useAgentStore`

3. `packages/server` and docs
- keep compatibility aliases visible but clearly secondary
- prioritize:
  - root export inventories
  - deprecation notes that still describe old routes as active surfaces
  - compatibility ledgers for `/api/agents` and `createAgentRoutes`

4. Hold productization expansion until alias drift is smaller
- do not start broad fleet UI work until the remaining alias-teaching surfaces are down to explicit compatibility-only ledgers
- then start a separate productization tranche for registry/fleet UI

Verification:

- `yarn workspace @dzupagent/playground typecheck`
- `yarn workspace @dzupagent/playground test src/__tests__/agent-store.test.ts src/__tests__/agents-view.test.ts src/__tests__/config-tab.test.ts src/__tests__/chat-store.test.ts src/__tests__/useApi.test.ts src/__tests__/useApi-deep.test.ts src/__tests__/router.test.ts`
- `yarn workspace @dzupagent/server typecheck`
- `yarn workspace @dzupagent/server test src/__tests__/routes.test.ts src/__tests__/agent-routes-branches.test.ts`
- `yarn workspace @dzupagent/server test src/services/__tests__/agent-definition-service.test.ts`
- `yarn workspace @dzupagent/server test src/services/__tests__/agent-control-plane-service.test.ts`
- `yarn workspace @dzupagent/server test src/services/__tests__/executable-agent-resolver.test.ts`
- `yarn workspace @dzupagent/agent-adapters typecheck`
- `yarn workspace @dzupagent/agent-adapters test src/__tests__/provider-execution-port-branches.test.ts src/__tests__/adapter-plugin-sdk.test.ts src/__tests__/adapter-plugin-lifecycle.test.ts src/__tests__/ab-test-runner.test.ts`
- `yarn workspace @dzupagent/agent-adapters test src/__tests__/adapter-lifecycle.test.ts src/__tests__/adapter-registry-production-gate.test.ts src/__tests__/workflow-skip.test.ts src/__tests__/workflow-loop.test.ts`
- `yarn workspace @dzupagent/agent-adapters test src/__tests__/correlation-warmup.test.ts src/__tests__/agent-bridge.test.ts src/__tests__/contract-net.test.ts src/__tests__/gemini-sdk-adapter.test.ts`
- `yarn workspace @dzupagent/agent-adapters test src/__tests__/workflow-timeout.test.ts src/__tests__/adapter-workflow.test.ts src/__tests__/orchestration-branches-2.test.ts src/__tests__/map-reduce.test.ts`
- `rg -n "AgentDefinition|AgentStore|AgentHandle|/api/agents|/agents|registry:agent_|AdapterRegistry\\b|DetailedHealthStatus\\b" packages/core packages/server packages/playground packages/agent-adapters`

## Success Criteria

This plan succeeds when:

1. “agent” means the control-plane managed entity by default.
2. execution-spec code no longer looks like the canonical control plane.
3. provider-adapter registry code no longer looks like agent-registry code.
4. flow/compiler handles are clearly named as resolved handles.
5. route names, UI labels, events, and exports all match their bounded context.
