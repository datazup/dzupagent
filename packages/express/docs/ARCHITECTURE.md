# @dzupagent/express Architecture

## Scope
`@dzupagent/express` is the Express transport layer for DzupAgent runtime surfaces. In the current codebase, this package provides two HTTP integration families:

- Agent chat routing via `createAgentRouter(...)` with SSE streaming (`/chat`), sync JSON (`/chat/sync`), and health (`/health`).
- MCP JSON-RPC routing via `createMcpRouter(...)` with optional helper discovery endpoints (`/mcp/tools`, `/mcp/resources`, `/mcp/resource-templates`) plus request-context auth utilities.

The package does not own agent planning/execution internals, MCP protocol core types, or application-level auth policy. It adapts Express request/response primitives to interfaces from `@dzupagent/agent` and `@dzupagent/core`.

## Responsibilities
- Register Express routes that validate request shape, resolve an agent/server target, and map results to HTTP responses.
- Bridge `AsyncGenerator<AgentStreamEvent>` streams to Server-Sent Events using `SSEHandler` and `SSEWriter`.
- Expose lifecycle hook points around agent and MCP request handling (`before*`, `after*`, `onError`).
- Provide request-context auth helpers for MCP routes (`createMcpRequestContextAuth`, context getters/setters, credential extraction).
- Keep transport concerns minimal and reusable, leaving domain behavior to consuming apps and core runtime packages.

## Structure
Current package layout:

- `src/index.ts`: public barrel exports.
- `src/agent-router.ts`: `createAgentRouter`, async route wrapper, agent resolution.
- `src/sse-handler.ts`: `SSEWriter` low-level stream writer and `SSEHandler` high-level stream bridge.
- `src/mcp-router.ts`: `createMcpRouter` JSON-RPC endpoint + optional listing endpoints.
- `src/mcp-context.ts`: MCP credential extraction, request-context storage, and auth middleware factory.
- `src/types.ts`: exported TypeScript contracts for all router, SSE, and MCP surfaces.
- `src/__tests__/*.test.ts`: route/unit/integration coverage, including SSE edge cases and MCP flows.
- `README.md`: usage overview (currently emphasizes agent routing; MCP additions are newer than README narrative).
- `package.json`, `tsup.config.ts`, `tsconfig.json`: packaging/build/typecheck setup.

## Runtime and Control Flow
### Agent streaming flow (`POST {basePath}/chat`)
1. Route validates `body.message` as non-empty string; invalid input returns `400`.
2. Router resolves target agent by `agentName`; if missing/unknown it falls back to first configured agent; empty agent map returns `503`.
3. Optional `hooks.beforeAgent(req, agentName)` runs.
4. Message is wrapped as `HumanMessage` and passed to `agent.stream(...)` with `AbortController.signal`.
5. `SSEHandler.streamAgent(...)`:
- Initializes SSE response headers (`text/event-stream`, keep-alive headers).
- Iterates agent stream and maps event types (`text`, `tool_call`, `tool_result`, `error`, `budget_warning`, `stuck`, `done`) into SSE frames.
- Tracks aggregate `content` and `toolCalls`, emits final `done` event, closes stream.
6. Optional `hooks.afterAgent(req, agentName, result)` runs with `AgentResult`.
7. Errors trigger `hooks.onError`; router returns JSON `500` if headers not sent, otherwise writes fallback SSE data and closes.

### Agent sync flow (`POST {basePath}/chat/sync`)
1. Same validation and agent-resolution path as streaming route.
2. Optional `beforeAgent` hook runs.
3. Route calls `agent.generate([HumanMessage])`.
4. Response maps to JSON payload: `content`, token usage totals, `toolCalls`, and measured `durationMs`.
5. Optional `afterAgent` hook runs with raw `GenerateResult`.
6. Errors call `onError` and return JSON `500`.

### Agent health flow (`GET {basePath}/health`)
- Returns `{ status: 'ok', agents: string[], count: number }` based on configured agent map.

### MCP flow (`POST {basePath}`; default `/mcp`)
1. `createMcpRouter` validates request body with `isMCPRequest`.
2. Invalid body returns JSON-RPC error envelope (`400`, code `-32600`, id `null`).
3. Router resolves server instance from static `server` or request-scoped resolver function.
4. Optional `hooks.beforeRequest(req, request)` runs.
5. Calls `server.handleRequest(request)`.
6. Optional `hooks.afterRequest(req, request, response)` runs.
7. If response is `null` (notification), returns `204`; otherwise returns JSON response envelope.
8. Errors call `hooks.onError(req, error, requestId)` and return JSON-RPC internal error (`500`, code `-32603`).

### MCP helper endpoints
Controlled by `config.expose` flags (all default `true`):
- `GET {basePath}/tools` -> `{ tools: server.listTools() }`
- `GET {basePath}/resources` -> `{ resources: server.listResources?.() ?? [] }`
- `GET {basePath}/resource-templates` -> `{ resourceTemplates: server.listResourceTemplates?.() ?? [] }`

### MCP request-context auth flow
`createMcpRequestContextAuth(...)` middleware:
1. Extract credential from bearer token and/or configured header (default `x-mcp-api-key`).
2. On missing credential: `401` unauthorized payload (or custom `onAuthFailure`).
3. Resolve context via `resolveContext(credential, req)`.
4. On invalid credential: same failure path.
5. On success: store context on request symbol, optionally call custom assigner, then `next()`.

## Key APIs and Types
Primary exports from `src/index.ts`:

- Agent transport:
- `createAgentRouter(config: AgentRouterConfig): Router`
- `SSEHandler`
- `SSEWriter`
- MCP transport/context:
- `createMcpRouter(config: MCPRouterConfig): Router`
- `createMcpRequestContextAuth(config)`
- `extractMcpCredential(req, options?)`
- `setMcpRequestContext(req, context)`
- `getMcpRequestContext(req)`
- `requireMcpRequestContext(req, message?)`

Important type contracts from `src/types.ts`:

- `AgentRouterConfig`: `{ agents, auth?, sse?, hooks?, basePath? }`
- `ChatRequestBody`: `{ message, agentName?, conversationId?, model?, configurable? }`
- `AgentResult`: `{ content, usage?, cost?, toolCalls, durationMs }`
- `SSEHandlerConfig`: formatter/headers/keepAlive and lifecycle callbacks (`onDisconnect`, `onComplete`, `onError`)
- `MCPRequestHandler`: minimal handler contract (`handleRequest`, `listTools`, optional resource listing)
- `MCPRouterConfig`: server/auth/basePath/exposure toggles + request hooks
- `MCPRequestContextAuthConfig<TContext>`: context resolution/assignment and auth failure behavior

## Dependencies
Runtime/package dependencies:

- Direct runtime deps:
- `@dzupagent/agent` (agent types and runtime interaction for `/chat` routes)
- `@dzupagent/core` (MCP request typing/validation and server compatibility)
- Peer dependency:
- `express >=4.18.0` (host framework)

Build/tooling:

- `tsup` for ESM build output from `src/index.ts` to `dist/`
- TypeScript `NodeNext`, strict mode, and declaration/source map emission
- Vitest for unit/integration tests

Notable imported transitive surface:

- `@langchain/core/messages` (`HumanMessage`) in `agent-router.ts` to shape agent input.

## Integration Points
- Host Express app composes parser/auth middleware and mounts routers:
- `app.use(express.json())`
- `app.use(createAgentRouter(...))`
- `app.use(createMcpRouter(...))`
- Router-level `auth` in config can gate package-owned routes, but most apps still combine it with broader app middleware.
- Hooks are the primary observability/integration seam:
- Agent hooks: `beforeAgent`, `afterAgent`, `onError`
- MCP hooks: `beforeRequest`, `afterRequest`, `onError`
- Request-scoped MCP server resolution supports tenant-aware behavior (`server: (req) => MCPRequestHandler`).
- Request-context helper functions provide a transport-safe way to attach and read auth-derived context without mutating route signatures.

## Testing and Observability
Current test files in `src/__tests__`:

- `agent-router.test.ts`: route registration, basePath wiring, request validation, error handling, health endpoint, agent fallback behavior.
- `express.integration.test.ts`: mounted Express integration for auth middleware, sync/chat endpoints, hooks, and SSE response envelope behavior.
- `sse-handler.test.ts`: SSE header setup, event mapping, disconnect handling, writer semantics, custom formatter/headers.
- `sse-backpressure.test.ts`: low-level `SSEWriter` behavior under `res.write()` backpressure signals, timer behavior, idempotency, and connection-state edge cases.
- `mcp-context.test.ts`: credential extraction, success path context assignment, default/custom auth-failure behavior.
- `mcp-router.test.ts`: JSON-RPC happy paths, helper endpoints, invalid payload handling, notification `204`, server-thrown errors, and request-scoped server resolution.

Observability surfaces in runtime:

- Agent/MCP hooks for request tracing, metrics, auditing, and error capture.
- `SSEHandlerConfig` callbacks (`onDisconnect`, `onComplete`, `onError`) for stream lifecycle instrumentation.
- No built-in logger dependency; observability is intentionally callback-driven.

## Risks and TODOs
- README drift: `README.md` documents agent routes only and does not describe MCP router/context APIs now exported from `index.ts`.
- `ChatRequestBody` contains `conversationId`, `model`, and `configurable`, but `createAgentRouter` currently ignores these fields when calling `agent.generate`/`agent.stream`.
- `AgentResult` includes `usage` and `cost`, but streaming path currently never populates these values from `AgentStreamEvent` data.
- Streaming error fallback in `createAgentRouter` writes raw `data: { error }` when headers are already sent, which differs from standard `event: error` framing used by `SSEWriter`.
- `SSEWriter.startKeepAlive()` can be called multiple times; tests document behavior but writer does not explicitly guard against timer replacement/leak.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js.

