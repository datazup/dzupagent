# @dzupagent/server Architecture

## Scope
`@dzupagent/server` is the Hono-based hosting package for DzupAgent runtime capabilities in `packages/server`.

This package currently provides:
- The app factory (`createForgeApp`) that composes middleware, route modules, runtime workers, and optional integrations.
- HTTP APIs for health, agent definitions, run lifecycle, approvals, events/SSE, and additional optional feature planes.
- Runtime orchestration glue around queue workers, run executors, event gateway, consolidation scheduling, and closed-loop subscribers.
- Operational helpers (doctor/scorecard via `./ops` export), CLI commands, persistence implementations, and deployment/registry helpers.

Boundary note from repo guidance:
- `packages/server` is maintained as framework/runtime compatibility infrastructure, not the primary landing zone for new application product features.

## Responsibilities
Primary responsibilities implemented in this package:
- Compose a runnable HTTP app from stores, event bus, model registry, and optional integration config.
- Expose run-management and agent-definition APIs, including approval and human-contact controls.
- Provide real-time event delivery through SSE routes backed by an `EventGateway`.
- Bridge authentication and authorization layers (`auth`, RBAC, tenant scoping, identity/capability helpers) into route enforcement.
- Host optional runtime modules: memory, learning, evals, benchmarks, deploy confidence/history, prompts/personas/presets, mailbox/clusters, schedules/triggers, marketplace, A2A, MCP/skills/workflows.
- Start and coordinate background runtime workers when configured (run queue worker, consolidation scheduler, learning/prompt loops, mail DLQ worker).
- Provide persistence adapters and schemas for Postgres/Drizzle and in-memory fallbacks used by route/runtime modules.

## Structure
Current source layout (top-level modules under `src/`):
- `app.ts`: composition entrypoint (`createForgeApp`).
- `composition/*`: split orchestration helpers (`runtime-config`, `middleware`, `core-routes`, `optional-routes`, `route-plugins`, `workers`, `notifications`, `safety`).
- `routes/*`: HTTP route families (runs, agents, approvals, health, events, memory, evals, benchmarks, deploy, OpenAI-compat, etc.).
- `runtime/*`: run execution pipeline, tool resolution, quota integration, consolidation tasks.
- `queue/*`: `InMemoryRunQueue` and `BullMQRunQueue`.
- `middleware/*`: auth, rate-limiter, RBAC, tenant-scope, identity/capability.
- `events/*` and `ws/*`: event gateway and websocket control/bridge utilities.
- `persistence/*`: Drizzle schemas and stores (run traces, API keys, registry, reflections, mailbox, cluster, workflow domain, vectors).
- `services/*`: control-plane and learning-related services.
- `deploy/*`, `registry/*`, `notifications/*`, `triggers/*`, `schedules/*`, `a2a/*`, `marketplace/*`, `scorecard/*`, `docs/*`, `platforms/*`, `cli/*`.
- `__tests__/*` plus domain-local test folders.

Public package entrypoints:
- `.` -> `dist/index.js` (`src/index.ts` export surface).
- `./ops` -> `dist/ops.js` (doctor/scorecard operational facade).

## Runtime and Control Flow
`createForgeApp(config)` in `src/app.ts` is the composition root. Current execution order:

1. Runtime safety and defaults:
- Warn on explicit unbounded in-memory retention (`warnIfUnboundedInMemoryRetention`).
- Attach safety monitor unless `disableSafetyMonitor` is set.
- Build runtime defaults in `buildRuntimeBootstrap`:
  - `eventGateway`: defaults to `InMemoryEventGateway(eventBus)`.
  - `runExecutor`: defaults to `createDzupAgentRunExecutor({ fallback: createDefaultRunExecutor(modelRegistry) })`.
  - `executableAgentResolver`: defaults to control-plane resolver over `AgentControlPlaneService`.

2. Worker/bootstrap lifecycle:
- Start queue worker once per queue instance (`maybeStartRunWorker`, guarded by `WeakSet`).
- Start consolidation scheduler when configured; expose `/api/health/consolidation` only when shutdown handling is also configured.
- Start prompt feedback and learning event processors when injected.

3. Middleware stack (`applyMiddleware`):
- CORS (`*`) with warning when open wildcard/default is used.
- `/api/*` auth (when configured), with optional API key store auto-wiring.
- `/api/*` RBAC by default (can disable via `rbac: false`).
- `/api/*` rate limiting (when configured).
- `/api/runs` shutdown write guard for POST during drain.
- Global request metrics instrumentation (when metrics collector provided).
- Global error handler.

4. Route mounting:
- Always mounted core routes: `/api/health`, `/api/runs`, `/api/agent-definitions`, `/api/agents` (compat alias), approvals/human-contact/enrichment routes, plus conditional `/api/registry`, `/api/keys`, `/api/approvals`, run trace routes.
- Optional routes from integration config: memory, deploy, learning, benchmarks, evals, playground, A2A, triggers/schedules, prompts/personas/presets/marketplace, reflections, mailbox/clusters.
- Events route is mounted by default via optional route layer (`/api/events/stream`) using the resolved event gateway.
- OpenAI-compatible routes are always mounted under `/v1/*` (`/v1/chat/completions`, `/v1/models`) with separate OpenAI auth middleware.

5. Plugin mounting:
- Built-in route plugins can mount `/api/mcp`, `/api/skills`, `/api/workflows` based on config.
- Compile route plugin is always mounted under `/api/workflows`.
- Host-supplied `routePlugins` are mounted after built-ins.

6. Metrics endpoint:
- `/metrics` is mounted only when metrics collector is `PrometheusMetricsCollector`.

Run lifecycle path (configured queue mode):
- `POST /api/runs` validates input, applies metadata and tenant/owner scoping, optional quota check, creates run, enqueues job.
- `startRunWorker` consumes jobs, resolves executable agent, performs input guard checks/redaction, runs executor, updates run state/logs/trace, emits lifecycle events, and records optional reflection/feedback/quota usage.

## Key APIs and Types
App factory and configuration:
- `createForgeApp(config: ForgeServerConfig): Hono`.
- `ForgeServerConfig` is composed from `ForgeCoreConfig`, `ForgeTransportConfig`, `ForgeRuntimeConfig`, `ForgeIntegrationsConfig`, and `ForgeSecurityConfig` in `src/composition/types.ts`.

Notable route factories:
- Core: `createRunRoutes`, `createRunContextRoutes`, `createAgentDefinitionRoutes`, `createApprovalRoutes`, `createHealthRoutes`.
- Optional: `createMemoryRoutes`, `createLearningRoutes`, `createEvalRoutes`, `createBenchmarkRoutes`, `createDeployRoutes`, `createA2ARoutes`, `createTriggerRoutes`, `createScheduleRoutes`, `createPromptRoutes`, `createPersonaRoutes`, `createMarketplaceRoutes`, `createReflectionRoutes`, `createMailboxRoutes`, `createClusterRoutes`.
- Compatibility: OpenAI route builders in `routes/openai-compat/*`.

Runtime and queue APIs:
- `startRunWorker`, `RunExecutor`, `RunExecutionContext`.
- `InMemoryRunQueue`, `BullMQRunQueue`, `RunQueue` contract.
- `createDefaultRunExecutor`, `createDzupAgentRunExecutor`.

Realtime APIs:
- `InMemoryEventGateway` and `EventGateway` interface for SSE subscription fan-out.
- `EventBridge` and websocket control helpers under `src/ws/*`.

Operational/API-key APIs:
- API key store and route: `PostgresApiKeyStore`, `createApiKeyRoutes`.
- Ops subpath export (`./ops`): doctor and scorecard interfaces.

## Dependencies
Direct runtime dependencies (from `package.json`):
- DzupAgent packages: `@dzupagent/agent`, `@dzupagent/agent-adapters`, `@dzupagent/app-tools`, `@dzupagent/context`, `@dzupagent/core`, `@dzupagent/eval-contracts`, `@dzupagent/flow-ast`, `@dzupagent/flow-compiler`, `@dzupagent/hitl-kit`, `@dzupagent/memory-ipc`, `@dzupagent/otel`.
- Third-party: `hono`, `drizzle-orm`, `commander`, `@langchain/core`.

Peer dependencies:
- `postgres` (required by Postgres/Drizzle-backed stores and tooling).
- `bullmq` (optional peer; required when using `BullMQRunQueue`).

Build/test toolchain:
- `tsup`, `typescript`, `vitest`, `drizzle-kit`, `testcontainers`.

## Integration Points
Common integration seams exposed by this package:
- Host app composition via `createForgeApp` with injected stores, registry, queue, auth/rate/middleware, and optional feature modules.
- Queue execution swap: in-memory queue for local/dev; BullMQ for Redis-backed workloads.
- Persistence swap: in-memory stores or Drizzle/Postgres implementations.
- Event transport:
  - SSE via `/api/events/stream` and per-run streaming in run routes.
  - Optional websocket bridge/control wiring through exported WS helpers.
- Optional control-plane surfaces:
  - Registry route mounting when `registry` is provided.
  - Built-in plugin-based routes for MCP, skills, workflow/compile.
- Compatibility surface for OpenAI-like clients under `/v1/*`.
- Platform adapters for Lambda/Vercel/Cloudflare host runtimes.
- Operational integration through doctor/scorecard (`@dzupagent/server/ops`).

## Testing and Observability
Testing setup:
- Test runner: Vitest (`vitest.config.ts`), Node environment, 60s timeouts.
- Test selection: `src/**/*.test.ts` and `src/**/*.spec.ts` with targeted excludes.
- Coverage thresholds:
  - statements: 70
  - branches: 60
  - functions: 60
  - lines: 70

Coverage and test footprint in package:
- Broad route/runtime/security coverage under `src/__tests__`, plus module-local tests in `middleware`, `routes`, `persistence`, `services`, `ws`, `composition`, and `a2a`.

Observability mechanisms in code:
- Health endpoints:
  - `/api/health` (liveness)
  - `/api/health/ready` (run store, agent store, model registry, queue/shutdown state)
  - `/api/health/metrics` (JSON metric snapshot)
- Optional Prometheus endpoint: `/metrics` when using `PrometheusMetricsCollector`.
- Run pipeline instrumentation:
  - run logs persisted via `runStore.addLog`
  - lifecycle events emitted on shared event bus
  - optional run trace persistence (`RunTraceStore`)
  - optional routing and HTTP metrics increments.

## Risks and TODOs
Current risks and explicit TODO markers in code:
- `/metrics` exposure risk: `composition/optional-routes.ts` contains a TODO noting `/metrics` is currently mounted on the public app and bypasses auth; production hardening is expected at ingress/internal binding.
- Version drift risk:
  - `package.json` version is `0.2.0`.
  - `src/routes/health.ts` liveness payload still returns `version: '0.1.0'`.
  - `src/index.ts` exports `dzupagent_SERVER_VERSION = '0.1.0'`.
- Export-map mismatch risk: source has `runtime.ts` and `compat.ts` facades, but current `package.json` `exports` exposes only `.` and `./ops`; consumers expecting subpath imports for runtime/compat will not resolve unless export map is extended.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

