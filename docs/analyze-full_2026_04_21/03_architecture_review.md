# Architecture Review - dzupagent (2026-04-21)

## Repository Overview
`dzupagent` is a Yarn 1 + Turbo TypeScript monorepo with a framework-first shape, not a single deployable app. The architecture is organized around reusable runtime packages and one large host/runtime package.

Key structural facts from the current tree:

- `29` package manifests under `packages/*` (`30` top-level package directories, one without a manifest).
- `@dzupagent/core` is the central dependency hub (highest internal fan-in across the workspace).
- `@dzupagent/server` is the largest integration point (highest internal fan-out, currently depending on `10` internal packages).
- Server route surface is broad (`66` route `.ts` files, `161` HTTP verb handlers detected under `packages/server/src/routes`).
- Large integration modules are concentrated in server and top-level entrypoints:
  - `packages/server/src/app.ts` (`823` LOC)
  - `packages/server/src/runtime/run-worker.ts` (`785` LOC)
  - `packages/server/src/routes/runs.ts` (`665` LOC)
  - `packages/server/src/routes/learning.ts` (`663` LOC)
  - `packages/core/src/index.ts` (`961` LOC)
  - `packages/server/src/index.ts` (`504` LOC)

Primary runtime entry surfaces:

- Library/API entrypoints across `@dzupagent/*` packages (`dist/index.js` exports).
- HTTP app factory: `createForgeApp` in `@dzupagent/server`.
- Server CLI: `dzup` binary (`@dzupagent/server`).
- Scaffold CLI: `create-dzupagent`.
- UI entrypoint: `@dzupagent/playground` (Vue + Pinia).

## Architectural Overview
At a high level, architecture is layered but intentionally “platform-wide”:

- Foundation/contracts: `@dzupagent/core`, `@dzupagent/context`, `@dzupagent/memory*`, `@dzupagent/runtime-contracts`.
- Agent/runtime execution: `@dzupagent/agent`, `@dzupagent/agent-adapters`, connectors.
- Host/runtime API: `@dzupagent/server` (Hono app, queue worker, route composition, persistence adapters, streaming, operational endpoints).
- Flow/tooling: `@dzupagent/flow-ast`, `@dzupagent/flow-compiler`, `@dzupagent/app-tools`.
- Consumer surfaces: `@dzupagent/playground` and CLIs.

Main flow boundaries are clear conceptually:

1. Request boundary (`/api/runs` in `routes/runs.ts`):
- Validates request, resolves agent, enriches metadata (routing/trace), persists run, enqueues if queue mode is enabled.

2. Execution boundary (`runtime/run-worker.ts` + `RunQueue`):
- Dequeues, applies approval and optional context-transfer hooks, executes via injected `runExecutor`, persists run/log/trace, emits terminal events.

3. Event boundary (`DzupEventBus` -> `InMemoryEventGateway` / WS bridge):
- Normalizes and filters events by run/agent/type for SSE/WS consumers.

4. UI boundary (Playground stores):
- Pinia stores consume REST + WS/SSE and build chat/history/trace/eval/benchmark state.

5. Extension boundary:
- Route plugin mount seam (`ServerRoutePlugin`), queue abstraction (`RunQueue` + in-memory/BullMQ impls), optional platform adapters (Lambda/Vercel/Cloudflare), optional OpenAI-compatible API routes.

So the macro boundary model is solid: `transport -> orchestration -> execution -> event fan-out -> UI/state`.

## Strong Architectural Areas
- Strong package-level decomposition:
  - Clear distinction between reusable core/agent packages and host/server package.
  - Tooling and flow compiler concerns are separated from the runtime host.

- Good contract-first seams:
  - `RunStore`, `AgentStore`, `RunQueue`, `EventGateway`, `RunJournal`, `RunTraceStore` interfaces.
  - Multiple implementations exist for key abstractions (in-memory and Postgres/BullMQ paths).

- Extensibility is deliberate:
  - Route plugin contract (`ServerRoutePlugin`) enables domain routes without hard compile-time coupling.
  - `createForgeApp` supports opt-in subsystems instead of forcing all domains on all deployments.

- Event-driven runtime backbone is mature:
  - Unified event bus + typed envelopes + filterable SSE/WS fan-out.
  - Replay/trace hooks and event subscriptions map well to observability and UI streaming needs.

- Operational concerns are first-class:
  - Health/readiness/metrics, queue dead-letter handling, cancellation, shutdown tracking, and optional durability/reflection hooks are built into runtime flow rather than bolt-ons.

## Architectural Tensions
- Integration gravity around `@dzupagent/server` is high:
  - It acts as runtime host, API façade, domain aggregator, protocol bridge, and operational shell.
  - This creates a “modular monolith inside one package” pattern with high local coupling.

- Composition root concentration:
  - `createForgeApp` performs too much wiring in one file (middleware setup, route registration, feature gating, worker bootstrap, notification auto-registration, scheduler wiring, closed-loop wiring).
  - Adding new features increases cross-cutting cognitive load.

- Route-layer business logic is heavy:
  - `runs.ts`, `learning.ts`, `workflows.ts`, `compile.ts` include orchestration and business decisions that should primarily live in application services.
  - Transport concerns and domain execution concerns are mixed.

- Confirmed layering leak:
  - `LearningEventProcessor` imports `storeLearningPattern` directly from `routes/learning.ts`.
  - This inverts expected dependency direction (service depending on transport module).

- Public API and ownership sprawl:
  - `packages/server/src/index.ts` exports a very broad surface (runtime, persistence, routes, middleware, protocols, adapters, notification internals).
  - This raises accidental coupling risk and makes semver governance harder.

- Contract-domain drift:
  - `@dzupagent/runtime-contracts` is described as “neutral” but includes persona/work-item planning shapes that are closer to product/business domain modeling.
  - Naming and responsibility signal are not fully aligned.

- State-management duplication in Playground:
  - Multiple stores implement similar loading/error/filter/pagination patterns independently.
  - Both `useWebSocket` composable and `ws-store` implement overlapping reconnect/subscription logic.
  - Chat supports WS and SSE streaming paths in parallel, increasing transport branching complexity.

## Domain Boundary Review
Boundary quality by layer:

- Across packages:
  - Generally good. Core interfaces and adapter-based implementations allow clean swaps for persistence/queue/event transport.
  - Dependency graph shows a clear center (`@dzupagent/core`) and a clear host (`@dzupagent/server`), which is expected for this architecture style.

- Inside `@dzupagent/server`:
  - Weaker than package boundaries suggest.
  - Route modules still carry non-trivial orchestration and persistence decisions.
  - Internal boundaries are mostly convention-based rather than structurally enforced.

- Scripted boundary enforcement:
  - `check-domain-boundaries.mjs` prevents imports from extracted domain packages, which is useful.
  - Current guard is coarse-grained; it does not enforce route/service/repository layering within server.

What should remain app-local:

- `@dzupagent/playground` UX-specific state and interaction policies:
  - Selection/filter UI state, view composition behavior, local event buffering behavior, view-specific optimistic behavior.
- CLI UX and terminal ergonomics in `@dzupagent/server` and `create-dzupagent`:
  - Command messaging, interactive flows, help/format decisions.

What should move to shared/domain services (or be extracted from transport modules):

- Learning pattern persistence helpers currently tied to `routes/learning.ts` should move to a service/repository module.
- Run resume/fork/checkpoint orchestration in `routes/runs.ts` should be moved behind a `RunApplicationService`.
- Repeated playground async-store primitives (loading/error/cursor/retry) should move to a small shared client-state utility layer.
- `runtime-contracts` should be split or renamed if it continues to carry persona/feature-planning domain models.

## Operational Architecture Review
Queues and workers:

- Positive:
  - `RunQueue` abstraction is clean.
  - `InMemoryRunQueue` supports priority, retries with backoff, timeout abort, and dead-letter tracking.
  - Worker path handles approval, context transfer, reflection, retrieval feedback, and trace closure.

- Tension:
  - `BullMQRunQueue.cancel()` currently returns `false` (no direct cancel by custom field), so cancellation behavior differs by backend and relies on upstream abort signaling discipline.

Feature flags and runtime configuration:

- Positive:
  - Many subsystems are optional and can be wired only when needed.
- Tension:
  - Runtime behavior is gated by distributed env checks (`USE_DRIZZLE_A2A`, SSE timeout knobs, notification hooks), which increases drift risk and startup ambiguity.

Persistence boundaries:

- Positive:
  - Store interfaces are solid and enable implementation swaps.
- Tension:
  - `drizzle-schema.ts` is a multi-domain schema hub (runs, A2A, triggers/schedules, reflections, marketplace, mailbox, clusters, API keys, vectors) in one module, reducing bounded-context clarity.

Observability hooks:

- Positive:
  - Request metrics middleware, run metrics, traces, event envelopes, health/readiness are integrated through primary flows.
- Tension:
  - Extensive best-effort/suppress-and-log behavior can hide subsystem degradation unless metric/alert coverage is consistent across optional modules.

Error handling and failure isolation:

- Positive:
  - Worker catches and translates failures into explicit run terminal states; optional subsystems fail non-fatally to preserve core execution.
- Tension:
  - Too many non-fatal paths can make silent partial degradation normal unless surfaced through explicit operational SLOs.

Shutdown behavior:

- Positive:
  - Graceful drain model tracks active runs and closes event bridges.
- Tension:
  - `GracefulShutdown` calls `process.exit(0)`, which limits host embedding/composability and can surprise integrators expecting lifecycle control.

## Structural Recommendations
1. Extract a service layer inside `@dzupagent/server` and make routes transport-only.
- Leverage: High
- Risk: Medium
- Start with `runs`, `learning`, `workflows`, `compile` by introducing `services/*-application-service.ts` and moving orchestration logic out of route handlers.

2. Remove the route-to-service inversion in learning flow immediately.
- Leverage: High
- Risk: Low
- Move `storeLearningPattern` out of `routes/learning.ts` into `services/learning-pattern-store.ts` (or repository layer), then consume from both route and processor.

3. Decompose `createForgeApp` into feature installers.
- Leverage: High
- Risk: Medium
- Pattern: `installCoreRoutes`, `installObservability`, `installLearning`, `installA2A`, `installOpenAICompat`, `installMailbox`, etc., with one deterministic mount registry.

4. Split server schema into bounded-context modules with one assembly export.
- Leverage: Medium-High
- Risk: Medium
- Example layout: `persistence/schema/runs.ts`, `a2a.ts`, `marketplace.ts`, `mailbox.ts`, `scheduling.ts`, `auth.ts`, then aggregate in `schema/index.ts`.

5. Introduce a typed runtime config object and startup diagnostics report.
- Leverage: Medium
- Risk: Medium
- Replace scattered env reads with one validated config source and one startup summary of enabled features/flags.

6. Consolidate Playground transport and async-state primitives.
- Leverage: Medium
- Risk: Medium
- Choose one websocket implementation path (`ws-store` or composable wrapper), make SSE fallback a single adapter, and centralize loading/error/cursor policy helpers.

7. Reduce `@dzupagent/server` root export surface into curated entrypoints.
- Leverage: Medium
- Risk: Low-Medium
- Expose targeted subpaths (`/app`, `/runtime`, `/routes`, `/persistence`, `/protocols`) and keep root export minimal for most consumers.

8. Clarify ownership of `@dzupagent/runtime-contracts`.
- Leverage: Medium
- Risk: Low-Medium
- Either split neutral execution contracts from persona/feature-planning contracts, or rename package to reflect actual domain scope.

9. Add finer-grained architecture guardrails.
- Leverage: Medium
- Risk: Low
- Extend existing domain boundary checks to enforce internal layering rules in server (`routes` cannot import from other routes; services cannot depend on route modules).

## Overall Assessment
The architecture is strong at macro decomposition and runtime extensibility, with clear end-to-end flow boundaries and mature operational primitives. Maintainability risk is concentrated in one area: internal layering inside `@dzupagent/server` and duplicated state/transport mechanics in Playground.

Current readiness is **moderate-high** for continued feature growth, but moving to **high** requires reducing server integration concentration, tightening service-vs-transport boundaries, and clarifying bounded contexts in persistence/contracts.