# Agent Control Plane Roadmap (2026-04-23)

## Goal

Move `dzupagent` from a split agent-management model to a coherent control-plane architecture without destabilizing the current execution path.

Decision anchor:
- [`ADR-002-agent-registry-primary-control-plane.md`](./ADR-002-agent-registry-primary-control-plane.md)
- [`AGENT_NAMING_RENAME_PLAN_2026-04-23.md`](./AGENT_NAMING_RENAME_PLAN_2026-04-23.md)

Decision summary:
- `AgentRegistry` is the canonical control plane.
- `AgentDefinition` remains the short-term execution spec.
  Canonical working vocabulary introduced during cleanup:
  - `RegisteredAgent` / `AgentRegistry` for control-plane entities
  - `AgentExecutionSpec` / `AgentExecutionSpecStore` for runtime execution configuration

## Current Status

Status after the twelfth focused cleanup tranche:

- `done`: the repo now has canonical execution-spec naming aliases in `core`
- `done`: the repo now has a canonical server path for agent definitions: `/api/agent-definitions`
- `done`: the legacy `/api/agents` path remains available as a compatibility alias
- `done`: playground now uses the canonical server path and canonical UI route `/agent-definitions`
- `done`: playground navigation and labels now distinguish agent definitions from the control-plane agent concept
- `done`: canonical playground files now own the implementation and legacy files are thin wrappers
- `done`: narrow server/runtime hotspots now use `AgentExecutionSpecStore` / `AgentExecutionSpec`
- `done`: a first `AgentDefinitionService` seam now owns definition CRUD policy behind `routes/agents.ts`
- `done`: the first provider-registry alias exports exist in `agent-adapters`
- `done`: adapter/provider lifecycle events no longer share the real control-plane `registry:*` namespace
- `done`: server runtime now has an explicit `ExecutableAgentResolver` seam with a control-plane-backed default
- `done`: `routes/runs.ts` and `runtime/run-worker.ts` now resolve execution specs through the resolver boundary
- `done`: internal hotspot migration reduced legacy execution-spec naming in persistence, OpenAI-compat tests, and canonical flow-handle tests
- `done`: `AgentControlPlaneService` now owns the first registry-aware execution-projection policy
- `done`: `createForgeApp()` can now mount `/api/registry` through first-class config when `registry` is provided
- `done`: default resolver wiring now goes through the control-plane service instead of a direct store-only resolver
- `done`: normal server CRUD tests now exercise `/api/agent-definitions` by default; `/api/agents` is reduced to explicit compatibility coverage
- `done`: playground store tests now exercise `useAgentDefinitionsStore` by default; `useAgentStore` remains only as a compatibility assertion
- `done`: server docs now teach canonical route mounting first and describe `/api/agents` as compatibility-only
- `done`: the legacy playground store wrapper now re-exports only `useAgentStore`, so the canonical store is no longer taught through the legacy file path
- `done`: the server root export now marks `createAgentRoutes` as deprecated at the root API surface
- `done`: active `agent-adapters` codepaths, focused docs, and focused tests now teach `ProviderAdapterRegistry*` as the primary vocabulary
- `done`: the secondary `agent-adapters/docs/ARCHITECTURE.md` doc now teaches `ProviderAdapterRegistry*`
- `done`: additional focused `agent-adapters` tests now teach `ProviderAdapterRegistry*`
  - `provider-execution-port-branches.test.ts`
  - `adapter-plugin-sdk.test.ts`
  - `adapter-plugin-lifecycle.test.ts`
  - `ab-test-runner.test.ts`
- `done`: the next `agent-adapters` behavioral test cluster now teaches `ProviderAdapterRegistry*`
  - `adapter-lifecycle.test.ts`
  - `adapter-registry-production-gate.test.ts`
  - `workflow-skip.test.ts`
  - `workflow-loop.test.ts`
- `done`: the next `agent-adapters` integration test cluster now teaches `ProviderAdapterRegistry*`
  - `correlation-warmup.test.ts`
  - `agent-bridge.test.ts`
  - `contract-net.test.ts`
  - `gemini-sdk-adapter.test.ts`
- `done`: the secondary `agent-adapters/docs/analyze_codex.md` note now teaches `ProviderAdapterRegistry`
- `done`: the playground router compatibility test now asserts the redirect behavior directly instead of just checking legacy path presence
- `done`: the legacy playground wrapper modules now describe themselves as deprecated compatibility-only entrypoints
- `done`: focused verification passed for the current rename-and-taxonomy cleanup wave
- `in progress`: migration from legacy names to canonical names inside active packages
- `not done`: registry-led operator UI does not exist yet

## Current State

The current system is functionally split:

1. Default server assembly mounts `/api/agent-definitions` and the `/api/agents` compatibility alias, and can now mount `/api/registry` when `registry` is provided in `packages/server/src/app.ts`.
2. Runtime execution now resolves through `ExecutableAgentResolver` and `AgentControlPlaneService`, but the default projection policy still ultimately depends on local execution specs in `packages/server/src/runtime/run-worker.ts` and `packages/server/src/services/agent-control-plane-service.ts`.
3. Registry APIs, persistence, and health monitoring exist, but are not the default product path in `packages/server/src/routes/registry.ts` and `packages/server/src/persistence/postgres-registry.ts`.
4. Playground exposes `/agent-definitions` plus a legacy `/agents` redirect, but has no registry/fleet route in `packages/playground/src/router/index.ts`.
5. Live monitoring is split between optional WebSocket wiring and partial SSE fallback in `packages/server/src/ws/ws-server.ts` and `packages/playground/src/App.vue`.

This leaves the repo with two problems:

- the richer operational model is not the one the product surface defaults to
- the execution model is carrying responsibility that belongs in a control plane

## Current Drift

Important drift after the twelfth tranche:

1. Canonical aliases exist in `core`, but most internal code still imports the legacy execution-spec names.
2. Registry implementation/export names are still generic and can still be confused with non-control-plane registries.
3. Compatibility routes and exports now exist in the right places, but they need an explicit removal plan rather than indefinite coexistence.
4. Registry-backed resolution now exists, but only through explicit metadata projection onto local execution specs; there is still no richer projection/sync model.
5. The next real architecture gain now depends on moving more orchestration into services and then making the control-plane service own more than execution projection.
6. The repo still has substantial unrelated in-flight edits, so every follow-on tranche needs narrow verification and explicit migration ledgers.

Concrete remaining drift hotspots:
- `packages/core/src/flow/index.ts`
  - still exports `AgentHandle` for compatibility
- `packages/server/src/index.ts`
  - still re-exports `createAgentRoutes`, but now marks it deprecated at the root surface
- `packages/playground/src/stores/agent-store.ts`
  - now exports only `useAgentStore` as a compatibility alias; canonical imports no longer come from the legacy file
- `packages/playground/src/views/AgentsView.vue`
  - still exists as a wrapper view
- `packages/server/src/__tests__/routes.test.ts` and `packages/server/src/__tests__/agent-routes-branches.test.ts`
  - still contain the explicit `/api/agents` compatibility assertions
- `packages/playground/src/__tests__/router.test.ts` and `packages/playground/src/__tests__/agent-store.test.ts`
  - still contain the explicit `/agents` redirect and `useAgentStore` compatibility assertions
- `packages/agent-adapters`
  - compatibility aliases still exist, and the remaining workflow/orchestration/deep test suites still mostly teach `AdapterRegistry`

This drift is acceptable only because it is deliberate, documented, and bounded by the next tranche.

## Roadmap

The roadmap keeps the requested three-part structure, but the main weight is on the architectural cleanup tranche because that is the part that prevents future drift.

### 1. Quick Wins

Objective:
- Pin the decision, stop further model drift, and make the split explicit in docs and ownership.

Target window:
- 1 sprint

Actions:

1. Record the canonical model choice in an ADR.
Exit condition:
- registry-led direction is documented and linkable in code reviews and follow-on work.

2. Add explicit terminology to server and playground docs:
- "control plane" means `RegisteredAgent`
- "execution spec" means `AgentDefinition`
Exit condition:
- new work does not describe both objects as equivalent "agents" without qualification.

3. Freeze semantic expansion of `AgentDefinition`.
Rule:
- no new health, endpoint, protocol, SLA, or discovery fields on `AgentDefinition` unless they are required only for execution.
Exit condition:
- operational metadata is added only to registry models.

4. Create a tracked migration backlog grouped by seam:
- route surface
- runtime resolution
- persistence
- playground UI
- realtime observability
Exit condition:
- migration work is no longer hidden inside unrelated feature tickets.

Status:
- effectively done for the current naming/control-plane tranche
- the remaining work is no longer “discover the problem”; it is now “execute the next bounded migration wave”

### 2. Productization Fixes

Objective:
- Make the chosen control plane reachable and trustworthy in default deployments.

Target window:
- 1 to 2 sprints after the quick-win tranche

Actions:

1. Make registry exposure first-class in server composition.
Current blocker:
- `createForgeApp()` can mount `/api/registry` when `registry` is supplied, but registry is still an opt-in surface rather than the default operator path.
Planned change:
- keep the explicit `registry` installer path, but make the surrounding operator workflow treat it as a normal first-class deployment option instead of a sidecar capability.
Exit condition:
- a standard server assembly can expose registry APIs through one documented configuration path, and docs/tests treat that path as first-class.

2. Add a registry/fleet operator surface in playground.
Current blocker:
- router exposes `/agent-definitions`, `/runs`, `/evals`, `/benchmarks`, `/marketplace`, `/a2a`, plus a legacy `/agents` redirect, but no registry/fleet view.
Planned change:
- introduce registry list/detail/discovery/health views and make them the primary operational UI.
Exit condition:
- operators can inspect fleet membership, capabilities, health, and routing inputs from the shipped UI.

3. Align monitoring transports with the control-plane model.
Current blocker:
- playground assumes `/ws` while server default assembly does not mount it; SSE fallback does not feed all live telemetry paths.
Planned change:
- choose a single first-class live transport contract for registry and run monitoring, then make fallback behavior feature-equivalent where practical.
Exit condition:
- default monitoring does not depend on undocumented host wiring.

4. Normalize health/readiness and fleet status contracts.
Current blocker:
- `/api/health/ready` server and playground shapes drift today.
Planned change:
- define one readiness DTO and one registry-health DTO, then consume them directly in playground stores.
Exit condition:
- operational badges and readiness panels are driven by one canonical payload shape.

5. Surface already-implemented run controls from the same operator model.
Current blocker:
- pause, resume, fork, checkpoints, run context, and token reports exist server-side but are not part of the operator UI.
Planned change:
- expose these as part of the broader operations surface rather than as isolated run-detail exceptions.
Exit condition:
- control-plane UI reflects the capabilities already implemented in the runtime.

Detailed next tasks:

1. Introduce a separate registry/fleet route and view instead of overloading definition CRUD.
2. Move health/readiness panels onto canonical DTOs before expanding operator UI.
3. Keep `/api/agents` and `/agents` only as temporary compatibility surfaces while the new UI lands.
4. Keep alias coverage minimal and explicit in tests/docs so compatibility paths remain visible technical debt, not silent defaults.
5. Do not start broad operator-UI expansion until the remaining alias-teaching surfaces are down to thin compatibility ledgers.

Verification:

- route-level server tests for canonical and alias paths
- playground tests updated to canonical route usage
- `rg "/api/agents|/agents"` used as a migration ledger, not just a search
- navigation/router tests proving canonical route registration remains stable

### 3. Architectural Cleanup

Objective:
- remove the structural reasons the control plane is split in the first place.

Target window:
- 2 to 6 sprints, phased

This is the main tranche. The design should be treated as an internal architecture program, not as a single PR.

#### Phase A: Separate managed identity from executable configuration

Problem:
- `RegisteredAgent` and `AgentDefinition` currently overlap without an explicit relationship.

Planned shape:
- `RegisteredAgent` is the canonical managed entity.
- `AgentDefinition` becomes a derived local execution projection.
- introduce an explicit adapter such as `RegisteredAgent -> ExecutableAgentDefinition`.

Required changes:
- add a narrow projection boundary in server runtime code before execution starts
- stop letting route handlers treat registry objects and execution objects as interchangeable
- document whether every registered agent is locally executable, remotely executable, or only discoverable

Exit condition:
- the repo has one source of truth for fleet state and one clearly-derived runtime representation.

Detailed next tasks:

1. Introduce an explicit resolver/projection boundary for execution:
   - example target: `ExecutableAgentResolver`
   - input: registry or definition reference
   - output: local executable spec
2. Stop route handlers from directly implying that stored definitions are the control-plane entity.
3. Define which run paths can execute:
   - local definition only
   - registry-backed local execution
   - remote/discover-only
4. Decide whether `agentStore` remains a persistence dependency behind the resolver or becomes an implementation detail hidden behind a service.

Verification:

- focused server typecheck/tests around run creation and worker startup
- targeted code search showing the resolver is the only place where control-plane objects become execution objects
- explicit tests for resolver behavior across:
  - missing definition
  - inactive definition
  - registry-backed executable resolution
  - discover-only registry entries rejected from local execution

Implementation status:
- the first resolver boundary now exists in `packages/server/src/services/executable-agent-resolver.ts`
- `routes/runs.ts` and `runtime/run-worker.ts` now consume that boundary
- the current implementation is still `AgentStore`-backed; registry-aware resolution is the next step

#### Phase B: Introduce an application service boundary for agent operations

Problem:
- route modules currently own too much orchestration and product policy.

Planned shape:
- create an internal service layer such as:
  - `AgentControlPlaneService`
  - `RegistryDiscoveryService`
  - `ExecutableAgentResolver`
  - `RunOperationsService`

Responsibilities:
- route handlers validate HTTP inputs and map responses
- services own registration, discovery, projection, health coordination, and operator workflows
- runtime worker receives an already-resolved execution object instead of owning lookup policy

Likely hotspots:
- `packages/server/src/app.ts`
- `packages/server/src/routes/agents.ts`
- `packages/server/src/routes/registry.ts`
- `packages/server/src/routes/runs.ts`
- `packages/server/src/runtime/run-worker.ts`

Exit condition:
- transport modules no longer encode the primary control-plane policy.

Detailed next tasks:

1. Expand from the now-existing `AgentDefinitionService` to a separate `AgentControlPlaneService` for registry-backed operations.
2. Keep route handlers thin:
   - parse request
   - call service
   - map response
3. Move cross-route policy decisions into services:
   - canonical-vs-compatibility route policy
   - projection from control-plane model to executable runtime model
   - error normalization for operator workflows
4. Introduce `ExecutableAgentResolver` as the next architecture seam so runtime lookup policy stops living in the worker path.

Verification:

- route modules lose policy/merge logic
- service tests prove behavior without HTTP harnesses
- `app.ts` wiring shows service ownership clearly instead of route-owned orchestration

#### Phase C: Decompose server assembly into deterministic installers

Problem:
- `createForgeApp()` is the composition root for many concerns, but registry is still a side-path instead of a first-class installer.

Planned shape:
- split app assembly into deterministic installers, for example:
  - `installCoreRunRoutes`
  - `installAgentDefinitionRoutes`
  - `installRegistryRoutes`
  - `installObservabilityRoutes`
  - `installRealtimeTransport`
  - `installProtocolAdapters`

Design rule:
- installer boundaries should align with ownership and config contracts, not with arbitrary route file grouping.

Exit condition:
- enabling the agent control plane is an explicit assembly choice rather than scattered route wiring.

#### Phase D: Consolidate persistence around distinct bounded contexts

Problem:
- agent definitions and registry entries currently evolve independently, with no explicit persistence relationship.

Planned shape:
- maintain separate persistence contracts for:
  - execution specs
  - registered fleet entities
  - run state
  - health and telemetry

Required direction:
- keep `AgentStore` narrow
- keep `RegistryStore` authoritative for managed fleet records
- avoid dual-write behavior in route handlers
- move synchronization into one explicit projection/sync component if both stores must coexist

Exit condition:
- persistence reflects architecture boundaries instead of accidental overlap.

#### Phase E: Unify realtime observability under the control plane

Problem:
- monitoring transport and operator state are currently stitched together from several partially overlapping paths.

Planned shape:
- define one event taxonomy for:
  - registry lifecycle
  - registry health
  - run lifecycle
  - approval and recovery actions
  - routing/discovery decisions

Required direction:
- registry events become first-class operator events
- WS/SSE consumers read from one normalized stream model
- playground stores stop duplicating transport semantics

Exit condition:
- live monitoring is a property of the control plane, not a set of special-case store subscriptions.

Detailed next tasks:

1. Split adapter/provider registry events from control-plane registry events.
2. Decide whether WS or SSE is the canonical default transport for operator monitoring.
3. Ensure fallback transport preserves the same event semantics for the operator UI.
4. Introduce one normalized operator-event contract that playground consumes regardless of transport.

Verification:

- event taxonomy tests
- OTEL/event bridge tests
- playground live-monitoring tests against the chosen canonical transport
- compatibility tests proving alias transports/routes still function during migration

Implementation status:
- step 1 is now done for the adapter/provider lifecycle family
- steps 2 to 4 remain architectural follow-on work

## Most Immediate Next Tranche

This is the recommended next implementation slice if work continues immediately.

1. `packages/server`: introduce an explicit execution-resolution boundary
- Why:
  completed in this tranche; the next step is making the resolver own more than a thin store lookup
- Deliverables:
  - `ExecutableAgentResolver` or equivalent
  - a clear input contract for local definition vs registry-backed execution lookup
  - worker/startup paths consuming a resolved execution object instead of owning lookup policy

2. `packages/server`: widen the service seam from definition CRUD to control-plane orchestration
- Why:
  partially completed in this tranche; the next step is widening the service beyond execution projection into route-owned control-plane policy
- Deliverables:
  - `AgentControlPlaneService` or similarly scoped service
  - route handlers limited to request parsing and response mapping
  - control-plane errors normalized outside transport code

3. `packages/core` and `packages/server`: reduce legacy-import drift
- Why:
  canonical names exist, but active code still teaches developers the old vocabulary
- Deliverables:
  - migrate internal imports to `AgentExecutionSpec*` and `ResolvedAgentHandle`
  - prepare implementation/export renames for registry infrastructure classes
  - start with the highest-leverage hotspots:
    - `packages/server/src/persistence/postgres-stores.ts`
    - `packages/server/src/routes/openai-compat/*`
    - `packages/core/src/flow/index.ts` and `packages/core/src/flow/__tests__/handle-types.test.ts`

4. Compatibility governance: turn aliases into scheduled debt
- Why:
  `/api/agents`, `/agents`, `createAgentRoutes`, and wrapper modules should not remain indefinite
- Deliverables:
  - removal windows recorded in docs
  - first-party consumer ledger for each alias
  - explicit conditions for deleting each compatibility surface

Implementation status:
- the first consumer/removal ledger now exists in the rename plan
- the next step is executing one deletion-ready alias wave at a time instead of growing the compatibility surface further

Verification gate for the next tranche:

- `yarn workspace @dzupagent/server typecheck`
- `yarn workspace @dzupagent/server test src/__tests__/routes.test.ts src/__tests__/agent-routes-branches.test.ts`
- `yarn workspace @dzupagent/server test src/services/__tests__/agent-definition-service.test.ts`
- `yarn workspace @dzupagent/server test src/__tests__/run-worker.test.ts src/services/__tests__/executable-agent-resolver.test.ts`
- `yarn workspace @dzupagent/server test src/services/__tests__/agent-control-plane-service.test.ts`
- focused registry-route coverage through `createForgeApp`
- `yarn workspace @dzupagent/core typecheck`
- targeted `rg "agentStore\\.get|AgentDefinition|AgentStore|AgentHandle" packages/server packages/core`
- targeted `rg "/api/agents|/agents|createAgentRoutes|useAgentStore" packages docs`

Verification completed for the just-finished tranche:

- `yarn workspace @dzupagent/core typecheck`
- `yarn workspace @dzupagent/agent-adapters typecheck`
- `yarn workspace @dzupagent/agent-adapters test src/__tests__/adapter-registry.test.ts src/__tests__/adapter-registry-circuit-breaker-deep.test.ts src/__tests__/event-bus-bridge.test.ts`
- `yarn workspace @dzupagent/otel test src/__tests__/event-metric-map.test.ts src/__tests__/otel-bridge-extended.test.ts`
- `yarn workspace @dzupagent/server typecheck`
- `yarn workspace @dzupagent/server test src/__tests__/routes.test.ts src/__tests__/run-worker.test.ts src/services/__tests__/agent-definition-service.test.ts src/services/__tests__/executable-agent-resolver.test.ts`
- `yarn workspace @dzupagent/server test src/__tests__/postgres-stores.test.ts src/__tests__/openai-adapter.test.ts src/routes/openai-compat/__tests__/routes.test.ts src/routes/openai-compat/__tests__/completions.test.ts`
- `yarn workspace @dzupagent/core typecheck`
- `yarn workspace @dzupagent/core test src/flow/__tests__/handle-types.test.ts`
- `yarn workspace @dzupagent/server test src/services/__tests__/agent-control-plane-service.test.ts src/services/__tests__/executable-agent-resolver.test.ts src/__tests__/routes.test.ts`
- `yarn workspace @dzupagent/server test src/__tests__/routes.test.ts src/__tests__/agent-routes-branches.test.ts src/__tests__/app-error-handler.test.ts src/__tests__/auth-middleware.test.ts`
- `yarn workspace @dzupagent/playground test src/__tests__/agent-store.test.ts src/__tests__/router.test.ts`
- `yarn workspace @dzupagent/server typecheck`
- `yarn workspace @dzupagent/playground typecheck`
- `yarn workspace @dzupagent/agent-adapters typecheck`
- `yarn workspace @dzupagent/server typecheck`
- `yarn workspace @dzupagent/playground typecheck`
- `yarn workspace @dzupagent/agent-adapters test src/__tests__/adapter-registry.test.ts src/__tests__/detailed-health.test.ts src/__tests__/architecture-doc.test.ts src/__tests__/provider-execution-port-branches.test.ts`
- `yarn workspace @dzupagent/playground test src/__tests__/agent-store.test.ts`
- `yarn workspace @dzupagent/server test src/__tests__/routes.test.ts src/__tests__/agent-routes-branches.test.ts`
- `yarn workspace @dzupagent/agent-adapters test src/__tests__/provider-execution-port-branches.test.ts src/__tests__/adapter-plugin-sdk.test.ts src/__tests__/adapter-plugin-lifecycle.test.ts src/__tests__/ab-test-runner.test.ts`
- `yarn workspace @dzupagent/playground test src/__tests__/router.test.ts`
- `yarn workspace @dzupagent/agent-adapters test src/__tests__/adapter-lifecycle.test.ts src/__tests__/adapter-registry-production-gate.test.ts src/__tests__/workflow-skip.test.ts src/__tests__/workflow-loop.test.ts`
- `yarn workspace @dzupagent/agent-adapters test src/__tests__/correlation-warmup.test.ts src/__tests__/agent-bridge.test.ts src/__tests__/contract-net.test.ts src/__tests__/gemini-sdk-adapter.test.ts`

## Re-Evaluated Next Focus

What should stop:

- no new features on `/api/agents`, `/agents`, `createAgentRoutes`, or `useAgentStore`
- no broad rename waves that touch multiple bounded contexts at once
- no new docs/examples that teach `AdapterRegistry` as the primary provider-registry symbol

What is actually left to remove:

1. Compatibility-only aliases in public/UI surfaces
- `packages/server/src/index.ts`
- `packages/playground/src/stores/agent-store.ts`
- `packages/playground/src/views/AgentsView.vue`
- explicit compatibility assertions in `packages/server/src/__tests__/*` and `packages/playground/src/__tests__/*`

2. Broad legacy naming in the `agent-adapters` test surface
- the active codepaths are mostly migrated, but many tests still instantiate `AdapterRegistry`
- this is now the biggest remaining naming drift inside active packages

3. Product-vs-architecture mismatch
- registry is the chosen control plane
- the shipped UI still starts from agent-definition CRUD because there is no fleet UI yet

Next focused tasks:

1. Migrate the next coherent `agent-adapters` test cluster to `ProviderAdapterRegistry*`.
Suggested files:
- `workflow-timeout.test.ts`
- `adapter-workflow.test.ts`
- `orchestration-branches-2.test.ts`
- `map-reduce.test.ts`
Verification:
- `yarn workspace @dzupagent/agent-adapters typecheck`
- `yarn workspace @dzupagent/agent-adapters test src/__tests__/workflow-timeout.test.ts src/__tests__/adapter-workflow.test.ts src/__tests__/orchestration-branches-2.test.ts src/__tests__/map-reduce.test.ts`
- `rg -n "AdapterRegistry|DetailedHealthStatus" packages/agent-adapters/src/__tests__ packages/agent-adapters/docs`

2. Prepare the first alias-deletion-ready UI wave.
Suggested files:
- `packages/playground/src/views/AgentsView.vue`
- `packages/playground/src/stores/agent-store.ts`
- `packages/playground/src/__tests__/agent-store.test.ts`
- `packages/playground/src/__tests__/router.test.ts`
Verification:
- `yarn workspace @dzupagent/playground typecheck`
- `yarn workspace @dzupagent/playground test src/__tests__/agent-store.test.ts src/__tests__/router.test.ts`
- `rg -n "useAgentStore|/agents\\b|AgentsView" packages/playground docs`

3. Only after those two waves, start the first registry/fleet UI slice.
Suggested scope:
- registry list
- registry detail
- health summary
Verification:
- server/playground typecheck
- focused route/store tests for registry APIs and UI wiring
- `rg -n "/api/registry|registry" packages/playground packages/server`

#### Phase F: Narrow the public API surface

Problem:
- the server package exposes a broad surface area, which makes internal cleanup harder to do safely.

Planned shape:
- define curated exports for:
  - app composition
  - runtime execution
  - registry/control-plane operations
  - persistence implementations
  - realtime transport

Rule:
- new consumers should depend on the smallest entrypoint that matches their role.

Exit condition:
- control-plane internals can evolve without broad semver blast radius.

## Recommended Sequencing

1. Pin the decision and terminology.
2. Make registry a first-class server capability.
3. Add a projection boundary from registry to execution.
4. Move agent operations into services.
5. Rebuild the playground around the control-plane model.
6. Unify transport and observability around registry-led events.
7. Reduce or deprecate direct operator dependence on `/api/agents`.

## Explicit Non-Goals For This Cleanup

1. Immediate removal of `AgentStore`
2. Immediate rewrite of the run worker
3. Full remote-execution architecture in the same tranche
4. Feature expansion on top of the current split model
5. Adding more operational semantics directly onto `AgentDefinition`

## Completion Criteria

This cleanup should be considered complete only when all of the following are true:

1. `RegisteredAgent` is the documented and implemented source of truth for managed agents.
2. Default server composition exposes a first-class registry control plane.
3. Runtime execution resolves through an explicit registry-to-execution boundary.
4. Playground operational views are built around registry/fleet semantics.
5. Live monitoring and health state use one coherent transport and payload story.
6. `AgentDefinition` is clearly treated as an execution projection, not a second control plane.
