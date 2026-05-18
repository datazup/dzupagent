# @dzupagent/server Architecture

## Scope
`@dzupagent/server` is the Hono-based runtime host for DzupAgent in `packages/server`.

The package centers on `createForgeApp` (`src/app.ts`) and provides:
- HTTP composition for core runtime routes (`/api/health`, `/api/runs`, `/api/agent-definitions`, approvals/human-contact paths).
- Optional route families for memory, events/SSE, deploy, learning, evals, benchmarks, playground, A2A, triggers/schedules, prompts/personas/presets, marketplace, reflections, mailbox/clusters, and OpenAI-compatible `/v1/*` APIs.
- Built-in route-plugin seams for MCP, skills, workflow, and compile routes, plus host-supplied `routePlugins`.
- Runtime wiring for queue workers, run executors, event gateway, consolidation scheduler, and closed-loop subscribers.
- Operational and compatibility subpath exports: `@dzupagent/server/ops`, `@dzupagent/server/runtime`, `@dzupagent/server/compat`, and `@dzupagent/server/features`.

Repository boundary note (from `dzupagent/AGENTS.md` and package docs): this package is maintenance/runtime infrastructure, not the primary target for new product control-plane features.

## Responsibilities
Implemented responsibilities in current code:
- Compose a configured app with middleware, core routes, optional routes, and plugin routes (`src/app.ts`, `src/composition/*`).
- Enforce transport/security policy: auth mode checks, CORS policy, security headers, RBAC, rate limiting, JSON body size limits, shutdown guard, and error handling (`src/composition/middleware.ts`).
- Provide run lifecycle hosting: run creation/listing/status, queue handoff, run context, approvals/human contact, and run trace endpoints (`src/routes/runs.ts`, `src/routes/run-context.ts`, `src/routes/approval.ts`, `src/routes/run-trace.ts`).
- Provide realtime event delivery and stream bridge utilities (`src/routes/events.ts`, `src/events/event-gateway.ts`, `src/streaming/sse-streaming-adapter.ts`, `src/ws/*`).
- Start and coordinate background workers/subscribers when configured (`src/composition/workers.ts`).
- Expose operational diagnostics and persistence/tooling utilities via the `./ops` subpath (`src/ops.ts`).

## Structure
Current package layout:
- `src/app.ts`: composition root (`createForgeApp`) and re-exported config types.
- `src/index.ts`: root API surface; re-exports core routes, middleware, queue, websocket, lifecycle, event gateway, and input-guard utilities.
- `src/composition/*`: orchestration helpers split by concern.
- `runtime-config.ts`: default executor/resolver/event-gateway bootstrap.
- `middleware.ts`: policy middleware assembly.
- `core-routes.ts`: always-on route mounts.
- `optional-routes.ts`: optional feature-family route mounts.
- `route-plugins.ts`: built-in and host plugin composition.
- `workers.ts`: run worker, consolidation, closed-loop startup.
- `src/routes/*`: route handlers for runtime and optional features.
- `src/runtime/*`: run worker, executors, tool resolution, quota integration, consolidation tasks.
- `src/queue/*`: in-memory and BullMQ queue implementations.
- `src/middleware/*`: auth, RBAC, rate limit, identity/capability, tenant scope.
- `src/persistence/*`: Drizzle schemas and store implementations.
- `src/ws/*` and `src/events/*`: WS bridge/control and event fan-out.
- `src/services/*`, `src/notifications/*`, `src/deploy/*`, `src/registry/*`, `src/cli/*`, `src/a2a/*`, `src/marketplace/*`, `src/platforms/*`.
- `docs/ARCHITECTURE.md`: this architecture document.

Package entrypoints from `package.json` exports:
- `@dzupagent/server` -> `dist/index.js`
- `@dzupagent/server/ops` -> `dist/ops.js`
- `@dzupagent/server/runtime` -> `dist/runtime.js`
- `@dzupagent/server/compat` -> `dist/compat.js`
- `@dzupagent/server/features` -> `dist/features.js`

## Runtime and Control Flow
`createForgeApp(config)` flow in current implementation:
1. Preflight and safety setup.
- Enforces explicit framework auth requirements for production (`assertExplicitFrameworkApiAuth`).
- Warns for unbounded in-memory retention.
- Attaches runtime safety monitor unless disabled.
- Attaches compliance audit logger when `auditStore` is configured.

2. Runtime bootstrap defaults (`buildRuntimeBootstrap`).
- Resolves `eventGateway` to `InMemoryEventGateway` if not provided.
- Resolves run executor to `createDzupAgentRunExecutor` with `createDefaultRunExecutor` fallback.
- Resolves executable agent resolver to `ControlPlaneExecutableAgentResolver(AgentControlPlaneService)` if missing.

3. Worker/subscriber startup.
- Starts run worker once per `runQueue` instance (`WeakSet` guard).
- Starts consolidation scheduler and optional `/api/health/consolidation` status endpoint (when consolidation + shutdown are configured).
- Starts `promptFeedbackLoop` and `learningEventProcessor` when supplied.

4. Middleware application order (`applyMiddleware`).
- CORS (opt-in; wildcard production usage gated by `allowWildcardCors`).
- Security headers (default on; configurable/disableable).
- `/api/*` auth and RBAC (RBAC defaults on unless `rbac: false`).
- Rate limiter (`/api/*`, plus `/a2a*` and `/v1/*` when relevant features are enabled).
- JSON body-size guard with route-specific overrides.
- Shutdown guard for `POST /api/runs`.
- Request metrics instrumentation.
- Global error handler.

5. Route mount order.
- Core routes first (`mountCoreRoutes`).
- Optional route families next (`mountOptionalRoutes`).
- Built-in route plugins (MCP/skills/workflows/compile), then host plugins (`routePlugins`).
- Prometheus `/metrics` only when collector is Prometheus and access policy is enabled.

6. Run execution path (when queue configured).
- `POST /api/runs` persists/enqueues run request.
- `startRunWorker` processes jobs, resolves executable agent, applies input guard and resource checks, executes run, persists logs/traces/outcomes, and emits lifecycle events.

## Key APIs and Types
Primary app host API:
- `createForgeApp(config: ForgeServerConfig): Hono<AppEnv>`

Configuration types (from `src/composition/types.ts`, re-exported by `src/app.ts`):
- `ForgeServerConfig` (aggregate).
- `ForgeHostRuntimeConfig` (narrower host-runtime seam).
- Feature-family config groups:
- `ForgeMemoryRouteFamilyConfig`
- `ForgeCompatibilityRouteFamilyConfig`
- `ForgeEvaluationRouteFamilyConfig`
- `ForgeAdapterRouteFamilyConfig`
- `ForgeAutomationRouteFamilyConfig`
- `ForgeControlPlaneRouteFamilyConfig`

Route plugin seam:
- `ServerRoutePlugin` and `ServerRoutePluginContext` (`src/route-plugin.ts`).

Core route factories exported at root:
- `createRunRoutes`, `createAgentDefinitionRoutes`, `createApprovalRoutes`, `createHealthRoutes`, `createEventRoutes`.

Runtime/queue exports:
- `InMemoryRunQueue`, `BullMQRunQueue`, `RunQueue` types.
- `startRunWorker`, `createDefaultRunExecutor`, `createDzupAgentRunExecutor` (also available via `@dzupagent/server/runtime`).

Operational exports:
- Doctor and scorecard APIs, metrics route/collector, persistence helpers, deploy/registry helpers, and CLI utilities via `@dzupagent/server/ops`.

Compatibility export:
- OpenAI-compatible mapper/routes/auth types via `@dzupagent/server/compat`.

## Dependencies
From `packages/server/package.json`:
- Core internal dependencies:
- `@dzupagent/agent`, `@dzupagent/agent-adapters`, `@dzupagent/app-tools`, `@dzupagent/context`, `@dzupagent/core`, `@dzupagent/eval-contracts`, `@dzupagent/flow-ast`, `@dzupagent/flow-compiler`, `@dzupagent/hitl-kit`, `@dzupagent/memory-ipc`, `@dzupagent/otel`, `@dzupagent/security`.
- Third-party runtime dependencies:
- `hono`, `drizzle-orm`, `commander`, `@langchain/core`.
- Peer dependencies:
- `postgres` (for Postgres-backed stores), `bullmq` (optional, for Redis queue mode).
- Optional dependencies:
- `@dzupagent/codegen`, `@dzupagent/connectors`, `@dzupagent/memory`.
- Tooling:
- `typescript`, `tsup`, `vitest`, `drizzle-kit`, `testcontainers`.

## Integration Points
Main integration seams:
- Host app wiring through `createForgeApp` with injected stores, registry, event bus, model registry, queue, and security policies.
- Persistence strategy swap between in-memory stores and Drizzle/Postgres stores.
- Queue strategy swap between `InMemoryRunQueue` and `BullMQRunQueue`.
- Route extensibility through `routePlugins` (app-owned routes mounted after built-ins).
- Optional protocol/feature surfaces:
- A2A routes.
- OpenAI-compatible `/v1/*` routes.
- MCP/skills/workflow/compile route plugins.
- Platform adapters for serverless hosts: Lambda, Vercel, Cloudflare.

## Testing and Observability
Testing:
- Test runner is Vitest (`vitest.config.ts`).
- Extensive package-local suite under `src/__tests__/` with additional domain-local tests in subfolders.
- Scripts in `package.json`: `test`, `test:watch`, `test:coverage`, plus `typecheck`, `lint`, `build`.

Observability and diagnostics in code:
- Health routes:
- `GET /api/health`
- `GET /api/health/ready`
- `GET /api/health/metrics`
- Optional `GET /api/health/consolidation` when consolidation scheduler + shutdown are configured.
- Event streaming via `EventGateway` and `/api/events/stream`.
- Optional Prometheus exposition route `GET /metrics` (gated by collector type and access policy).
- CLI operational diagnostics via `dzup doctor` and scorecard tooling.

## Risks and TODOs
Current code-grounded risks or maintenance gaps:
- Health route version drift: `src/routes/health.ts` liveness payload currently returns `version: '0.1.0'` while package version is `0.2.0`.
- Route surface breadth: `optional-routes.ts` still mounts many compatibility/control-plane families in this package; maintainers should keep new product features on app-owned routes via `routePlugins` rather than growing server-owned route families.
- Configuration complexity: `ForgeServerConfig` remains broad for compatibility; incorrect combinations (auth/CORS/rate-limit/OpenAI/A2A settings) can cause policy surprises without focused integration tests.
- Queue/runtime operational coupling: worker and closed-loop subscribers are auto-started when configured; host processes should ensure lifecycle/shutdown hooks are consistently wired.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

