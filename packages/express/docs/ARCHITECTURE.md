# @dzupagent/express Architecture

## Scope
`@dzupagent/express` is the HTTP transport package that adapts DzupAgent runtime primitives to Express routers. The package is intentionally narrow: it does not implement agent orchestration logic, model/tool execution, or MCP protocol internals itself. Instead, it exposes router factories and helper utilities so host applications can mount:

- Agent chat endpoints (`/chat`, `/chat/sync`, `/health`) around `DzupAgent` instances.
- MCP JSON-RPC and helper listing endpoints (`/mcp`, `/mcp/tools`, `/mcp/resources`, `/mcp/resource-templates`) around an MCP-compatible server.
- Request-scoped MCP authentication/context extraction.
- SSE stream formatting/writing and optional projection views.

Public entrypoint is `src/index.ts`, built to ESM in `dist/`.

## Responsibilities
This package currently owns the following responsibilities:

- Express router composition for chat and MCP routes.
- Input hardening for chat routes: JSON parsing, body-size enforcement, Zod validation, agent allowlisting, and per-IP rate limiting.
- Streaming response bridge from `DzupAgent.stream(...)` events to SSE frames.
- Non-streaming response bridge from `DzupAgent.generate(...)` to JSON payloads.
- Sanitized error envelopes for chat routes (`INTERNAL_ERROR`) and JSON-RPC envelopes for MCP routes.
- Optional route lifecycle hooks (`before*`, `after*`, `onError`) used by host apps for audit/logging/metrics.
- MCP credential extraction and request-context assignment helpers.
- Additive SSE event projection helpers (`coordinator`, `subagent`, `tools`, `raw`) layered on top of the raw stream.

Out of scope in current code:

- Express app creation and global middleware policy (hosts provide their own app and can mount auth before or via router config).
- Persistent storage, tenant data model, run state storage, or telemetry sinks.
- MCP business logic/tool implementations (provided by `@dzupagent/core` server/handlers or caller-provided handlers).

## Structure
Source layout:

- `src/index.ts`: package export surface.
- `src/types.ts`: all exported config and contract types for routers, SSE, and MCP auth context.
- `src/agent-router.ts`: `createAgentRouter(...)` plus request parsing/validation/rate-limit/body-parser/error-handler helpers.
- `src/sse-handler.ts`: `SSEWriter` and `SSEHandler` classes for SSE framing, keepalive, disconnect handling, and stream consumption.
- `src/sse-projections.ts`: optional projection router (`SSEProjectionRouter`) and namespace/type definitions.
- `src/mcp-context.ts`: credential extraction and request context helpers/middleware factory.
- `src/mcp-router.ts`: `createMcpRouter(...)` and request-scoped server resolution for MCP JSON-RPC transport.
- `src/__tests__/*.test.ts`: unit/integration coverage for routers, SSE behavior, backpressure edge cases, projections, and MCP context.

Build/test packaging:

- `tsup.config.ts`: ESM build from `src/index.ts`, declaration output enabled.
- `vitest.config.ts`: Node test environment with local aliasing to `../core/src/*` for monorepo-local validation.
- `package.json`: single export (`.`), `express` as peer dependency, runtime deps on `@dzupagent/agent`, `@dzupagent/core`, `express-rate-limit`, and `zod`.

## Runtime and Control Flow
### Agent router flow (`createAgentRouter`)

1. Router initialization creates `SSEHandler`, resolves `basePath`, and chooses a structured logger (`config.logger` or `defaultLogger`).
2. Optional `config.auth` middleware is mounted across package routes.
3. `POST {basePath}/chat` and `POST {basePath}/chat/sync` apply package-owned body parser and rate limiter.
4. Body parser enforces `bodyLimit` (default `256kb`) and normalizes parser failures to JSON errors:
   - `413 BODY_TOO_LARGE`
   - `400 INVALID_JSON`
5. Body is validated by `ChatRequestSchema` (Zod). Required: non-empty `message` max 32,768 chars. Unknown fields are allowed via `.passthrough()` for compatibility.
6. `agentName` is validated against configured `agents` map; unknown names return `400 UNKNOWN_AGENT`. Empty map returns `503 NO_AGENTS`.
7. `hooks.beforeAgent` executes before invoking the chosen agent.
8. `/chat` path:
   - Creates a `HumanMessage` from request message.
   - Starts `agent.stream(...)` with `AbortController`.
   - Aborts on client `close` event.
   - Streams events through `SSEHandler.streamAgent(...)`.
   - Calls `hooks.afterAgent` with `AgentResult`.
9. `/chat/sync` path:
   - Calls `agent.generate(...)`.
   - Maps usage/tool stats into response `{ content, usage, toolCalls, durationMs }`.
   - Calls `hooks.afterAgent` with raw `GenerateResult`.
10. Route-level failures call `hooks.onError`, log server-side detail, and return sanitized `500 { error: 'Internal error', code: 'INTERNAL_ERROR' }`.
11. `GET {basePath}/health` returns `{ status: 'ok', agents, count }`.
12. Router-local terminal error middleware captures uncaught route errors and emits sanitized 500 response.

### SSE streaming flow (`SSEHandler` / `SSEWriter`)

1. `initStream` writes SSE headers (`text/event-stream`, `no-cache`, `keep-alive`, `X-Accel-Buffering: no`) plus custom headers.
2. `SSEWriter` starts keepalive comments (`: keepalive\n\n`) at `keepAliveMs` (default 15s).
3. `streamAgent` consumes `AsyncGenerator<AgentStreamEvent>` and maps known event types:
   - `text` -> `chunk`
   - `tool_call` -> `tool_call`
   - `tool_result` -> `tool_result`
   - `done` -> used for fallback content capture when no text chunks accumulated
   - `error` -> `error`
   - `budget_warning` -> `budget_warning`
   - `stuck` -> `stuck`
4. Aggregates stream result stats (`content`, `toolCalls`, `durationMs`, placeholder `usage`/`cost`).
5. On disconnect, invokes optional `onDisconnect`, attempts `agentStream.return(...)`, and suppresses `onComplete`.
6. On stream exception, writes error event when possible, invokes optional `onError`, and returns partial `AgentResult`.
7. On normal completion, emits `done` event, closes stream, and invokes optional `onComplete`.

### MCP router flow (`createMcpRouter`)

1. Router defaults `basePath` to `/mcp`; optional exposure toggles default to enabled for tools/resources/resource-templates routes.
2. Optional `config.auth` is applied for all MCP routes.
3. `POST {basePath}` validates payload via `isMCPRequest` from `@dzupagent/core/pipeline`.
4. Invalid payload returns JSON-RPC invalid request envelope (`400`, code `-32600`).
5. Server is resolved from either fixed instance or request-scoped resolver function.
6. Hooks execute around `handleRequest`: `beforeRequest`, `afterRequest`, `onError`.
7. Notification-style null responses return HTTP `204`.
8. Errors return JSON-RPC internal error envelope (`500`, code `-32603`) with extracted request id when available.
9. Optional helper endpoints return lists from server methods:
   - `GET {basePath}/tools`
   - `GET {basePath}/resources`
   - `GET {basePath}/resource-templates`

### MCP request context auth flow (`createMcpRequestContextAuth`)

1. Credential is extracted from bearer token (`Authorization: Bearer ...`) and/or direct header (default `x-mcp-api-key`).
2. `resolveContext(credential, req)` returns context or null.
3. Successful auth stores context on request via symbol key and optional custom `assign` callback.
4. Failure path uses caller `onAuthFailure` if supplied; otherwise returns default `401` payload with timestamp and reason-specific message.

## Key APIs and Types
Primary exported APIs:

- `createAgentRouter(config: AgentRouterConfig): Router`
- `createMcpRouter(config: MCPRouterConfig): Router`
- `createMcpRequestContextAuth<TContext>(config: MCPRequestContextAuthConfig<TContext>)`
- `extractMcpCredential(req, options)`
- `setMcpRequestContext(req, context)`
- `getMcpRequestContext<TContext>(req)`
- `requireMcpRequestContext<TContext>(req, message?)`
- `SSEHandler` and `SSEWriter`
- `SSEProjectionRouter` and `withProjection(...)`

Key contracts from `src/types.ts`:

- `AgentRouterConfig`: agent map, optional auth/hook/SSE/rate-limit/body-limit/logger configuration.
- `ChatRequestBody`: message + optional routing and metadata fields.
- `AgentResult`: normalized stream result summary used by SSE completion and hook payload.
- `MCPRouterConfig`: server resolver, route exposure toggles, and lifecycle hooks.
- `MCPRequestHandler`: minimal MCP server transport contract expected by router.
- `MCPRequestContextAuthConfig<TContext>`: credential extraction policy plus context resolver/assign/failure handling.
- `SSENamespace`, `ProjectionContext`, `SubagentLifecycleEvent`, `AgentMessageEvent`, `ToolInvocationEvent`, `ToolResultEvent`.

Notable behavioral details:

- Chat body validation is strict for required field semantics but permissive for additional fields (`.passthrough()`).
- Unknown chat `agentName` fails fast with `400` rather than falling back.
- SSE projection router is additive: raw events are always forwarded, projected events are emitted in parallel when namespace is not `raw`.

## Dependencies
Runtime dependencies declared in `package.json`:

- `@dzupagent/agent`: source of `DzupAgent`, `GenerateResult`, and stream/generate behaviors.
- `@dzupagent/core`: logging utilities and MCP request/response types and validators.
- `express-rate-limit`: chat route rate limiting and IPv6-safe key generation.
- `zod`: request schema validation for chat endpoints.

Peer dependency:

- `express` (`>=4.22.1 <5`), mounted by consumer app.

Development/test dependencies:

- `@types/express`, `express`, `typescript`, `tsup`, `vitest`.

Monorepo-local integration detail:

- Vitest aliases `@dzupagent/core` imports to local `../core/src/*` so package tests validate against current source, not only published build artifacts.

## Integration Points
Agent HTTP integration:

- Host app mounts `createAgentRouter(...)` and supplies concrete `DzupAgent` instances keyed by logical names.
- Host can place authentication middleware globally or pass `auth` inside router config.
- Host can inject metrics/audit logic via lifecycle hooks without forking transport code.

MCP HTTP integration:

- Host app mounts `createMcpRouter(...)` around `DzupAgentMCPServer` or custom request-scoped server resolver.
- Request-scoped resolver enables tenant-specific tool/resource catalogs per request.
- Optional MCP auth context middleware can run before MCP routes to attach validated context to request.

SSE client integration:

- Existing clients can consume raw event stream.
- Advanced clients can opt into projection events for coordinator/subagent/tools views while retaining backward compatibility.

## Testing and Observability
Test coverage in `src/__tests__` verifies:

- Route registration and `basePath` behavior.
- Validation failures (`VALIDATION_ERROR`, `UNKNOWN_AGENT`, `NO_AGENTS`).
- Body-parser guardrails (`BODY_TOO_LARGE`, `INVALID_JSON`).
- Rate limiting (`RATE_LIMITED`).
- Error sanitization (client sees generic internal error while logger captures detailed server-side error).
- Health route payload correctness.
- Express integration scenarios with auth middleware and hooks.
- SSE protocol behavior including headers, chunk/tool/done/error events, disconnect handling, empty streams, event-id formatting, custom formatter/headers, and keepalive timing.
- SSE writer edge cases including backpressure signal handling and idempotent close behavior.
- SSE projection routing semantics across namespaces.
- MCP route behavior for valid/invalid requests, notifications (`204`), helper listing routes, hook execution, error envelopes, and request-scoped server resolution.
- MCP context auth helpers for bearer/header credential paths, default/custom failure handling, and request-context retrieval.

Built-in observability seams:

- Structured logger injection in `createAgentRouter` (`FrameworkLogger`).
- Hook callbacks for pre/post execution and error events in both chat and MCP routers.
- SSE handler callbacks (`onDisconnect`, `onComplete`, `onError`) for stream lifecycle instrumentation.

## Risks and TODOs
- `SSEHandler.streamAgent` currently returns `usage` and `cost` as unset placeholders. If upstream stream events start carrying usage/cost data, this adapter should map and expose them consistently.
- `SSEWriter.startKeepAlive()` does not guard against repeated starts; tests note possible duplicate intervals when called twice directly. Current call sites do not double-start, but the class API permits it.
- `createMcpRouter` expects request body parsing to be configured by host app (for example `express.json()`). Unlike chat routes, MCP router does not mount its own parser.
- Error envelope asymmetry is intentional but important: chat routes sanitize internal details, while MCP route 500 currently returns `error.message` from thrown exceptions in JSON-RPC response.
- `agent-router.ts` imports `HumanMessage` from `@langchain/core/messages`; this package is not declared in `packages/express/package.json` and relies on workspace/transitive resolution. Dependency ownership should be reviewed for publish-time robustness.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

