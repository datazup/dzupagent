# Protocol Architecture (`packages/core/src/protocol`)

## Scope
This document covers the protocol subsystem implemented in `packages/core/src/protocol`:

- `message-types.ts`
- `message-schemas.ts`
- `message-factory.ts`
- `serialization.ts`
- `adapter.ts`
- `internal-adapter.ts`
- `protocol-router.ts`
- `protocol-bridge.ts`
- `a2a-client-adapter.ts`
- `a2a-sse-stream.ts`
- `a2a-json-rpc.ts`
- `a2a-push-notification.ts`
- `index.ts`

It also references package-level integration and contract points in:

- `packages/core/src/index.ts`
- `packages/core/src/facades/orchestration.ts`
- `packages/core/src/events/agent-bus.ts`
- `packages/core/src/errors/error-codes.ts`
- `packages/core/src/errors/forge-error.ts`
- `packages/core/package.json`
- `packages/core/vitest.config.ts`

## Responsibilities
The protocol module is the transport boundary for inter-agent messages in `@dzupagent/core`. Its current responsibilities are:

- Define a protocol-agnostic envelope (`ForgeMessage`) and payload union (`ForgePayload`).
- Validate message URIs, payloads, metadata, and envelope shape at runtime using Zod.
- Provide factory utilities for message IDs, request/response/error creation, TTL checks, and non-throwing validation.
- Provide serialization/deserialization (`JSONSerializer`) with `Uint8Array` support.
- Define a generic adapter interface (`ProtocolAdapter`) with connect/send/stream/subscribe/health lifecycle.
- Implement two concrete transport paths:
- `InternalAdapter` for in-process routing over `AgentBus`.
- `A2AClientAdapter` for HTTP JSON-RPC + SSE against A2A agents.
- Route outbound messages by URI scheme via `ProtocolRouter`.
- Bridge messages between adapters/protocols with optional translation (`ProtocolBridge`).
- Provide A2A utilities:
- JSON-RPC request/response helpers and validators.
- Task push-notification registration and delivery service.

## Structure
The implementation is split by concern:

| Area | Files | Notes |
| --- | --- | --- |
| Core message model | `message-types.ts`, `message-schemas.ts`, `message-factory.ts` | Envelope, payload union, validation, factory helpers |
| Transport contract | `adapter.ts` | Shared adapter interface and health/send option types |
| In-process transport | `internal-adapter.ts` | Channel-based request/response and stream routing over `AgentBus` |
| Remote A2A transport | `a2a-client-adapter.ts`, `a2a-sse-stream.ts` | JSON-RPC `tasks/send` and `/tasks/{id}/stream` SSE updates |
| Routing and bridging | `protocol-router.ts`, `protocol-bridge.ts` | URI scheme dispatch and protocol translation helpers |
| Serialization boundary | `serialization.ts` | JSON bytes in/out, schema validation on decode |
| A2A utility support | `a2a-json-rpc.ts`, `a2a-push-notification.ts` | Server/client helpers and webhook push delivery |
| Public surface | `index.ts` | Barrel exports for protocol APIs/types |

## Runtime and Control Flow
1. Message creation and validation:
- Callers typically create envelopes with `createForgeMessage()` (default protocol `internal`).
- Optional runtime checks happen through `validateForgeMessage()` or during deserialize.

2. Adapter selection:
- `ProtocolRouter.route()` and `routeStream()` parse `message.to` scheme (`forge://`, `a2a://`, etc.).
- The router forwards to the registered adapter for that scheme, or `defaultAdapter` if configured.
- Missing adapter throws `ForgeError` with `MESSAGE_ROUTING_FAILED`.

3. Internal transport flow:
- `InternalAdapter.send()` computes target channel from URI (`extractAgentId`, strips `@version` suffix).
- It publishes request payload on `AgentBus` and waits on `__response:<message.id>`.
- Response resolves when a handler publishes to that channel; otherwise timeout/abort raises `PROTOCOL_TIMEOUT` or `PROTOCOL_SEND_FAILED`.
- `InternalAdapter.stream()` uses `__stream:<message.id>` and yields until `stream_end`.

4. A2A unary flow:
- `A2AClientAdapter.send()` translates `ForgePayload` to A2A parts and POSTs JSON-RPC `tasks/send`.
- It retries recoverable failures (network/5xx) with exponential backoff.
- Successful task result is translated back to a Forge `response` with `metadata.a2aTaskId` and `metadata.a2aTaskState`.

5. A2A streaming flow:
- `A2AClientAdapter.stream()` calls `send()` first and yields the initial response.
- If state is non-terminal, it opens SSE via `streamA2ATask()`.
- SSE events are parsed by `parseSSEEvents()` and mapped to `stream_chunk`, `stream_end`, or `error` Forge messages.
- Reconnect uses `Last-Event-ID` and bounded retry attempts.

6. Bridge flow:
- `ProtocolBridge.bridge()` optionally transforms then forces `protocol` to target adapter protocol and sends via target adapter.
- `ProtocolBridge.start(pattern)` subscribes on source adapter and forwards source-to-target.
- Static helpers `mcpToA2A()` and `a2aToMcp()` handle common payload translations (`tool_call <-> task`, text/json/error -> `tool_result`).

7. Serialization flow:
- `JSONSerializer.serialize()` converts envelope to UTF-8 JSON bytes (with `__uint8:` base64 markers for binary payload data).
- `deserialize()` parses bytes, revives binary data, validates with `ForgeMessageSchema`, and throws `SERIALIZATION_FAILED` on invalid input.

## Key APIs and Types
Primary exports from `src/protocol/index.ts` and re-exported by `src/index.ts`:

- Message model:
- `ForgeMessage`, `ForgePayload`, `ForgeProtocol`, `ForgeMessageMetadata`
- `ForgeMessageSchema`, `ForgePayloadSchema`, `ForgeMessageUriSchema`
- Message helpers:
- `createMessageId()`
- `createForgeMessage()`
- `createResponse()`
- `createErrorResponse()`
- `isMessageAlive()`
- `validateForgeMessage()`
- Adapter contract:
- `ProtocolAdapter`, `SendOptions`, `AdapterHealthStatus`, `Subscription`
- Adapters:
- `InternalAdapter`
- `A2AClientAdapter`
- Router and bridge:
- `ProtocolRouter`
- `ProtocolBridge`
- `ProtocolBridge.mcpToA2A()`
- `ProtocolBridge.a2aToMcp()`
- A2A streaming and JSON-RPC:
- `streamA2ATask()`
- `parseSSEEvents()`
- `JSON_RPC_ERRORS`, `A2A_ERRORS`
- `createJsonRpcSuccess()`, `createJsonRpcError()`
- `validateJsonRpcRequest()`, `validateJsonRpcBatch()`
- Serialization and notifications:
- `JSONSerializer`, `defaultSerializer`
- `PushNotificationService`

## Dependencies
Protocol-specific direct dependencies in code:

- External:
- `zod` (`message-schemas.ts`)
- `node:crypto` (`message-factory.ts` for `randomUUID`)
- `fetch`, `Response`, `ReadableStream`, `AbortController` globals (`a2a-*`)
- Internal package modules:
- `../events/agent-bus.js` (`InternalAdapter`)
- `../errors/forge-error.js` and `../errors/error-codes.js` (typed error behavior)

Package-level dependency context (`packages/core/package.json`):

- Runtime deps: `@dzupagent/context`, `@dzupagent/memory`, `@dzupagent/runtime-contracts`
- Peer deps include `zod` (required by protocol schemas) and other optional runtime integrations.

## Integration Points
Within `@dzupagent/core`:

- Root exports (`src/index.ts`) expose the full protocol API surface.
- Facade exports (`src/facades/orchestration.ts`) expose a curated subset:
- Includes message helpers, `InternalAdapter`, `ProtocolRouter`, `A2AClientAdapter`, `streamA2ATask`, `parseSSEEvents`, `ProtocolBridge`.
- Excludes some protocol utilities (for example `JSONSerializer`, JSON-RPC helpers, and push notifications), which remain available from root/advanced.

Cross-module contracts:

- `InternalAdapter` uses `AgentBus` channel semantics from `src/events/agent-bus.ts`.
- Protocol failures are standardized as `ForgeError` with protocol-related codes (`PROTOCOL_*`, `MESSAGE_ROUTING_FAILED`, `SERIALIZATION_FAILED`).
- URI validation intentionally allows non-`forge://` schemes to support cross-protocol routing.

## Testing and Observability
Protocol test coverage is concentrated in:

- `src/protocol/__tests__/protocol.test.ts`
- `src/protocol/__tests__/adapters.test.ts`
- `src/protocol/__tests__/bridge.test.ts`
- `src/protocol/__tests__/serialization.test.ts`
- `src/protocol/__tests__/a2a-sse.test.ts`
- `src/protocol/__tests__/a2a-json-rpc.test.ts`
- `src/protocol/__tests__/a2a-push-notification.test.ts`

Current tests verify:

- All payload variants and schema validity rules.
- Strict envelope validation with metadata passthrough behavior.
- Internal adapter routing, timeout, and version-suffix stripping.
- Router adapter selection/default fallback behavior.
- A2A client translation, retry/backoff, timeout, and abort handling.
- SSE parsing, stream conversion, reconnection, and adapter stream integration.
- Bridge translation and forwarding behavior.
- JSON-RPC validation and helper factories.
- Push notification registration/filtering/retry semantics.
- Serializer round-trips (including binary payload).

Observability in this module today:

- Adapters expose `health()` state snapshots.
- Protocol code itself does not emit metrics/events directly; observability is mainly via adapter state and upstream logging/error handling.

## Risks and TODOs
- `ProtocolBridge.start()` is implemented as source-to-target forwarding only, while comments describe bidirectional behavior; clarify intent or add reverse wiring.
- `A2AClientAdapter` maps Forge `binary` payloads to A2A `file` parts with only `mimeType` (no binary body), which can drop payload data across protocol boundary.
- `A2AClientAdapter.connect()` depends on configured `baseUrl`; without it, agent-card check is attempted against an empty base path.
- `PushNotificationService` keeps registrations in memory only; process restarts lose subscription state.
- `InternalAdapter.stream()` creates per-wait timeout timers without explicit cancellation bookkeeping after successful wakeups; worth tightening for long-lived/high-volume streams.
- `a2a-sse-stream.ts` includes an unused `StreamEndSignal` type, indicating stale internal path that can be removed or wired.

## Changelog
- 2026-04-16: automated refresh via scripts/refresh-architecture-docs.js