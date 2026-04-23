# Agent Control Plane Roadmap (2026-04-23)

## Goal

Move `dzupagent` from a split agent-management model to a coherent control-plane architecture without destabilizing the current execution path.

Decision anchor:
- [`ADR-002-agent-registry-primary-control-plane.md`](./ADR-002-agent-registry-primary-control-plane.md)

Decision summary:
- `AgentRegistry` is the canonical control plane.
- `AgentDefinition` remains the short-term execution spec.

## Current State

The current system is functionally split:

1. Default server assembly mounts `/api/agents`, but not `/api/registry`, in `packages/server/src/app.ts`.
2. Runtime execution still consumes `AgentDefinition` through `agentStore` in `packages/server/src/runtime/run-worker.ts`.
3. Registry APIs, persistence, and health monitoring exist, but are not the default product path in `packages/server/src/routes/registry.ts` and `packages/server/src/persistence/postgres-registry.ts`.
4. Playground exposes `/agents`, but has no registry/fleet route in `packages/playground/src/router/index.ts`.
5. Live monitoring is split between optional WebSocket wiring and partial SSE fallback in `packages/server/src/ws/ws-server.ts` and `packages/playground/src/App.vue`.

This leaves the repo with two problems:

- the richer operational model is not the one the product surface defaults to
- the execution model is carrying responsibility that belongs in a control plane

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

### 2. Productization Fixes

Objective:
- Make the chosen control plane reachable and trustworthy in default deployments.

Target window:
- 1 to 2 sprints after the quick-win tranche

Actions:

1. Make registry exposure first-class in server composition.
Current blocker:
- `createForgeApp()` mounts `/api/agents` but not `/api/registry`.
Planned change:
- add a first-class registry installer path in `packages/server/src/app.ts`, with explicit config ownership rather than manual host-only wiring.
Exit condition:
- a standard server assembly can expose registry APIs without bespoke boot code.

2. Add a registry/fleet operator surface in playground.
Current blocker:
- router only exposes `/agents`, `/runs`, `/evals`, `/benchmarks`, `/marketplace`, `/a2a`.
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
