# MCP Architecture (`packages/core/src/mcp`)

Last updated: 2026-04-03

## Scope

This document describes the MCP implementation in `@dzupagent/core` under:

- `packages/core/src/mcp/*`
- related exports in `packages/core/src/index.ts`
- direct usage references in other packages (`server`, `agent-adapters`)

It covers:

- features and responsibilities
- runtime flow (discovery, invocation, deferred loading, resources, sampling)
- usage patterns and examples
- cross-package integration points
- current test coverage and gaps

## High-Level Design

The MCP subsystem is split into focused layers:

1. Transport-facing client layer: connect to MCP servers, discover tools, invoke tools.
2. Schema bridge layer: convert MCP tools to LangChain tools and back.
3. Server exposure layer: expose local tools through MCP JSON-RPC (`tools/list`, `tools/call`).
4. Resource + Sampling protocol helpers: MCP resources and MCP sampling.
5. Reliability + Security primitives: heartbeat/circuit-breaker/cache and stdio hardening.
6. Deferred loading helper: keep prompt/context budget bounded for large tool catalogs.

Design intent is resilience-first:

- connection and invocation errors are mostly non-fatal and returned as results where possible
- optional composition (for example, reliability manager is standalone and not hard-wired into `MCPClient`)
- graceful degradation when MCP servers are unavailable

## Module Map

| File | Responsibility | Key Exports |
| --- | --- | --- |
| `mcp-client.ts` | Connect/discover/invoke across `http`, `sse`, `stdio`; tracks eager vs deferred tools per server | `MCPClient` |
| `deferred-loader.ts` | Budget-based lazy tool loading wrapper for LangChain integration | `DeferredToolLoader`, `DeferredLoaderConfig` |
| `mcp-tool-bridge.ts` | MCP JSON schema <-> Zod conversion and MCP <-> LangChain tool conversion | `mcpToolToLangChain`, `mcpToolsToLangChain`, `langChainToolToMcp` |
| `mcp-server.ts` | Lightweight in-process MCP JSON-RPC server for tools | `DzupAgentMCPServer` and request/response/tool types |
| `mcp-resources.ts` | MCP resources protocol (`list`, `templates/list`, `read`, `subscribe`) | `MCPResourceClient`, `MCPResourceClientConfig` |
| `mcp-resource-types.ts` | Resource DTOs and subscription handler types | `MCPResource*` types |
| `mcp-sampling.ts` | Sampling handler factory + registration helper for `sampling/createMessage` | `createSamplingHandler`, `registerSamplingHandler` |
| `mcp-sampling-types.ts` | Sampling request/response/model-preference types | `MCPSampling*` types |
| `mcp-reliability.ts` | Server health, heartbeats, per-server circuit breakers, discovery cache TTL | `McpReliabilityManager` and reliability types |
| `mcp-security.ts` | Hardening for stdio server launch (path validation + env sanitization) | `validateMcpExecutablePath`, `sanitizeMcpEnv` |
| `mcp-types.ts` | Shared MCP client/tool/status type model | `MCPServerConfig`, `MCPToolDescriptor`, etc. |
| `index.ts` | MCP-folder level barrel | most MCP exports (but not reliability/security) |

Note on exports:

- Full public API is re-exported from `packages/core/src/index.ts`, including reliability/security/resources/sampling.
- `packages/core/src/mcp/index.ts` exports core/client/server/resources/sampling pieces but does not export reliability/security.

## Core Features

### 1) Multi-Transport MCP Client

`MCPClient` manages a set of server connections and supports:

- add/connect/disconnect lifecycle
- parallel `connectAll()`
- tool discovery over:
  - `http`: POST JSON-RPC to `.../tools/list`
  - `sse`: currently implemented via same POST path as HTTP
  - `stdio`: child process spawn + JSON line parsing
- non-fatal tool invocation (`invokeTool`) returning `MCPToolResult` with `isError` instead of hard failure
- status introspection (`getStatus`, `hasConnections`)

### 2) Deferred Loading

Two cooperating controls exist:

- per-server eager cap in `MCPServerConfig.maxEagerTools` (applied in `MCPClient.connect`)
- budget helper in `DeferredToolLoader`:
  - computes `maxEagerTools` from context budget
  - returns eager LangChain tools
  - provides deferred tool summary text
  - lazily promotes named deferred tools on demand

### 3) MCP <-> LangChain Bridge

`mcp-tool-bridge.ts` handles:

- JSON-schema-like MCP parameter mapping to Zod
- generation of LangChain `tool(...)` wrappers that call `client.invokeTool`
- mapping MCP multi-content output into textual tool return content
- reverse conversion from LangChain tool Zod schema back to MCP descriptor (for exposing tools)

### 4) Embedded MCP Server

`DzupAgentMCPServer` provides a small JSON-RPC surface:

- `tools/list`
- `tools/call`

Behavior:

- dynamic runtime registration (`registerTool`, `unregisterTool`)
- JSON-RPC-compatible result/error envelopes
- internal error codes:
  - method not found: `-32601`
  - invalid params: `-32602`
  - internal error: `-32000`

### 5) Resource Protocol Client

`MCPResourceClient` implements:

- `resources/list`
- `resources/templates/list`
- `resources/read`
- `resources/subscribe` + best-effort `resources/unsubscribe`
- update notifications via `notifications/resources/updated`

It tracks active subscriptions and supports `dispose()` for cleanup.

### 6) Sampling Protocol Helpers

Sampling features:

- `createSamplingHandler(llmInvoke, config)`:
  - clamps `maxTokens` to configured `maxAllowedTokens`
  - optional budget ceiling enforcement
  - model selection from `modelPreferences.hints` fallback to `defaultModel`
  - MCP message conversion to invoke format
  - stop reason normalization
- `registerSamplingHandler(onRequest, handler)`:
  - binds handler to `sampling/createMessage`
  - supports unregister guard

### 7) Reliability Composition Layer

`McpReliabilityManager` is independent from `MCPClient` and adds:

- health snapshots per server
- failure/success tracking
- per-server circuit breaker wrapping
- heartbeat polling loop support
- tool discovery cache with TTL and invalidation

This keeps reliability optional and composable without forcing a specific runtime policy.

### 8) Security Hardening for `stdio`

`mcp-security.ts` protects process execution path:

- blocks empty paths, shell metacharacters, and path traversal patterns
- sanitizes server-provided env overrides to block dangerous vars (`LD_PRELOAD`, `NODE_OPTIONS`, `PATH`, etc.)

These checks are applied in `MCPClient.spawnWithStdin(...)` before spawning child processes.

## End-to-End Flows

### A) Discovery and Invocation Flow

```text
addServer -> connect/connectAll
  -> discoverTools (http|sse|stdio)
  -> split tools into eager/deferred
  -> mcpToolToLangChain for eager tools
  -> agent invokes tool
  -> invokeTool -> executeToolCall (transport-specific)
  -> MCPToolResult mapped to tool output
```

### B) Deferred Tool Promotion Flow

```text
connect() discovers N tools
if N > maxEagerTools:
  eager = first maxEagerTools
  deferred = remainder

agent requests deferred tool by name
  -> DeferredToolLoader.loadTool(name)
  -> MCPClient.loadDeferredTool(name)
  -> descriptor promoted deferred -> eager
  -> converted to LangChain tool and cached
```

### C) Resource Subscription Flow

```text
subscribeToResource(uri, handler)
  -> send resources/subscribe
  -> register notifications/resources/updated callback
notification(uri)
  -> readResource(uri)
  -> invoke registered handler(uri, content)
unsubscribe/dispose
  -> send resources/unsubscribe (best-effort)
```

### D) Sampling Flow

```text
registerSamplingHandler(onRequest, handler)
  -> onRequest("sampling/createMessage", wrappedHandler)
server sends sampling/createMessage
  -> createSamplingHandler wrapper validates/clamps/selects model
  -> llmInvoke(messages, options)
  -> MCP sampling response returned
```

## Usage Examples

### 1) Connect to external MCP servers and use tools in LangChain

```ts
import { MCPClient, mcpToolsToLangChain } from '@dzupagent/core'

const client = new MCPClient()
client.addServer({
  id: 'local-tools',
  name: 'Local Tools',
  url: 'http://localhost:8787',
  transport: 'http',
  timeoutMs: 10_000,
  maxEagerTools: 20,
})

await client.connectAll()

const tools = mcpToolsToLangChain(client)
// pass tools to your LangGraph/LangChain agent
```

### 2) Use deferred loading to protect context budget

```ts
import { MCPClient, DeferredToolLoader } from '@dzupagent/core'

const client = new MCPClient()
// ... add/connect servers ...

const loader = new DeferredToolLoader(client, {
  contextWindowTokens: 128_000,
  maxToolBudgetRatio: 0.1,
  tokensPerTool: 150,
})

const eagerTools = loader.getEagerTools()
const deferredSummary = loader.getDeferredToolSummary()

// Later, if the model requests a deferred tool:
const maybeTool = loader.loadTool('large_catalog_search')
```

### 3) Expose local handlers as an MCP server

```ts
import { DzupAgentMCPServer } from '@dzupagent/core'

const server = new DzupAgentMCPServer({
  name: 'dzupagent-tools',
  version: '1.0.0',
})

server.registerTool({
  name: 'echo',
  description: 'Echo back input',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  handler: async (args) => String(args['text'] ?? ''),
})

const response = await server.handleRequest({
  jsonrpc: '2.0',
  id: '1',
  method: 'tools/call',
  params: { name: 'echo', arguments: { text: 'hello' } },
})
```

### 4) Consume resources from MCP resource endpoints

```ts
import { MCPResourceClient } from '@dzupagent/core'

const resources = new MCPResourceClient({
  sendRequest: (method, params) => transport.send(method, params),
  onNotification: (method, handler) => transport.on(method, handler),
})

const list = await resources.listResources()
if (list[0]) {
  const content = await resources.readResource(list[0].uri)
}

const sub = resources.subscribeToResource('file:///tmp/config.json', (uri, updated) => {
  console.log(uri, updated)
})
// sub.unsubscribe()
```

### 5) Handle MCP sampling requests through your LLM function

```ts
import { createSamplingHandler, registerSamplingHandler } from '@dzupagent/core'

const samplingHandler = createSamplingHandler(
  async (messages, options) => {
    const text = await myModel.generate(messages, options)
    return { content: text, model: options?.model ?? 'default-model', stopReason: 'endTurn' }
  },
  { defaultModel: 'gpt-4.1-mini', maxAllowedTokens: 4096 },
)

const registration = registerSamplingHandler(transport.onRequest, samplingHandler)
// registration.unregister()
```

### 6) Add reliability management

```ts
import { McpReliabilityManager } from '@dzupagent/core'

const reliability = new McpReliabilityManager({
  heartbeatIntervalMs: 30_000,
  maxHeartbeatFailures: 3,
  discoveryCacheTtlMs: 300_000,
})

reliability.registerServer('local-tools')
reliability.startHeartbeat('local-tools', async () => {
  // implement lightweight ping against your MCP server
  return true
})
```

## Referenced in Other Packages

### `packages/server`: runtime MCP tool resolution

Primary integration: `packages/server/src/runtime/tool-resolver.ts`

- dynamically imports `MCPClient` and `mcpToolToLangChain` from `@dzupagent/core`
- parses MCP selector tokens from `toolNames`:
  - `mcp:*` -> all configured MCP servers
  - `mcp:<server>` -> single server
  - `mcp:<server>:<tool>` -> single tool on server
- reads `metadata.mcpServers`, validates policy, connects servers, resolves eager tools, returns cleanup callback (`disconnectAll`)

Related integration test:

- `packages/server/src/__tests__/mcp-integration.test.ts` (30 tests)

### `packages/agent-adapters`: tool-sharing bridge

Primary integration: `packages/agent-adapters/src/mcp/mcp-tool-sharing.ts`

- uses `DzupAgentMCPServer` from core as internal MCP transport surface
- adapter bridge registers shared tools on server and delegates JSON-RPC `tools/list`/`tools/call`
- builds provider-specific config forms (Claude in-process MCP, Codex dynamic tools, CLI prompt injection)

Related integration test:

- `packages/agent-adapters/src/__tests__/mcp-tool-sharing.test.ts` (19 tests)

## Test Coverage (Current)

### Executed during this analysis

Commands run:

- `yarn workspace @dzupagent/core test src/mcp/__tests__/mcp-resources.test.ts src/mcp/__tests__/mcp-sampling.test.ts src/__tests__/mcp-security.test.ts src/__tests__/mcp-reliability.test.ts`
- `yarn workspace @dzupagent/server test src/__tests__/mcp-integration.test.ts`
- `yarn workspace @dzupagent/agent-adapters test src/__tests__/mcp-tool-sharing.test.ts`

Observed results:

- Core MCP-focused tests: 68 passed
- Server MCP integration tests: 30 passed
- Agent-adapters MCP bridge tests: 19 passed

### Feature-to-test mapping

| Feature area | Direct tests | Coverage notes |
| --- | --- | --- |
| Resource list/read/templates/subscribe lifecycle | `packages/core/src/mcp/__tests__/mcp-resources.test.ts` | Strong direct unit coverage for happy path + fallback + notification-triggered updates + unsubscribe/dispose |
| Sampling handler + registration | `packages/core/src/mcp/__tests__/mcp-sampling.test.ts` | Direct coverage for model selection, token clamp, budget rejection, image placeholder mapping, stop-reason mapping, unregister behavior |
| Stdio security hardening | `packages/core/src/__tests__/mcp-security.test.ts` | Direct coverage for path validation and blocked env var sanitization |
| Reliability manager behavior | `packages/core/src/__tests__/mcp-reliability.test.ts` | Extensive direct coverage: heartbeat, circuit transitions, cache TTL, cleanup, idempotency |
| Server-side MCP tool exposure (`DzupAgentMCPServer`) | `packages/agent-adapters/src/__tests__/mcp-tool-sharing.test.ts` | Indirect/integration coverage through bridge delegation (`tools/list`, `tools/call`) |
| Resolver-driven consumption in server package | `packages/server/src/__tests__/mcp-integration.test.ts` | Integration coverage for selector parsing, discovery filtering, deferred eager cap behavior, tool invocation path, cleanup callbacks |

## Gaps and Risks

Current tests are strong for resources/sampling/reliability/security, but there are notable unit gaps in `packages/core/src/mcp`:

- no direct unit tests for `mcp-client.ts` transport implementations (`http`, `sse`, `stdio`) and error/timeout behavior at client level
- no direct unit tests for `mcp-tool-bridge.ts` schema conversion edge cases
- no direct unit tests for `deferred-loader.ts` cache/promotion/summary behavior
- no direct unit tests for `mcp-server.ts` JSON-RPC error envelopes and registry lifecycle in isolation

Recommended next additions:

1. Add `mcp-client.test.ts` with mocked `fetch` and mocked child process spawn for stdio.
2. Add `mcp-tool-bridge.test.ts` for JSON-schema-to-Zod and Zod-to-MCP roundtrip cases.
3. Add `deferred-loader.test.ts` for budget math, cache hits, deferred promotion.
4. Add `mcp-server.test.ts` for request validation, missing tools, handler throw paths.

## Practical Notes for Contributors

- Prefer importing from `@dzupagent/core` root export rather than internal file paths.
- For production use, pair `MCPClient` with:
  - explicit `maxEagerTools`
  - metadata policy controls in server runtime
  - `McpReliabilityManager` for heartbeat/circuit/cache orchestration
- For `stdio` servers, avoid shell-like command strings in `url`; pass executable path and use `args`.
- Treat resource subscribe/unsubscribe as best-effort and design handlers to tolerate missed updates.
