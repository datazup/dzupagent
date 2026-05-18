# MCP Architecture (`packages/core/src/mcp`)

## Scope
This document describes the MCP subsystem implemented in `packages/core/src/mcp` inside `@dzupagent/core`.

Files covered:
- `mcp-client.ts`, `mcp-types.ts`
- `mcp-tool-bridge.ts`, `deferred-loader.ts`
- `mcp-server.ts`, `mcp-server-core.ts`, `mcp-server-handlers.ts`, `mcp-server-utils.ts`, `mcp-server-types.ts`
- `mcp-resource-types.ts`, `mcp-resources.ts`
- `mcp-prompt-types.ts`
- `mcp-sampling-types.ts`, `mcp-sampling.ts`
- `mcp-security.ts`
- `mcp-registry-types.ts`, `mcp-manager.ts`, `mcp-reliability.ts`, `mcp-connection-pool.ts`
- `index.ts`

Related package surfaces considered:
- `packages/core/src/index.ts` (root exports)
- `packages/core/package.json` (subpath export map includes `./mcp`)
- `packages/core/README.md` (high-level MCP positioning)
- MCP tests under `src/mcp/__tests__` and `src/__tests__/mcp-*.test.ts`

Out of scope:
- Transport servers in other packages/apps (HTTP/SSE endpoints, process managers)
- Product UX and control-plane orchestration outside this directory

## Responsibilities
The MCP module provides these responsibilities:
- Client-side registration, connection, tool discovery, and tool invocation for MCP servers over `http`, `sse`, and `stdio` transports.
- Deferred tool loading support (split eager vs deferred tools and promote on demand).
- Bidirectional adaptation between MCP tool descriptors and LangChain structured tools.
- Transport-agnostic JSON-RPC MCP server runtime (`DzupAgentMCPServer`) for exposing tools/resources/resource templates/prompts/sampling.
- Resource helper client (`MCPResourceClient`) for list/templates/read plus best-effort subscribe/unsubscribe handling.
- Sampling adapter helpers (`createSamplingHandler`, `registerSamplingHandler`) that route sampling requests into an injected LLM invoke function.
- Safety helpers for stdio execution (`validateMcpExecutablePath`, `sanitizeMcpEnv`).
- Optional lifecycle/reliability primitives (`InMemoryMcpManager`, `McpReliabilityManager`, `McpConnectionPool`) plus typed registry schemas (`McpServerDefinitionSchema`, `McpProfileSchema`).

## Structure
Main runtime modules:
- `MCPClient` in `mcp-client.ts`: in-memory connection table keyed by server id, transport-specific discovery/invocation, status reporting.
- `MCPServerConfig`/tool/result/status types in `mcp-types.ts`.
- `DeferredToolLoader` in `deferred-loader.ts`: context-budget-based eager tool cap and cached descriptor-to-tool conversion.
- `mcp-tool-bridge.ts`: `mcpToolToLangChain`, `mcpToolsToLangChain`, `langChainToolToMcp` plus schema translation helpers.

Server-side protocol modules:
- `DzupAgentMCPServer` in `mcp-server-core.ts`: registry holders, capability assembly, method router.
- `mcp-server-handlers.ts`: pure handlers for `tools/call`, `resources/read`, `prompts/get`, `sampling/createMessage`.
- `mcp-server-utils.ts`: request guards, JSON-RPC envelope builders, content normalization, template URI matching.
- `mcp-server-types.ts`: request/response types, exposed-entity types, capabilities/options, protocol/error constants.
- `mcp-server.ts`: compatibility barrel around the split server modules.

Resource/prompt/sampling modules:
- `mcp-resource-types.ts` + `mcp-resources.ts`
- `mcp-prompt-types.ts`
- `mcp-sampling-types.ts` + `mcp-sampling.ts`

Lifecycle and reliability modules:
- `mcp-registry-types.ts`: zod schema + inferred types for persistent-style server/profile definitions.
- `mcp-manager.ts`: `McpManager` interface and `InMemoryMcpManager` implementation.
- `mcp-reliability.ts`: health tracking, circuit integration, heartbeat timers, discovery cache.
- `mcp-connection-pool.ts`: connection reuse, retry/backoff windows, tool descriptor cache.
- `mcp-security.ts`: stdio path/env hardening.

Export shape:
- `src/mcp/index.ts` exports client/server/bridge/deferred/resources/prompts/sampling APIs and types.
- Root `src/index.ts` exports a wider MCP surface, including manager/reliability/registry/security.
- `mcp-connection-pool.ts` is implemented and tested but is not exported from `src/mcp/index.ts` or root `src/index.ts`.

## Runtime and Control Flow
1. Server registration and connection:
- Call `MCPClient.addServer(config)` to register connection metadata.
- Call `connect(serverId)` or `connectAll()`.
- Discovery dispatch:
  - `http`: `POST {url}/tools/list` via `fetchWithOutboundUrlPolicy`.
  - `sse`: currently reuses HTTP discovery path (`discoverViaSse -> discoverViaHttp`).
  - `stdio`: spawns configured executable, writes JSON-RPC line, parses last JSON line from stdout.
- After discovery, tools are split into eager/deferred using `maxEagerTools`.

2. Tool invocation:
- `invokeTool(name, args)` resolves descriptor from connected servers.
- Dispatch:
  - `http`/`sse`: `POST {url}/tools/call`.
  - `stdio`: one-shot spawn, write JSON-RPC request, parse last JSON line.
- Failure mode is error-as-data: returns `MCPToolResult` with `isError: true` instead of throwing to caller.

3. Deferred loading path:
- `DeferredToolLoader.maxEagerTools` is derived from `contextWindowTokens * maxToolBudgetRatio / tokensPerTool`.
- `getEagerTools()` converts eager descriptors to LangChain tools with memoized cache.
- `loadTool(toolName)` promotes deferred descriptor into eager list and cache.

4. Server request routing:
- `DzupAgentMCPServer.handleRequest(request)` validates request envelope with `isMCPRequest`.
- Supported methods:
  - `initialize`
  - `tools/list`, `tools/call`
  - `resources/list`, `resources/templates/list`, `resources/read`
  - `prompts/list`, `prompts/get`
  - `sampling/createMessage`
- Requests without an `id` are treated as notifications: handler executes but response is `null`.

5. Resources and prompts:
- `MCPResourceClient` wraps `sendRequest` to perform list/templates/read.
- `subscribeToResource` sends best-effort `resources/subscribe`, registers update handler for `notifications/resources/updated`, and re-reads content on update.
- Prompt descriptors and resolved prompt messages are represented via `mcp-prompt-types.ts` and served through server prompt registry.

6. Sampling:
- `createSamplingHandler`:
  - clamps `request.maxTokens` to configured `maxAllowedTokens`
  - optionally enforces `budget.maxTokens`
  - resolves model from preference hints or default
  - maps MCP content to text payloads for `llmInvoke`
  - maps stop reasons back to MCP enum
- `registerSamplingHandler` binds handler to `sampling/createMessage` with an unregister guard.

7. Optional reliability/manager/pool composition:
- `InMemoryMcpManager` manages server/profile records and optional connectivity tests via injected `MCPClient`; emits `mcp:*` events when `DzupEventBus` is provided.
- `McpReliabilityManager` tracks health and circuit state per server, with heartbeat and TTL discovery cache.
- `McpConnectionPool` wraps an `MCPClient` to gate reconnect attempts via exponential backoff and reuse/caching behavior.

## Key APIs and Types
Primary classes/functions:
- `MCPClient`
- `DeferredToolLoader`
- `mcpToolToLangChain`, `mcpToolsToLangChain`, `langChainToolToMcp`
- `DzupAgentMCPServer`, `isMCPRequest`
- `MCPResourceClient`
- `createSamplingHandler`, `registerSamplingHandler`
- `validateMcpExecutablePath`, `sanitizeMcpEnv`
- `InMemoryMcpManager` (`McpManager` interface)
- `McpReliabilityManager`
- `McpConnectionPool`, `hashServerConfig`, `calculateBackoff` (source-internal export only)

Core type families:
- Client/transport: `MCPTransport`, `MCPServerConfig`, `MCPConnectionState`, `MCPServerStatus`
- Tool contracts: `MCPToolParameter`, `MCPToolDescriptor`, `MCPToolResult`
- Server protocol: `MCPRequest`, `MCPResponse`, `MCPRequestId`, `MCPServerCapabilities`, `MCPInitializeResult`, `MCPServerOptions`
- Exposed server entities: `MCPExposedTool`, `MCPExposedResource`, `MCPExposedResourceTemplate`, `MCPExposedPrompt`
- Resource contracts: `MCPResource`, `MCPResourceTemplate`, `MCPResourceContent`, `ResourceSubscription`, `ResourceChangeHandler`
- Prompt contracts: `MCPPromptDescriptor`, `MCPPromptArgument`, `MCPPromptGetResult`, `MCPPromptMessage`, `MCPPromptContent`
- Sampling contracts: `MCPSamplingRequest`, `MCPSamplingResponse`, `MCPSamplingMessage`, `SamplingHandler`, `LLMInvokeFn`
- Manager/registry contracts: `McpServerDefinition`, `McpProfile`, `McpServerInput`, `McpServerPatch`, `McpTestResult`
- Reliability/pool contracts: `McpServerHealth`, `McpReliabilityConfig`, `McpConnectionPoolConfig`

## Dependencies
Package-level dependencies relevant to MCP:
- Runtime dependency: `@dzupagent/security` (indirectly used through core security modules).
- Peer dependencies used directly in MCP code:
  - `@langchain/core` (`@langchain/core/tools` for tool bridging)
  - `zod` (schema conversion and registry schemas)

Internal core dependencies used by MCP modules:
- `../security/outbound-url-policy.js` (`fetchWithOutboundUrlPolicy`)
- `../errors/forge-error.js` (`ForgeError` in security helpers)
- `../llm/circuit-breaker.js` (`CircuitBreaker` used by reliability manager)
- `../utils/backoff.js` (shared backoff calculation)
- `../events/event-bus.js` and event type unions for manager event emission

Node built-ins:
- `node:child_process` (stdio transport process spawning)
- `node:crypto` (config hash for pooling)

## Integration Points
Internal integration points in `@dzupagent/core`:
- Root exports (`src/index.ts`) expose broader MCP functionality than `@dzupagent/core/mcp`.
- Event contracts in `src/events/event-types-orchestration.ts` define manager lifecycle/test events (`mcp:server_*`, `mcp:test_*`).
- Flow contracts in `src/flow/handle-types.ts` define `McpToolHandle` used by flow compiler/lowering layers.
- Format adapters in `src/formats` include MCP descriptor conversion utilities (`toMCPToolDescriptor`, `fromMCPToolDescriptor`) exposed at root.

External composition patterns enabled by current code:
- HTTP/SSE/stdio transport layers can delegate protocol handling to `DzupAgentMCPServer.handleRequest`.
- Agent/tool loops can bridge discovered MCP tools into LangChain via `mcpToolsToLangChain(client)`.
- Control-plane implementations can combine `MCPClient` with `InMemoryMcpManager` and/or `McpReliabilityManager`.
- Internal source consumers can layer `McpConnectionPool` for retry/cache behavior, but downstream package consumers cannot import it directly via published exports.

## Testing and Observability
MCP-focused tests:
- `src/mcp/__tests__/mcp-server.test.ts`
  - initialize capabilities, prompts/resources/sampling routes, notification behavior (`id` omitted => `null`), parameter/error mapping.
- `src/mcp/__tests__/mcp-resources.test.ts`
  - list/templates/read parsing, subscribe/unsubscribe lifecycle, notification-driven reread.
- `src/mcp/__tests__/mcp-sampling.test.ts`
  - model selection, token clamping, budget guards, stop-reason mapping, image placeholder behavior, unregister path.

Cross-module MCP tests under `src/__tests__`:
- `mcp-client-stdio-exit.test.ts`: stdio success is gated on child exit code; partial stdout on non-zero exit is rejected.
- `mcp-security.test.ts`: executable-path and env sanitization behavior.
- `mcp-manager.test.ts`: server/profile lifecycle and event emission behavior.
- `mcp-reliability.test.ts`: heartbeat/circuit/cache/health flows.
- `mcp-connection-pool.test.ts`: hash/backoff/retry/cache/release/dispose behavior.
- `plugin-mcp-deep.test.ts`: deeper lifecycle and multi-server MCP client routing coverage.

Observability surfaces in implementation:
- `MCPClient.getStatus()` returns per-server state, tool counts, and `lastError`.
- `InMemoryMcpManager` can emit typed `mcp:*` events through `DzupEventBus`.
- `McpReliabilityManager` exposes health snapshots, circuit state, heartbeat activity, and discovery cache state.

## Risks and TODOs
Code-observed limitations and risks:
- SSE transport in `MCPClient` currently uses the HTTP discovery path; no dedicated stream/session semantics are implemented in this module.
- Stdio transport is one-process-per-request for discovery and tool calls, which can add startup overhead under high call volume.
- `MCPClient` uses error-as-data for tool invocation; callers must always check `isError` and not assume thrown exceptions.
- `MCPResourceClient` subscription behavior is best-effort and depends on caller-provided notification wiring.
- `MCPResourceClient` sends `resources/subscribe`/`resources/unsubscribe`, but `DzupAgentMCPServer` does not currently implement those methods.
- `InMemoryMcpManager` is non-persistent and suitable for in-memory/dev/test usage; no persistent implementation exists in this directory.
- `McpConnectionPool` is implemented/tested but not exported through public package entrypoints.
- `MCPSamplingConfig.budget.maxCostCents` is defined but not enforced in `createSamplingHandler`.
- `validateMcpExecutablePath` blocks metacharacters/traversal but does not enforce absolute-path allowlists; runtime trust still depends on caller configuration.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js