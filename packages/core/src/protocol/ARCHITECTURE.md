# Protocol Architecture (`packages/core/src/protocol`)

This document describes the architecture, feature set, execution flow, usage patterns, cross-package references, and current test coverage for the protocol subsystem in `@dzupagent/core`.

## 1. Scope

Analyzed source files:

- `adapter.ts`
- `internal-adapter.ts`
- `protocol-router.ts`
- `protocol-bridge.ts`
- `message-types.ts`
- `message-schemas.ts`
- `message-factory.ts`
- `serialization.ts`
- `a2a-client-adapter.ts`
- `a2a-sse-stream.ts`
- `a2a-json-rpc.ts`
- `a2a-push-notification.ts`
- `index.ts`

Analyzed tests:

- `__tests__/protocol.test.ts`
- `__tests__/adapters.test.ts`
- `__tests__/bridge.test.ts`
- `__tests__/serialization.test.ts`
- `__tests__/a2a-sse.test.ts`
- `__tests__/a2a-json-rpc.test.ts`
- `__tests__/a2a-push-notification.test.ts`

## 2. Purpose and Design Intent

The protocol module is the transport abstraction layer for agent-to-agent and agent-to-service messaging. It provides:

1. A single typed envelope (`ForgeMessage`) usable across protocols.
2. Validation and serialization boundaries for safe transport.
3. A transport adapter contract (`ProtocolAdapter`) for pluggable protocols.
4. Concrete transport implementations:
   - `internal` (in-process event bus)
   - `a2a` (HTTP JSON-RPC + SSE)
5. Protocol orchestration utilities:
   - URI-based router
   - message bridge between protocol formats
6. A2A protocol helpers for server-side JSON-RPC compatibility and push notifications.

This keeps protocol-specific concerns decoupled from higher-level runtime/orchestration concerns.

## 3. Module Responsibilities

| File | Responsibility |
| --- | --- |
| `message-types.ts` | Canonical message and payload type system (`ForgeMessage`, payload union, metadata/budget/priority). |
| `message-schemas.ts` | Runtime validation schemas (Zod) for URI, payload, metadata, envelope. |
| `message-factory.ts` | Message ID generation, envelope creation, response/error helpers, TTL check, validation wrapper. |
| `serialization.ts` | JSON serializer/deserializer with `Uint8Array` handling and schema validation on decode. |
| `adapter.ts` | Protocol adapter lifecycle/send/stream/subscribe/health contract. |
| `internal-adapter.ts` | In-process adapter over `AgentBus` with correlation channels and timeout/abort handling. |
| `protocol-router.ts` | URI scheme to adapter dispatch (`route`, `routeStream`, fallback adapter). |
| `protocol-bridge.ts` | Cross-protocol forwarding and payload translation (`mcp <-> a2a`). |
| `a2a-client-adapter.ts` | A2A outbound client: Forge -> A2A JSON-RPC mapping, retries, stream bootstrap. |
| `a2a-sse-stream.ts` | SSE parser + reconnecting stream client for A2A task updates. |
| `a2a-json-rpc.ts` | JSON-RPC 2.0/A2A error codes + request/batch validation helpers. |
| `a2a-push-notification.ts` | Task webhook registration and push delivery with retry behavior. |
| `index.ts` | Barrel exports for protocol APIs. |

## 4. Core Data Model

### 4.1 Envelope (`ForgeMessage`)

`ForgeMessage` unifies protocol messages with:

- identity: `id`, `type`, `timestamp`
- routing: `from`, `to`, `protocol`
- threading: `correlationId`, `parentId`
- content: `payload`
- telemetry and control: `metadata` (trace/span, priority, ttl, budget, extension fields)

### 4.2 Payload Union

Supported payload variants:

- `text`
- `json`
- `tool_call`
- `tool_result`
- `task`
- `binary`
- `error`

This enables one transport-agnostic envelope while still supporting tooling, tasks, streams, and error propagation.

### 4.3 URI Strategy

Routing is URI-scheme-driven:

- `forge://...`
- `a2a://...`
- `mcp://...`
- `http(s)://...`
- `ws(s)://...`
- `grpc://...`

`ForgeMessageUriSchema` intentionally accepts broader schemes than identity-only URI validators.

## 5. Feature Catalog

### 5.1 Strongly-Typed Cross-Protocol Messaging

A single type system models all transports and payload classes, so higher-level runtime code does not need per-protocol envelope branching.

### 5.2 Safe Runtime Validation

`ForgeMessageSchema` is strict at top-level and permissive for metadata extensions. Invalid messages fail via explicit validation results or serialization errors.

### 5.3 Deterministic Message Construction

Factory helpers provide consistent defaults and threading semantics:

- `createMessageId()`
- `createForgeMessage()`
- `createResponse()`
- `createErrorResponse()`
- `isMessageAlive()`
- `validateForgeMessage()`

### 5.4 Protocol Adapter Contract

`ProtocolAdapter` defines a common lifecycle and runtime interface:

- `connect` / `disconnect`
- unary send (`send`)
- streaming send (`stream`)
- incoming subscription (`subscribe`)
- health status (`health`)

### 5.5 Internal In-Process Transport

`InternalAdapter` uses `AgentBus` channels and correlation topics:

- response channel pattern: `__response:<messageId>`
- stream channel pattern: `__stream:<messageId>`
- URI helper strips `@version` suffix from target path (`extractAgentId`)

This gives low-latency transport for same-process agents without network hops.

### 5.6 URI-Scheme Routing

`ProtocolRouter` dispatches by `message.to` scheme, supports default fallback adapter, and throws `MESSAGE_ROUTING_FAILED` with context when unresolvable.

### 5.7 Cross-Protocol Bridging

`ProtocolBridge` forwards between adapters and offers static translators:

- `mcpToA2A()` converts `tool_call` to `task`
- `a2aToMcp()` converts `task/text/json/error` to `tool_result`

Trace metadata is preserved through translation.

### 5.8 A2A Client Transport

`A2AClientAdapter` supports:

- endpoint health check via `/.well-known/agent.json`
- Forge payload to A2A message-part mapping
- retries with exponential backoff for recoverable failures
- timeout and abort propagation
- task response mapping back into Forge envelope
- optional stream continuation via SSE

### 5.9 SSE Streaming with Reconnect

`streamA2ATask()` handles:

- SSE parsing (multi-line `data`, `event`, `id`, `retry`, comments)
- reconnect attempts with optional `Last-Event-ID`
- conversion of status/artifact updates into Forge stream messages
- terminal mapping (`completed` -> `stream_end`, `failed` -> `error`)

### 5.10 JSON Serialization Boundary

`JSONSerializer` serializes Forge envelopes to `Uint8Array` and back. It transparently round-trips binary payload bytes via a base64 marker (`__uint8:`).

### 5.11 A2A JSON-RPC 2.0 Utilities

`a2a-json-rpc.ts` provides:

- standard JSON-RPC error constants
- A2A-specific error constants in server range (`-32000` to `-32099`)
- response factories
- single and batch request validators

### 5.12 A2A Push Notifications

`PushNotificationService` provides per-task webhook registration and event delivery with:

- optional event filtering
- optional bearer token auth
- one retry for transient/network failures

## 6. Execution Flows

### 6.1 Flow A: Internal Adapter Request/Response

1. Caller creates a `ForgeMessage` with `to=forge://...`.
2. `InternalAdapter.send()` extracts target agent id from URI.
3. Adapter subscribes to `__response:<messageId>`.
4. Adapter publishes wrapped message on target channel via `AgentBus`.
5. Receiver handler processes and publishes response to response channel.
6. Sender unsubscribes and resolves response (or times out/aborts).

### 6.2 Flow B: URI-Based Dispatch

1. Caller sends through `ProtocolRouter.route()`.
2. Router extracts URI scheme from `message.to`.
3. Router resolves scheme adapter or default adapter.
4. Router delegates to `adapter.send()` or `adapter.stream()`.

### 6.3 Flow C: A2A Unary Send

1. `A2AClientAdapter.send()` resolves endpoint URL.
2. Forge payload is transformed into A2A `parts`.
3. Adapter builds JSON-RPC request (`tasks/send`).
4. Adapter performs HTTP POST with timeout/abort handling.
5. Recoverable errors retry with exponential backoff.
6. JSON-RPC result maps back to Forge response (`protocol: 'a2a'`).

### 6.4 Flow D: A2A Streaming

1. `A2AClientAdapter.stream()` first calls `send()`.
2. Immediate response is yielded.
3. If task state is non-terminal, adapter calls `streamA2ATask()`.
4. SSE events are parsed and converted to Forge stream messages.
5. Stream stops on terminal event, abort, or reconnect exhaustion.

### 6.5 Flow E: Protocol Bridge (MCP <-> A2A)

1. Source message enters `ProtocolBridge`.
2. Optional transform callback runs.
3. Bridge enforces target protocol value.
4. Message is sent via target adapter.
5. Static mapper helpers can be used where explicit format conversion is required.

### 6.6 Flow F: Server-Side A2A JSON-RPC Handling

`packages/server/src/routes/a2a.ts` uses core protocol helpers:

1. Parse request body.
2. Validate as JSON-RPC single or batch (`validateJsonRpcRequest` / `validateJsonRpcBatch`).
3. Dispatch method and task-store actions.
4. Return consistent JSON-RPC responses (`createJsonRpcSuccess` / `createJsonRpcError`).
5. Use standardized error codes (`JSON_RPC_ERRORS`, `A2A_ERRORS`).

## 7. Public API Surface

Exported through `@dzupagent/core` (`packages/core/src/index.ts`):

- message contracts and schemas
- message factories and validation
- adapter contracts and concrete adapters
- router and bridge
- SSE helpers
- serializer
- A2A JSON-RPC helpers
- push notification service

Also re-exported through the orchestration facade (`packages/core/src/facades/orchestration.ts`).

## 8. Cross-Package References and Usage

### 8.1 `@dzupagent/server`

Primary runtime usage outside `core` is in:

- `packages/server/src/routes/a2a.ts`

Used symbols:

- `JSON_RPC_ERRORS`
- `A2A_ERRORS`
- `createJsonRpcError`
- `createJsonRpcSuccess`
- `validateJsonRpcRequest`
- `validateJsonRpcBatch`
- JSON-RPC related types

Usage role:

- Implements server-side A2A JSON-RPC endpoint behavior with standardized validation and error semantics from core.

### 8.2 `@dzupagent/core` internal surfaces

- `packages/core/src/index.ts` re-exports the full protocol module.
- `packages/core/src/facades/orchestration.ts` re-exports a protocol subset for orchestration consumers.
- `packages/core/src/__tests__/facades.test.ts` asserts protocol exports are available through facades.

### 8.3 Current adoption snapshot

In this repository snapshot, direct runtime imports of protocol routing/adapter/bridge/message-factory APIs from packages other than `core` are limited. The clearest downstream runtime consumer is server A2A route handling via JSON-RPC helpers.

## 9. Usage Examples

### 9.1 Create and validate a message

```ts
import { createForgeMessage, validateForgeMessage } from '@dzupagent/core'

const msg = createForgeMessage({
  type: 'request',
  from: 'forge://team/orchestrator',
  to: 'forge://team/reviewer',
  protocol: 'internal',
  payload: { type: 'text', content: 'Review this patch' },
  metadata: { traceId: 'trace-123', ttlMs: 30_000 },
})

const result = validateForgeMessage(msg)
if (!result.success) throw new Error(result.errors.join('; '))
```

### 9.2 Route by URI scheme

```ts
import { ProtocolRouter, InternalAdapter } from '@dzupagent/core'

const router = new ProtocolRouter()
router.registerAdapter('forge', new InternalAdapter({ agentBus }))
router.registerAdapter('a2a', a2aAdapter)

const response = await router.route(msg)
```

### 9.3 Bridge MCP tool calls to A2A

```ts
import { ProtocolBridge } from '@dzupagent/core'

const bridge = new ProtocolBridge({
  source: mcpAdapter,
  target: a2aAdapter,
  transform: (message, direction) => {
    if (direction === 'source-to-target') return ProtocolBridge.mcpToA2A(message)
    return message
  },
})

const bridged = await bridge.bridge(incomingMcpMessage)
```

### 9.4 Send to A2A endpoint with retries

```ts
import { A2AClientAdapter, createForgeMessage } from '@dzupagent/core'

const adapter = new A2AClientAdapter({
  baseUrl: 'https://agent.example.com',
  maxRetries: 3,
  retryDelayMs: 500,
})

const req = createForgeMessage({
  type: 'request',
  from: 'forge://team/orchestrator',
  to: 'a2a://agent.example.com',
  protocol: 'a2a',
  payload: { type: 'text', content: 'Summarize the incident.' },
})

const res = await adapter.send(req)
```

### 9.5 Consume A2A SSE stream updates

```ts
import { streamA2ATask } from '@dzupagent/core'

for await (const event of streamA2ATask('https://agent.example.com', 'task-123', {
  maxReconnects: 5,
  reconnectDelayMs: 1000,
})) {
  if (event.type === 'stream_chunk') {
    // partial update
  }
  if (event.type === 'stream_end') {
    // terminal completion
  }
}
```

### 9.6 JSON serialization with binary payload support

```ts
import { JSONSerializer } from '@dzupagent/core'

const serializer = new JSONSerializer()
const bytes = serializer.serialize(message)
const restored = serializer.deserialize(bytes)
```

## 10. Test Coverage

## 10.1 Executed protocol test suite

Command executed:

- `yarn workspace @dzupagent/core test src/protocol/__tests__`

Result:

- 7 test files passed
- 198 tests passed

Per-file test counts (Vitest):

- `protocol.test.ts`: 52
- `adapters.test.ts`: 45
- `a2a-json-rpc.test.ts`: 29
- `a2a-sse.test.ts`: 21
- `serialization.test.ts`: 19
- `bridge.test.ts`: 16
- `a2a-push-notification.test.ts`: 16

## 10.2 Coverage metrics for `src/protocol/*`

Coverage command executed:

- `yarn workspace @dzupagent/core test:coverage src/protocol/__tests__`

Important note:

- The command reports protocol coverage successfully, but exits non-zero because package-wide global thresholds apply to non-protocol files not included in this focused run.

Protocol folder aggregate (from `packages/core/coverage/coverage-summary.json`):

- lines/statements: **89.14%**
- branches: **77.38%**
- functions: **91.46%**

Per-file coverage:

- `a2a-client-adapter.ts`: 89.24% lines, 74.75% branches, 87.5% functions
- `a2a-json-rpc.ts`: 99.21% lines, 96.77% branches, 100% functions
- `a2a-push-notification.ts`: 96.8% lines, 90.62% branches, 100% functions
- `a2a-sse-stream.ts`: 80.9% lines, 67.36% branches, 75% functions
- `internal-adapter.ts`: 65.81% lines, 68.96% branches, 81.81% functions
- `message-factory.ts`: 100% lines/branches/functions
- `message-schemas.ts`: 100% lines/statements
- `protocol-bridge.ts`: 97.79% lines, 73.91% branches, 100% functions
- `protocol-router.ts`: 100% lines, 85% branches, 100% functions
- `serialization.ts`: 89.55% lines, 80.95% branches, 100% functions

## 10.3 Coverage strengths

- Message construction/validation path is heavily tested.
- A2A JSON-RPC helper correctness is near-complete.
- Router and bridge behavior are strongly covered.
- Push notification lifecycle and retry behavior are well-covered.

## 10.4 Coverage gaps and residual risk

Lower relative coverage areas are concentrated in:

- `internal-adapter.ts` (streaming edge paths and handler-error/unsubscribe edge cases)
- `a2a-sse-stream.ts` (more reconnect/partial-frame/error-path combinations)

These are the highest-value areas for additional tests if branch-hardening is desired.

## 11. Practical Guidance

For in-process agent meshes, start with `InternalAdapter + ProtocolRouter`.

For cross-process A2A interop, use `A2AClientAdapter` and optionally stream with `streamA2ATask`.

For mixed ecosystems (for example MCP tooling interacting with A2A agents), apply `ProtocolBridge` mappers to preserve metadata while translating payload shape.

For server endpoints that speak A2A JSON-RPC, reuse `a2a-json-rpc` helpers to keep behavior and error codes aligned with client expectations.
