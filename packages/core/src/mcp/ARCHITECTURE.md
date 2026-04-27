# MCP Architecture (`packages/core/src/mcp`)

## Scope
This document describes the MCP implementation in `@dzupagent/core` under `packages/core/src/mcp` and its public exports via `packages/core/src/index.ts`.

Included in scope:
- MCP client transport and tool invocation (`mcp-client.ts`)
- MCP/LangChain tool schema bridge (`mcp-tool-bridge.ts`)
- Deferred tool loading (`deferred-loader.ts`)
- In-process MCP JSON-RPC server (`mcp-server.ts`)
- MCP resources and sampling helpers (`mcp-resources.ts`, `mcp-sampling.ts`)
- Reliability, security, registry, manager, and pooling primitives (`mcp-reliability.ts`, `mcp-security.ts`, `mcp-registry-types.ts`, `mcp-manager.ts`, `mcp-connection-pool.ts`)
- MCP type surfaces (`mcp-types.ts`, `mcp-resource-types.ts`, `mcp-sampling-types.ts`)

Out of scope:
- HTTP/SSE route wiring in other packages (for example `packages/server`)
- Product-level MCP governance and UI flows in consuming applications

## Responsibilities
The MCP subsystem in `@dzupagent/core` is responsible for:

- Connecting to external MCP servers over `http`, `sse`, and `stdio`.
- Discovering tool descriptors and invoking tools with non-fatal error results.
- Converting MCP tool schemas into LangChain tools and converting LangChain tools back to MCP descriptors.
- Reducing tool-schema context pressure via deferred loading.
- Exposing local tools/resources/sampling through a transport-agnostic JSON-RPC MCP server.
- Providing optional composition primitives for reliability (heartbeat/circuit-breaker/cache), lifecycle management (in-memory registry manager), and connection pooling.
- Hardening stdio execution inputs (executable path validation and env sanitization).

## Structure
`src/mcp` modules are split by concern:

- `mcp-types.ts`: core client/tool/status transport and result types.
- `mcp-client.ts`: multi-transport client (`MCPClient`) with discovery, invoke, status, and deferred/eager split.
- `mcp-tool-bridge.ts`: MCP <-> LangChain conversion (`mcpToolToLangChain`, `mcpToolsToLangChain`, `langChainToolToMcp`).
- `deferred-loader.ts`: context-budget-based deferred tool loader (`DeferredToolLoader`).
- `mcp-server.ts`: transport-agnostic JSON-RPC MCP server (`DzupAgentMCPServer`) for tools/resources/sampling.
- `mcp-resource-types.ts` + `mcp-resources.ts`: resource DTOs and client for `resources/list`, `resources/templates/list`, `resources/read`, subscribe/unsubscribe.
- `mcp-sampling-types.ts` + `mcp-sampling.ts`: sampling DTOs, LLM invoke adapter, and registration helper for `sampling/createMessage`.
- `mcp-security.ts`: stdio executable/env guardrails.
- `mcp-reliability.ts`: reliability manager with heartbeat, circuit-breakers, and discovery cache.
- `mcp-registry-types.ts`: Zod-backed MCP registry/profile schemas.
- `mcp-manager.ts`: `McpManager` interface and `InMemoryMcpManager` implementation with event-bus emission.
- `mcp-connection-pool.ts`: connection reuse/retry/backoff and tool descriptor cache.
- `index.ts`: local MCP barrel (client/bridge/deferred/server/resources/sampling and related types).

Export notes:
- `src/index.ts` exports most MCP surfaces (client/bridge/deferred/server/resources/sampling/reliability/manager/registry/security).
- `src/mcp/index.ts` is narrower and does not export `mcp-reliability`, `mcp-manager`, `mcp-registry-types`, `mcp-security`, or `mcp-connection-pool`.
- `mcp-connection-pool.ts` is present in source and tested, but is not re-exported from `src/index.ts` or `src/mcp/index.ts`.

## Runtime and Control Flow
1. Client discovery and invocation:
- Call `MCPClient.addServer(config)`.
- `connect(serverId)` chooses transport and runs `tools/list` discovery.
- Discovered tools are split into eager vs deferred by `maxEagerTools`.
- Agent/tooling resolves eager tools via `mcpToolsToLangChain(client)`.
- Runtime calls `client.invokeTool(name, args)`, routed to `tools/call` over matching transport.
- Failures are returned as `MCPToolResult { isError: true }` instead of throwing at callsites.

2. Deferred loading path:
- `DeferredToolLoader.maxEagerTools` estimates budget from `contextWindowTokens * maxToolBudgetRatio / tokensPerTool`.
- `getDeferredToolSummary()` exposes names/descriptions for prompt awareness.
- On demand, `loadTool(name)` promotes one deferred descriptor to eager and returns a LangChain tool.

3. Server-side exposure path:
- `DzupAgentMCPServer` registers tools/resources/templates at construction or runtime.
- `handleRequest()` validates JSON-RPC envelope (`isMCPRequest`) and dispatches methods.
- Supported methods: `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `sampling/createMessage`.
- Notifications (no `id`) execute handlers but return `null` response.

4. Resource and sampling helper paths:
- `MCPResourceClient` wraps transport `sendRequest` and optional notifications API.
- `createSamplingHandler(llmInvoke, config)` converts MCP sampling requests to model invocation, clamps token limits, and maps stop reasons back to MCP values.

5. Optional operations layer:
- `InMemoryMcpManager` stores server/profile definitions and emits `mcp:*` events on mutation/test outcomes.
- `McpConnectionPool` wraps `MCPClient` for retry/backoff and descriptor cache TTL.
- `McpReliabilityManager` tracks health/circuit state and heartbeat polling independently from `MCPClient`.

## Key APIs and Types
Primary runtime classes/functions in this directory:
- `MCPClient`
- `DeferredToolLoader`
- `mcpToolToLangChain()`, `mcpToolsToLangChain()`, `langChainToolToMcp()`
- `DzupAgentMCPServer`, `isMCPRequest()`
- `MCPResourceClient`
- `createSamplingHandler()`, `registerSamplingHandler()`
- `McpReliabilityManager`
- `InMemoryMcpManager`
- `McpConnectionPool`, `hashServerConfig()`, `calculateBackoff()`
- `validateMcpExecutablePath()`, `sanitizeMcpEnv()`

Publicly exported from `@dzupagent/core`:
- `MCPClient`, `DeferredToolLoader`, bridge/server/resources/sampling APIs and related types.
- `McpReliabilityManager`, `InMemoryMcpManager`, registry schemas/types, and security helpers.
- `McpConnectionPool` and its helpers are currently internal (not exported from package entrypoints).

Core type contracts:
- Connection/tool core: `MCPServerConfig`, `MCPToolDescriptor`, `MCPToolResult`, `MCPServerStatus`.
- Server protocol: `MCPRequest`, `MCPResponse`, `MCPServerOptions`, `MCPExposedTool`, `MCPExposedResource`, `MCPExposedResourceTemplate`.
- Resources: `MCPResource`, `MCPResourceTemplate`, `MCPResourceContent`, `ResourceSubscription`.
- Sampling: `MCPSamplingRequest`, `MCPSamplingResponse`, `SamplingHandler`, `LLMInvokeFn`.
- Registry/manager: `McpServerDefinition`, `McpProfile`, `McpServerPatch`, `McpTestResult`, `McpManager`.
- Reliability/pooling: `McpServerHealth`, `McpReliabilityConfig`, `McpConnectionPoolConfig`.

## Dependencies
External/runtime dependencies used by this subsystem:
- `@langchain/core/tools`: structured tool wrappers for MCP bridge.
- `zod`: schema conversion and registry schema definitions.
- Node built-ins: `node:child_process` (stdio transport), `node:crypto` (config hashing).

Internal package dependencies used by MCP modules:
- `../llm/circuit-breaker.js` (reliability)
- `../utils/backoff.js` (connection pool retry adapter)
- `../errors/forge-error.js` (security validation errors)
- `../events/event-bus.js` types (manager event emission)

Package-level metadata:
- `@dzupagent/core` publishes MCP APIs from the main entry point (`src/index.ts` -> `dist/index.js`).
- Peer deps (`@langchain/core`, `@langchain/langgraph`, `zod`, and optional LanceDB/Arrow) are declared at package level in `package.json`.

## Integration Points
Inside `@dzupagent/core`:
- `src/index.ts` re-exports MCP APIs and types for consumers.
- `src/flow/handle-types.ts` defines `McpToolHandle` contracts aligned with MCP tool invocation semantics.

Cross-package patterns (consumer-owned wiring):
- Transport layers can delegate JSON-RPC handling to `DzupAgentMCPServer.handleRequest()`.
- Agents/runtimes can bridge discovered tools into LangChain tool loops via `mcpToolsToLangChain(client)`.
- Runtime operators can compose `InMemoryMcpManager` and `McpReliabilityManager` around `MCPClient` from public exports.
- `McpConnectionPool` composition is currently source-internal unless a new public export is added.

## Testing and Observability
Focused MCP tests under `src/mcp/__tests__`:
- `mcp-server.test.ts`: initialize capabilities, tools/resources/sampling methods, notification semantics, request validation.
- `mcp-resources.test.ts`: resource list/template/read/subscribe/unsubscribe/dispose behavior.
- `mcp-sampling.test.ts`: model selection, token clamping/budget checks, stop-reason mapping, registration lifecycle.

Additional MCP coverage under `src/__tests__`:
- `mcp-client-stdio-exit.test.ts`: stdio exit-code gating and partial-stdout failure handling.
- `mcp-connection-pool.test.ts`: hashing, backoff behavior, retries, cache TTL, dispose/release semantics.
- `mcp-manager.test.ts`: manager CRUD/profile lifecycle and emitted `mcp:*` events.
- `mcp-reliability.test.ts`: health/circuit/cache/heartbeat lifecycle.
- `mcp-security.test.ts`: path/env sanitization constraints.
- `plugin-mcp-deep.test.ts`: broader integration-style MCP flows in a larger plugin test suite.

Observability hooks currently present in code:
- `InMemoryMcpManager` emits typed `mcp:*` events onto `DzupEventBus` for add/update/remove/enable/disable/test outcomes.
- `MCPClient.getStatus()` provides per-server connection state, tool counts, and last error text.
- Reliability and pool layers expose explicit health/retry/circuit/cache query methods for diagnostics.

## Risks and TODOs
Current code-level risks and gaps:
- `MCPClient` stdio transport is request-spawn based (`spawnWithStdin` per operation), not a persistent session transport; this can be expensive under high call volume.
- `sse` transport currently routes through the same request path as HTTP (`discoverViaSse -> discoverViaHttp`), so SSE stream semantics are not implemented in this module.
- `MCPClient` is intentionally non-throwing on many failures; callers must consistently inspect `MCPToolResult.isError` and status fields to avoid silent degradation.
- `McpConnectionPool` and `McpReliabilityManager` are standalone helpers and are not wired automatically into `MCPClient`; adopters must compose them explicitly.
- `src/mcp/index.ts` exposes a subset of MCP modules; consumers expecting one-stop MCP exports should prefer `@dzupagent/core` root exports (`src/index.ts`).
- `InMemoryMcpManager` is in-memory only and test-focused; no persistent manager backend is provided in this directory.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

