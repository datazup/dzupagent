# @forgeagent/server Architecture

## Purpose
`@forgeagent/server` is the network/runtime host for ForgeAgent. It exposes REST and event-stream interfaces, manages run execution lifecycles, and provides production middleware, queueing, persistence, and deployment adapters.

## Main Responsibilities
- Build a configured Hono app through `createForgeApp`.
- Expose APIs for health, agents, runs, approvals, events, and optional memory/playground routes.
- Manage runtime queue workers and run execution strategies.
- Provide authentication, rate limiting, RBAC, capability guard, and tenant scoping middleware.
- Support WebSocket control/event channels plus SSE event fan-out.
- Provide deployment adapters (Lambda/Vercel/Cloudflare) and operational helpers.

## Module Structure
Top-level modules under `src/`:
- `app.ts`: central app factory and wiring.
- `routes/`: HTTP route groups (`health`, `agents`, `runs`, `approval`, `events`, `memory`, `registry`, `playground`, `a2a`).
- `runtime/`: default and ForgeAgent run executors, worker startup, quota manager.
- `queue/`: in-memory run queue abstraction.
- `middleware/`: auth, rate limiter, identity, capability guard, RBAC, tenant scope.
- `ws/`: node WS adapter, upgrade guards, control protocol, scope registry, session manager.
- `events/`: in-memory event gateway for fan-out.
- `persistence/`: Drizzle schema and Postgres stores/registry.
- `notifications/`, `triggers/`, `security/incident-response`, `deploy/`, `platforms/`, `cli/`, `docs/`.

## How It Works (App Boot)
1. `createForgeApp(config)` builds Hono instance.
2. Event gateway and run executor are resolved (with sensible defaults).
3. Optional run worker starts once per queue instance.
4. Global middleware stack is installed (CORS, optional auth/rate-limit, shutdown guard, metrics).
5. Error handler is registered.
6. Route groups mount under `/api/*`, with conditional memory and playground routes.

## How It Works (Run Processing)
1. Client submits run via `/api/runs`.
2. Queue worker (if configured) pulls jobs and invokes executor.
3. Executor resolves agent/model and executes workflow.
4. Events are published to event bus and bridged to SSE/WS clients.
5. Stores are updated with run state/log artifacts.

## Main Features
- Full HTTP + realtime control plane for ForgeAgent workloads.
- Pluggable execution path (`default` or `forge-agent` executor).
- Secure-by-default middleware composition.
- Optional memory management APIs and static playground hosting.
- Operational support for incident response, health checks, and deployment packaging.
- Built-in docs and plugin/marketplace CLI utilities.

## Integration Boundaries
- Depends on `@forgeagent/agent`, `@forgeagent/core`, and optional `@forgeagent/memory-ipc` memory services.
- Serves `@forgeagent/playground` as static assets when configured.
- Designed to be embedded in worker/serverless adapters.

## Extensibility Points
- Add new route modules and mount in `createForgeApp`.
- Swap run queue and executor implementations.
- Add custom middleware and event gateway implementation.
- Extend WS authorization/filter logic and notification channels.

## Quality and Test Posture
- Large test surface (`20+` tests) around routes, websocket protocol, worker behavior, docs generation, and middleware correctness.
