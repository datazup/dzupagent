# ADR-002: AgentRegistry As The Primary Agent Control Plane

**Status:** Decided  
**Date:** 2026-04-23

## Context

`dzupagent` currently has two different models for "managing agents":

| Surface | Current role | Current shape |
|---|---|---|
| `AgentDefinition` / `AgentStore` | Local runnable agent configuration | Small CRUD model with `name`, `instructions`, `modelTier`, `tools`, `approval`, `guardrails`, `metadata` in `packages/core/src/persistence/store-interfaces.ts` and `packages/server/src/routes/agents.ts` |
| `RegisteredAgent` / `AgentRegistry` | Operational fleet registry | Rich control-plane model with endpoint, protocols, capabilities, authentication, SLA, health, TTL, identity, URI, discovery, stats, and event subscriptions in `packages/core/src/registry/types.ts` |

This split is visible in the current product surface:

- `createForgeApp()` mounts `/api/agent-definitions` and the `/api/agents` compatibility alias by default, and can mount `/api/registry` when `registry` is supplied, but registry is still not the default product/operator path in `packages/server/src/app.ts`.
- Runtime execution still resolves `AgentDefinition` in `packages/server/src/runtime/run-worker.ts`.
- Registry routes and a registry health monitor exist, but remain optional/manual and are not the default operator path in `packages/server/src/routes/registry.ts` and `packages/server/src/registry/health-monitor.ts`.
- Playground navigation exposes `/agents`, but not a registry/fleet view in `packages/playground/src/router/index.ts`.

That means the runtime execution path is built around `AgentDefinition`, while the monitoring and management problem space is already modeled more completely by `AgentRegistry`.

The architectural question is: which model should be treated as canonical going forward?

## Decision

**Use `AgentRegistry` / `RegisteredAgent` as the canonical control-plane model for agent management, monitoring, discovery, and fleet operations.**

**Keep `AgentDefinition` / `AgentStore` as the short-term execution-spec model for local runnable agents.**

In practical terms:

1. New management and observability features should attach to `AgentRegistry` first.
2. `AgentDefinition` should remain the materialized runtime view used by the current execution path until run resolution is migrated safely.
3. The system should move toward a registry-led, store-backed design:
   - `RegisteredAgent` = source of truth for managed agents
   - `AgentDefinition` = derived executable projection when local execution requires it

## Rationale

### Why `AgentRegistry`

`AgentRegistry` already models the operational concerns that a real agent control plane needs:

- endpoint identity
- protocols
- capability discovery
- authentication requirements
- SLA targets
- health state
- lifecycle events
- TTL/eviction
- registry statistics

Those concerns are first-class in `packages/core/src/registry/types.ts` and are already supported by registry-oriented persistence and health-monitoring code in `packages/server/src/persistence/postgres-registry.ts` and `packages/server/src/registry/health-monitor.ts`.

This makes `AgentRegistry` the correct long-term boundary for:

- live fleet monitoring
- routing and discovery
- remote agent management
- health-aware selection
- operator-facing control-plane APIs

### Why not make `AgentDefinition` canonical

`AgentDefinition` is intentionally much smaller:

- no endpoint or transport identity
- no health model
- no capability discovery model
- no SLA/auth/protocol metadata
- no registry event lifecycle

It is stable for execution because the current run path already depends on it, but it is too narrow to serve as the long-term operational source of truth.

If the product keeps extending `AgentDefinition` to cover operational concerns, it will gradually re-implement registry semantics in a second place.

### Why keep `AgentDefinition` for now

The current execution path still expects a local runnable object:

- `run-worker.ts` takes `agent: AgentDefinition`
- run creation and execution resolve through `agentStore`
- agent CRUD, fixtures, and tests already assume that smaller model

Replacing that path immediately would create unnecessary churn in the most critical runtime surface.

The safer architecture is to introduce a projection boundary:

- registry owns control-plane truth
- runtime consumes a derived executable shape

## Consequences

### Immediate consequences

- New operator-facing management features should target registry APIs, not `/api/agents`.
- Monitoring work should center on registry health, registry discovery, and registry event streams.
- Any new metadata that is operational in nature should be added to `RegisteredAgent`, not `AgentDefinition`.

### Migration consequences

- `createForgeApp()` should eventually expose a first-class registry installation path rather than treating registry routes as manual-only wiring.
- Playground should grow a registry/fleet management surface and reduce dependence on `AgentDefinition` CRUD as the primary operator UI.
- The run path should eventually resolve from registry entries to executable local definitions via an explicit adapter/projection layer.

### Guardrails

Until the execution path is migrated:

1. Do not remove `AgentStore`.
2. Do not break `/api/runs` by forcing immediate registry-only execution.
3. Do not add new fleet-management semantics to `AgentDefinition` unless they are strictly required by the execution engine.
4. Prefer adapters and mappers over dual-writing business logic into both models.

## Follow-On Work

The cleanup plan for this decision is tracked in:

- [`AGENT_CONTROL_PLANE_ROADMAP_2026-04-23.md`](./AGENT_CONTROL_PLANE_ROADMAP_2026-04-23.md)

That roadmap keeps the current runtime stable while moving the architecture toward a registry-led control plane.
