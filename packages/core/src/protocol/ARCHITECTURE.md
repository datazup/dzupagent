# Protocol Architecture (`packages/core/src/protocol`)

## Scope
This document covers the protocol subsystem in `packages/core/src/protocol`:

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

It also references integration/export surfaces in:

- `packages/core/src/index.ts`
- `packages/core/src/facades/orchestration.ts`
- `packages/core/package.json`
- protocol tests under `packages/core/src/protocol/__tests__`

## Responsibilities
The protocol module provides transport-agnostic messaging and adapter wiring for inter-agent communication in `@dzupagent/core`.

Current responsibilities are:

- Define message envelope and payload contracts (`ForgeMessage`, `ForgePayload`, protocol/type discriminators).
- Validate envelope and payload shape at runtime with Zod schemas.
- Create IDs/messages/responses/errors and check TTL viability.
- Serialize and deserialize messages to/from `Uint8Array` with binary payload support.
- Define the common adapter contract (`ProtocolAdapter`) and health/send/stream/subscribe lifecycle.
- Implement concrete adapters:
  - `InternalAdapter` for in-process delivery over `AgentBus`.
  - `A2AClientAdapter` for JSON-RPC HTTP + SSE streaming against A2A endpoints.
- Route messages to scheme-specific adapters via `ProtocolRouter`.
- Bridge and optionally translate payloads between adapters via `ProtocolBridge`.
- Provide A2A helper utilities:
  - JSON-RPC constants/factories/validators.
  - In-memory push notification registration and delivery with retry.

## Structure
Implementation structure by concern:

- Message model and validation:
  - `message-types.ts`
  - `message-schemas.ts`
  - `message-factory.ts`
- Serialization:
  - `serialization.ts`
- Adapter contract and routing:
  - `adapter.ts`
  - `protocol-router.ts`
  - `protocol-bridge.ts`
- Concrete transports:
  - `internal-adapter.ts`
  - `a2a-client-adapter.ts`
  - `a2a-sse-stream.ts`
- A2A support utilities:
  - `a2a-json-rpc.ts`
  - `a2a-push-notification.ts`
- Public exports:
  - `index.ts`

## Runtime and Control Flow
1. Message creation and validation
- Callers build envelopes via `createForgeMessage()` (default protocol: `internal`).
- `createResponse()` and `createErrorResponse()` derive reply envelopes.
- Runtime checks use `validateForgeMessage()` or schema validation during deserialize.

2. Adapter resolution and routing
- `ProtocolRouter` extracts URI scheme from `message.to` (text before `://`).
- It dispatches to a registered adapter for that scheme, or `defaultAdapter` if provided.
- Missing adapter raises `ForgeError` with `MESSAGE_ROUTING_FAILED`.

3. Internal adapter flow
- `InternalAdapter.send()` extracts target agent from URI (`extractAgentId()` strips optional `@version` suffix).
- It publishes a message payload to `AgentBus` and waits on `__response:<message.id>`.
- Timeout yields `PROTOCOL_TIMEOUT`; abort yields `PROTOCOL_SEND_FAILED`.
- `stream()` publishes once and yields buffered messages from `__stream:<message.id>` until `stream_end`.

4. A2A unary flow
- `A2AClientAdapter.send()` converts Forge payload to A2A message parts.
- It POSTs JSON-RPC `tasks/send` to resolved base URL.
- It retries recoverable failures (`5xx`/network) with exponential backoff.
- Result is converted back to Forge response payload and enriched metadata (`a2aTaskId`, `a2aTaskState`).

5. A2A stream flow
- `A2AClientAdapter.stream()` calls `send()` first and yields that response.
- If task is not terminal (`completed`/`failed`/`canceled`), it calls `streamA2ATask()`.
- `streamA2ATask()` opens `/tasks/{taskId}/stream`, parses SSE frames, supports reconnection and `Last-Event-ID`, and emits Forge `stream_chunk`/`stream_end`/`error` messages.

6. Bridge flow
- `ProtocolBridge.bridge()` applies optional transform and forces `protocol` to target adapter protocol before forwarding.
- `start(pattern)` subscribes on source adapter and forwards source messages to target adapter.
- Static translators cover common conversions:
  - `mcpToA2A()` maps `tool_call` to `task`.
  - `a2aToMcp()` maps `task`/`text`/`json`/`error` to `tool_result`.

7. Serialization flow
- `JSONSerializer.serialize()` encodes envelope as UTF-8 JSON.
- `Uint8Array` values are encoded as `__uint8:<base64>` marker strings.
- `deserialize()` parses JSON, revives binary fields, validates against `ForgeMessageSchema`, and throws `SERIALIZATION_FAILED` on parse/validation errors.

## Key APIs and Types
Primary protocol exports (`src/protocol/index.ts`):

- Message types and schemas:
  - `ForgeMessage`, `ForgePayload`, `ForgeProtocol`, `ForgeMessageMetadata`, `ForgeMessageId`
  - `ForgeMessageSchema`, `ForgePayloadSchema`, `ForgeMessageMetadataSchema`, `ForgeMessageUriSchema`
- Factory helpers:
  - `createMessageId()`
  - `createForgeMessage()`
  - `createResponse()`
  - `createErrorResponse()`
  - `isMessageAlive()`
  - `validateForgeMessage()`
- Adapter contract:
  - `ProtocolAdapter`, `AdapterState`, `AdapterHealthStatus`, `SendOptions`, `MessageHandler`, `Subscription`
- Concrete adapters and router:
  - `InternalAdapter`, `extractAgentId`
  - `A2AClientAdapter`
  - `ProtocolRouter`
- Bridge:
  - `ProtocolBridge`
  - `ProtocolBridge.mcpToA2A()`
  - `ProtocolBridge.a2aToMcp()`
- A2A streaming/JSON-RPC:
  - `streamA2ATask()`
  - `parseSSEEvents()`
  - `JSON_RPC_ERRORS`, `A2A_ERRORS`
  - `createJsonRpcError()`, `createJsonRpcSuccess()`
  - `validateJsonRpcRequest()`, `validateJsonRpcBatch()`
- Serialization and push notifications:
  - `JSONSerializer`, `defaultSerializer`, `MessageSerializer`
  - `PushNotificationService` and related config/result/event types

## Dependencies
Direct protocol-module dependencies:

- External libraries/runtime:
  - `zod` (schema validation)
  - `node:crypto` (`randomUUID` for message IDs)
  - platform APIs: `fetch`, `Response`, `ReadableStream`, `AbortController`, `TextEncoder`, `TextDecoder`, `Buffer`
- Internal package modules:
  - `../events/agent-bus.js` (in-process transport)
  - `../errors/forge-error.js` and `../errors/error-codes.js` (error model)

Package-level context (`packages/core/package.json`):

- Runtime dependencies: `@dzupagent/agent-types`, `@dzupagent/runtime-contracts`
- Peer dependency used by this module: `zod`

## Integration Points
Inside `@dzupagent/core`:

- Root barrel (`src/index.ts`) re-exports the full protocol surface, including:
  - schemas, adapters, router, bridge
  - serialization APIs
  - A2A JSON-RPC helpers
  - push notification service
- Orchestration facade (`src/facades/orchestration.ts`) re-exports a curated subset:
  - includes message factories, `InternalAdapter`, `ProtocolRouter`, `A2AClientAdapter`, SSE helpers, and `ProtocolBridge`
  - does not export protocol schemas, serializer APIs, JSON-RPC helpers, or push notification APIs

Cross-module runtime seam:

- `InternalAdapter` depends on `AgentBus` publish/subscribe channel behavior.
- Protocol failures are normalized as `ForgeError` with protocol/routing/serialization codes.
- URI scheme flexibility in `ForgeMessageUriSchema` allows non-`forge://` transport routing (`a2a`, `mcp`, `http`, `https`, `ws`, `wss`, `grpc`).

## Testing and Observability
Protocol test coverage exists in:

- `protocol.test.ts`
- `adapters.test.ts`
- `bridge.test.ts`
- `serialization.test.ts`
- `a2a-sse.test.ts`
- `a2a-json-rpc.test.ts`
- `a2a-push-notification.test.ts`

Covered behaviors include:

- Envelope/payload/schema validation across payload variants.
- Message ID/factory/response/error helper behavior.
- Internal adapter request/response, stream, timeout, and URI parsing.
- Router scheme dispatch, fallback behavior, and error paths.
- A2A adapter connect/send/stream flows, retry/backoff, timeout, and abort handling.
- SSE parsing, event mapping, reconnection, and stream termination handling.
- Bridge translation and forwarding behavior.
- JSON serialization round-trips including binary payload handling.
- JSON-RPC request/batch validation and response factories.
- Push notification registration, filtering, retry, and delivery outcomes.

Observability in this module is lightweight:

- `health()` is exposed per adapter (`InternalAdapter` and `A2AClientAdapter`).
- No dedicated metrics emitter in protocol files; observability is primarily via health state and surfaced errors.

## Risks and TODOs
Current code-level risks or cleanup items:

- `ProtocolBridge.start()` implementation is one-way source subscription forwarding, while comments describe “bidirectional” bridging.
- `A2AClientAdapter` binary translation drops binary bytes (`binary` maps to `file` part with only `mimeType`).
- `A2AClientAdapter.connect()` builds URL from optional `baseUrl`; when omitted, it probes `/.well-known/agent.json` on an empty base path.
- `InternalAdapter.stream()` allocates timeout timers per wait cycle without explicit timer cleanup bookkeeping after resolve.
- `a2a-sse-stream.ts` defines `StreamEndSignal`, but the current stream reader returns directly on terminal events and does not throw this signal.
- `PushNotificationService` stores registrations in memory only; restarts drop task subscription state.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
