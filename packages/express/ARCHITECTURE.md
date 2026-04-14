# @dzupagent/express Architecture

Last analyzed: April 4, 2026

## Purpose and Scope

`@dzupagent/express` exposes `DzupAgent` instances over HTTP using Express, with:

- Streaming chat over Server-Sent Events (SSE).
- Synchronous JSON chat responses.
- Health inspection for configured agents.
- Lifecycle hooks for auth, observability, and error handling.

This package is intentionally thin. It adapts `@dzupagent/agent` to Express request/response primitives without introducing application-specific logic.

## Module Map

- `src/index.ts`
  - Public entrypoint. Re-exports router factory, SSE classes, and types.
- `src/agent-router.ts`
  - Router factory and route handlers (`/chat`, `/chat/sync`, `/health`).
- `src/sse-handler.ts`
  - SSE protocol adapter (`SSEHandler`) and low-level writer (`SSEWriter`).
- `src/types.ts`
  - Public TypeScript contracts (`AgentRouterConfig`, `SSEHandlerConfig`, request/response payload types).
- `src/__tests__/*.test.ts`
  - Unit and integration coverage for route registration, SSE behavior, and mounted-app flows.

## Public API Surface

Exported from `src/index.ts`:

- `createAgentRouter(config: AgentRouterConfig): Router`
- `SSEHandler`
- `SSEWriter`
- `SSEEvent`, `SSEHandlerConfig`, `AgentResult`, `ChatRequestBody`, `AgentRouterConfig`

Reference: `src/index.ts:1-9`.

## Runtime Architecture

### Core Components

1. `createAgentRouter` (`src/agent-router.ts`)
   - Builds an Express `Router`.
   - Optionally applies `config.auth` middleware at router scope.
   - Resolves target agent by `agentName`, with fallback to first configured agent.

2. `SSEHandler` (`src/sse-handler.ts`)
   - Initializes SSE headers and stream writer.
   - Bridges async `AgentStreamEvent` stream into SSE events.
   - Tracks aggregate stream result (`content`, `toolCalls`, `durationMs`).

3. `SSEWriter` (`src/sse-handler.ts`)
   - Formats and writes SSE frames.
   - Sends keepalive comments at configurable intervals.
   - Owns stream shutdown (`end()`) and connection liveness checks.

### Endpoint Contracts

`createAgentRouter` registers:

- `POST {basePath}/chat`
  - Streaming SSE endpoint.
  - Requires `body.message` string.
  - Uses `agent.stream()` with `AbortController` tied to client disconnect.
- `POST {basePath}/chat/sync`
  - Non-streaming JSON endpoint.
  - Requires `body.message` string.
  - Uses `agent.generate()`.
- `GET {basePath}/health`
  - Returns `status`, `agents`, and `count`.

Reference: `src/agent-router.ts:41-171`.

## Request Flows

### 1) Streaming Flow (`POST /chat`)

1. Validate `body.message` (`400` on failure).
2. Resolve agent (`503` if no configured agent).
3. Run `hooks.beforeAgent`.
4. Create `HumanMessage` from request text.
5. Start agent stream (`agent.stream(messages, { signal })`).
6. `SSEHandler.streamAgent` maps each agent event to SSE output.
7. On completion, emit `done` SSE event with aggregate result and close stream.
8. Run `hooks.afterAgent` with `AgentResult`.
9. On error:
   - Call `hooks.onError`.
   - If SSE started, write fallback `data: {"error": ...}` and end.
   - Else respond with `500` JSON.

Reference: `src/agent-router.ts:52-103`, `src/sse-handler.ts:149-283`.

### 2) Synchronous Flow (`POST /chat/sync`)

1. Validate `message`.
2. Resolve agent.
3. Run `hooks.beforeAgent`.
4. Call `agent.generate(messages)`.
5. Map `GenerateResult` to API JSON (`content`, token usage totals, tool call count, duration).
6. Run `hooks.afterAgent` with raw `GenerateResult`.
7. Return JSON payload.
8. On error, call `hooks.onError` and return `500` JSON.

Reference: `src/agent-router.ts:106-159`.

### 3) Health Flow (`GET /health`)

1. Enumerate configured agent keys.
2. Return:
   - `status: "ok"`
   - `agents: string[]`
   - `count: number`

Reference: `src/agent-router.ts:162-168`.

## SSE Protocol and Event Mapping

### Headers and Transport Behavior

`SSEHandler.initStream()` sets:

- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`
- `X-Accel-Buffering: no`

Then `SSEWriter.startKeepAlive()` emits `: keepalive\n\n` (default every `15000ms`).

Reference: `src/sse-handler.ts:123-137`, `src/sse-handler.ts:43-50`.

### Agent Event -> SSE Event

`SSEHandler.streamAgent()` maps `AgentStreamEvent` values as follows:

- `text` -> `event: chunk`, `data: { content }`
- `tool_call` -> `event: tool_call`, `data: { name, args }`
- `tool_result` -> `event: tool_result`, `data: { name, result }`
- `error` -> `event: error`, `data: { message }`
- `budget_warning` -> `event: budget_warning`, `data: { message }`
- `stuck` -> `event: stuck`, `data: passthrough`
- `done` -> does not directly forward `done` payload fields; final aggregate is emitted later via `writer.writeDone(result)`

Reference: `src/sse-handler.ts:178-237`, `src/sse-handler.ts:269-272`.

## Feature Catalog

### Multi-agent routing with deterministic fallback

- Supports multiple named agents.
- If requested `agentName` is missing, falls back to first configured agent key.
- Enables single endpoint for many specialized agents.

Reference: `src/agent-router.ts:13-29`.

### Lifecycle hooks for app integration

- `beforeAgent(req, agentName)`
- `afterAgent(req, agentName, result)`
- `onError(req, error)`

Typical uses: structured logging, tracing, rate-limit accounting, persistence.

Reference: `src/types.ts:77-84`, `src/agent-router.ts:70`, `src/agent-router.ts:87`, `src/agent-router.ts:90`, `src/agent-router.ts:123`, `src/agent-router.ts:142`, `src/agent-router.ts:152`.

### Router-level auth attachment

- Optional `config.auth` middleware can gate all package routes.
- Works with upstream app middleware composition.

Reference: `src/agent-router.ts:47-49`.

### Streaming resilience primitives

- Keepalive pings to reduce idle proxy disconnects.
- Client disconnect detection via `req.on('close')`.
- Attempts to stop underlying async generator via `agentStream.return(...)`.

Reference: `src/sse-handler.ts:163-176`.

### Low-level SSE primitives for custom routes

- `SSEHandler.initStream()` for setup.
- `SSEWriter` for direct manual writes.
- Custom frame formatting via `formatEvent`.

Reference: `src/sse-handler.ts:36-101`, `src/types.ts:36-47`.

## Usage Examples

### Minimal mounting

```ts
import express from 'express'
import { createAgentRouter } from '@dzupagent/express'
import { DzupAgent } from '@dzupagent/agent'

const app = express()
app.use(express.json())

const agent = new DzupAgent({ id: 'support', model: 'gpt-4.1-mini' })

app.use('/api/agent', createAgentRouter({
  agents: { support: agent },
}))
```

### With auth + hooks + tuned SSE keepalive

```ts
app.use('/api/agent', createAgentRouter({
  basePath: '/v1',
  agents: { support: agentA, research: agentB },
  auth: (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${process.env.API_TOKEN}`) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  },
  sse: {
    keepAliveMs: 10_000,
    onDisconnect: (req) => logger.info({ path: req.path }, 'client disconnected'),
  },
  hooks: {
    beforeAgent: (req, agentName) => logger.info({ agentName, path: req.path }, 'agent start'),
    afterAgent: (req, agentName, result) => saveRun(req, agentName, result),
    onError: (req, error) => logger.error({ err: error, path: req.path }, 'agent route error'),
  },
}))
```

### Manual SSE endpoint using `SSEHandler`

```ts
import { SSEHandler } from '@dzupagent/express'

const sse = new SSEHandler({ keepAliveMs: 20_000 })

app.get('/events', (req, res) => {
  const writer = sse.initStream(res)
  writer.write({ type: 'status', data: { ok: true } })
  writer.writeChunk('hello')
  writer.writeDone({ content: 'hello', toolCalls: 0, durationMs: 5 })
  writer.end()
})
```

## Cross-Package References and Usage in This Monorepo

### Runtime dependencies

- Depends on `@dzupagent/agent` for `DzupAgent`, `GenerateResult`, and `AgentStreamEvent`.
- Depends on Express as peer dependency (`>=4.18.0`).
- Package metadata: `package.json:20-26`.

### In-repo adoption status (as of April 4, 2026)

- No non-doc runtime package in `packages/*` imports `@dzupagent/express` directly.
- Primary references are documentation and migration guidance:
  - `docs/packages/express.md`
  - `docs/guides/migration-from-custom.md`
  - `docs/README.md` package index
- `packages/core/src/hooks/ARCHITECTURE.md` explicitly notes that express router hooks are separate from core `AgentHooks`.

Reference scan command used:

```bash
rg -n "@dzupagent/express|createAgentRouter\\(" packages docs --glob '!**/dist/**'
```

## Test Coverage

Verification commands run on April 4, 2026:

```bash
yarn workspace @dzupagent/express test
yarn workspace @dzupagent/express test -- --coverage
```

Result summary:

- Test files: `3` passed
- Tests: `6` passed
- Duration: ~1.3s

Coverage (Vitest v8):

- All files: `77.20%` statements, `56.00%` branches, `84.21%` functions, `77.20%` lines
- `agent-router.ts`: `73.84%` statements, `46.67%` branches, `100%` functions
- `sse-handler.ts`: `81.69%` statements, `61.76%` branches, `87.50%` functions
- `index.ts`: `0%` (re-export barrel is not directly tested)

### What tests currently cover

- Route registration and `basePath` behavior.
  - `src/__tests__/agent-router.test.ts`
- SSE header initialization and basic stream mapping (`chunk`, `tool_call`, `done`).
  - `src/__tests__/sse-handler.test.ts`
- Mounted Express integration behavior:
  - Auth gating.
  - `/health` JSON payload.
  - `/chat/sync` response mapping.
  - `/chat` streaming headers and event presence.
  - Hook invocation expectations.
  - `src/__tests__/express.integration.test.ts`

### Notably under-tested paths

- Streaming route validation errors (`400`, `503`) and streaming exception fallback path (`res.headersSent` branch).
  - `src/agent-router.ts:55-64`, `src/agent-router.ts:93-101`
- Sync route negative paths (`400`, `503`, `500`).
  - `src/agent-router.ts:109-118`, `src/agent-router.ts:151-157`
- SSE disconnect and error hook branches.
  - `src/sse-handler.ts:163-176`, `src/sse-handler.ts:239-258`
- `budget_warning` and `stuck` event forwarding branches.
  - `src/sse-handler.ts:223-236`

## Design Notes and Current Gaps

1. `ChatRequestBody` includes `conversationId`, `model`, and `configurable`, but router handlers currently only use `message` and `agentName`.
   - `src/types.ts:58-63` vs `src/agent-router.ts:72-82`, `src/agent-router.ts:125-128`.

2. Streaming aggregate fields `usage` and `cost` are present in `AgentResult` but are not currently populated in `SSEHandler.streamAgent`.
   - `src/sse-handler.ts:159-160`, `src/sse-handler.ts:248-254`, `src/sse-handler.ts:261-267`.

3. `done` event details from agent stream (`stopReason`, `hitIterationLimit`) are consumed for content fallback only, not exposed in final SSE `done` payload.
   - `src/sse-handler.ts:206-217`, `src/sse-handler.ts:271`.

4. Streaming error fallback in router writes raw `data:` frame without `event: error`, which differs from normal `SSEWriter` output format.
   - `src/agent-router.ts:93-95`.

5. Client disconnect is observed in both router and SSE handler (`req.on('close')` in both places). Behavior is correct but duplicated.
   - `src/agent-router.ts:76-78`, `src/sse-handler.ts:164-168`.

These are not necessarily defects for all deployments, but they are important for consumers expecting strict protocol and telemetry parity with `@dzupagent/agent`.
