# Protocol Architecture (`@dzupagent/core`)

## Scope
This document covers the implementation under `packages/core/src/protocol` in `@dzupagent/core`, plus immediate package/export context that determines how this module is consumed.

Included implementation files:
- `message-types.ts`
- `message-schemas.ts`
- `message-factory.ts`
- `adapter.ts`
- `internal-adapter.ts`
- `protocol-router.ts`
- `protocol-bridge.ts`
- `serialization.ts`
- `a2a-client-adapter.ts`
- `a2a-json-rpc.ts`
- `a2a-push-notification.ts`
- `a2a-sse-stream-types.ts`
- `a2a-sse-stream-parser.ts`
- `a2a-sse-stream-client.ts`
- `a2a-sse-stream-reconnect.ts`
- `a2a-sse-stream.ts`
- `index.ts`
- `__tests__/*.test.ts` in this directory

Checked integration context for this refresh:
- `packages/core/package.json`
- `packages/core/README.md`
- `packages/core/src/index.ts`
- `packages/core/src/facades/orchestration.ts`
- `packages/core/src/identity.ts`

## Responsibilities
The protocol module provides transport-neutral message contracts and transport adapters for inter-agent communication.

Implemented responsibilities:
- Define the core message envelope (`ForgeMessage`) and payload union (`ForgePayload`) in `message-types.ts`.
- Enforce runtime shape validation using Zod (`ForgeMessageSchema`, `ForgePayloadSchema`, `ForgeMessageUriSchema`) in `message-schemas.ts`.
- Create and correlate messages (`createForgeMessage`, `createResponse`, `createErrorResponse`), generate IDs (`createMessageId`), and perform non-throwing validation (`validateForgeMessage`) in `message-factory.ts`.
- Define a protocol adapter contract (`ProtocolAdapter`) with lifecycle, request/response, streaming, subscription, and health APIs in `adapter.ts`.
- Implement in-process transport over `AgentBus` (`InternalAdapter`) with correlation channels for responses and streams in `internal-adapter.ts`.
- Implement remote A2A HTTP JSON-RPC transport (`A2AClientAdapter`) with retry/backoff, timeout/abort handling, and optional SSE task streaming in `a2a-client-adapter.ts`.
- Route by destination URI scheme via adapter registry and optional fallback adapter in `protocol-router.ts`.
- Bridge across protocol adapters, with optional transform and built-in MCP<->A2A payload translators, in `protocol-bridge.ts`.
- Serialize/deserialize envelopes to bytes with binary payload support using base64 marker conversion in `serialization.ts`.
- Provide A2A helper utilities:
  - JSON-RPC constants, response builders, and request/batch validators (`a2a-json-rpc.ts`).
  - SSE parsing and A2A event-to-ForgeMessage mapping (`a2a-sse-stream-parser.ts`).
  - SSE stream lifecycle + reconnect behavior (`a2a-sse-stream-client.ts`, `a2a-sse-stream-reconnect.ts`).
  - Push notification registration/delivery with one retry (`a2a-push-notification.ts`).

## Structure
Directory-level organization:
- Envelope model and validation:
  - `message-types.ts`
  - `message-schemas.ts`
  - `message-factory.ts`
- Adapter contract and transports:
  - `adapter.ts`
  - `internal-adapter.ts`
  - `a2a-client-adapter.ts`
- Routing and protocol translation:
  - `protocol-router.ts`
  - `protocol-bridge.ts`
- A2A protocol utilities:
  - `a2a-json-rpc.ts`
  - `a2a-push-notification.ts`
- A2A SSE client split by concern:
  - `a2a-sse-stream-types.ts`
  - `a2a-sse-stream-parser.ts`
  - `a2a-sse-stream-client.ts`
  - `a2a-sse-stream-reconnect.ts`
  - `a2a-sse-stream.ts` (barrel)
- Serialization:
  - `serialization.ts`
- Public module barrel:
  - `index.ts`
- Tests:
  - `__tests__/protocol.test.ts`
  - `__tests__/serialization.test.ts`
  - `__tests__/adapters.test.ts`
  - `__tests__/bridge.test.ts`
  - `__tests__/a2a-sse.test.ts`
  - `__tests__/a2a-json-rpc.test.ts`
  - `__tests__/a2a-push-notification.test.ts`

## Runtime and Control Flow
Common request/response flow:
1. Caller creates a message (`createForgeMessage`) or receives one from adapter input.
2. `ProtocolRouter` resolves adapter from `message.to` URI scheme.
3. Adapter executes `send` or `stream`.
4. Result is optionally validated by `validateForgeMessage` or `ForgeMessageSchema` at boundaries.

Internal adapter (`InternalAdapter`) flow:
1. `extractAgentId(message.to)` derives channel name and strips optional `@version` suffix.
2. `send` subscribes to `__response:<message.id>` then publishes envelope to target channel.
3. Receiver publishes response to provided `responseChannel`; sender resolves promise.
4. Timeout or abort produces `ForgeError` (`PROTOCOL_TIMEOUT` or `PROTOCOL_SEND_FAILED`).
5. `stream` uses `__stream:<message.id>` and yields messages until `stream_end`.

A2A adapter (`A2AClientAdapter`) flow:
1. Base URL is resolved from config or target URI (`a2a://...` becomes `https://...`).
2. Outgoing payload is mapped to A2A parts (`text`, `data`, or `file`) and posted as JSON-RPC `tasks/send`.
3. Failures are retried for recoverable conditions (network/5xx) with exponential backoff.
4. A2A task result is converted back to Forge payload and returned as `response` with metadata:
   - `a2aTaskId`
   - `a2aTaskState`
5. `stream` first yields `send` result, then opens `GET /tasks/{taskId}/stream` when task is non-terminal.

A2A SSE flow (`streamA2ATask`):
1. Connect to SSE endpoint with optional `Last-Event-ID`.
2. Read stream chunks and parse event frames (`parseSSEEvents`).
3. Convert A2A updates into Forge stream messages:
   - status working/submitted/input-required/canceled -> `stream_chunk`
   - status completed -> `stream_end`
   - status failed -> `error`
   - artifact updates -> `stream_chunk` JSON payload
4. Reconnect on dropped connections up to configured limit.

Bridge flow (`ProtocolBridge`):
1. Optional transform is applied (`transform(message, direction)`).
2. Bridge rewrites `message.protocol` to target adapter protocol.
3. Message is sent through target adapter.
4. `start(pattern)` subscribes on source adapter and forwards each inbound message similarly.

Serialization flow (`JSONSerializer`):
1. `serialize` JSON-stringifies envelope using replacer that converts `Uint8Array` to `__uint8:<base64>`.
2. `deserialize` parses JSON with reviver that restores `Uint8Array`.
3. Parsed object is validated by `ForgeMessageSchema`.
4. Parse or validation failures throw `ForgeError` with `SERIALIZATION_FAILED`.

## Key APIs and Types
Envelope and payload:
- `ForgeMessageId`
- `ForgeMessageType`
- `ForgeProtocol`
- `MessagePriority`
- `MessageBudget`
- `ForgeMessageMetadata`
- `ForgePayload`
- `ForgeMessage`

Schemas:
- `ForgeMessageUriSchema`
- `ForgeMessageMetadataSchema`
- `ForgePayloadSchema`
- `ForgeMessageSchema`

Factory and validation:
- `createMessageId()`
- `createForgeMessage(params)`
- `createResponse(original, payload, metadata?)`
- `createErrorResponse(original, code, message, details?)`
- `isMessageAlive(message)`
- `validateForgeMessage(data)`
- `CreateMessageParams`
- `ValidationResult`

Adapter abstraction and transport implementations:
- `ProtocolAdapter`
- `AdapterState`
- `AdapterHealthStatus`
- `SendOptions`
- `MessageHandler`
- `Subscription`
- `InternalAdapter`
- `extractAgentId(uri)`
- `InternalAdapterConfig`
- `A2AClientAdapter`
- `A2AClientConfig`

Routing and bridging:
- `ProtocolRouter`
- `ProtocolRouterConfig`
- `ProtocolBridge`
- `ProtocolBridgeConfig`
- `BridgeDirection`
- `ProtocolBridge.mcpToA2A(message)`
- `ProtocolBridge.a2aToMcp(message)`

A2A SSE and JSON-RPC helpers:
- `streamA2ATask(endpoint, taskId, config?)`
- `parseSSEEvents(text)`
- `A2ASSEConfig`
- `SSEEvent`
- `JSON_RPC_ERRORS`
- `A2A_ERRORS`
- `createJsonRpcError(...)`
- `createJsonRpcSuccess(...)`
- `validateJsonRpcRequest(...)`
- `validateJsonRpcBatch(...)`
- `JsonRpcRequest`
- `JsonRpcSuccessResponse`
- `JsonRpcErrorObject`
- `JsonRpcErrorResponse`
- `JsonRpcResponse`
- `JsonRpcValidationResult`
- `JsonRpcBatchValidationResult`

Push notifications:
- `PushNotificationService`
- `PushNotificationEvent`
- `PushNotificationConfig`
- `PushNotification`
- `PushNotificationResult`
- `PushNotificationServiceConfig`

Serialization:
- `MessageSerializer`
- `JSONSerializer`
- `defaultSerializer`

## Dependencies
Direct dependencies used in this module:
- `zod` for runtime schema validation.
- `node:crypto` (`randomUUID`) for message ID generation.
- Runtime platform APIs: `fetch`, `AbortController`, `TextEncoder`, `TextDecoder`, `ReadableStream`.
- `Buffer` (when available) for Node base64 conversion; `atob`/`btoa` fallback for non-Buffer environments.

Internal package dependencies:
- `../errors/forge-error.js`
- `../errors/error-codes.js`
- `../events/agent-bus.js`

Package dependency context (`packages/core/package.json`):
- `@dzupagent/core` does not expose a dedicated `./protocol` subpath export.
- Protocol APIs are reachable through:
  - root `@dzupagent/core` (via `src/index.ts` re-exports)
  - `@dzupagent/core/orchestration`
  - `@dzupagent/core/identity`

## Integration Points
Internal integration seams:
- `InternalAdapter` depends on `AgentBus` channel conventions:
  - response channel: `__response:<message.id>`
  - stream channel: `__stream:<message.id>`
  - wrapped payload marker: `__forgeMessage`
- `ProtocolRouter` is the adapter selection seam for URI scheme-based transport dispatch.
- `ProtocolBridge` is the cross-protocol seam for forwarding and payload translation.

Entry-point integration:
- `src/index.ts` re-exports protocol module symbols in root package API.
- `src/facades/orchestration.ts` re-exports selected protocol APIs for orchestration-focused consumers.
- `src/identity.ts` re-exports a larger protocol surface (including JSON-RPC, push notifications, serializer types) alongside identity APIs.

Cross-boundary behavior that callers need to account for:
- Message URI schema currently accepts `forge|a2a|mcp|http|https|ws|wss|grpc` schemes.
- `createForgeMessage` defaults protocol to `'internal'` when omitted.
- `A2AClientAdapter.subscribe` is intentionally no-op (request-driven client model).
- Push notification registrations are in-memory and process-local.

## Testing and Observability
Protocol-focused tests under `src/protocol/__tests__` cover:
- Envelope creation, schema validation, TTL checks, and strict top-level object behavior.
- JSON serialization round-trips for all payload variants including binary data.
- Internal adapter behavior (`send`, timeout, subscription, stream), router registration/dispatch/fallback, and A2A adapter behavior (connect/send/retry/timeout/abort/URL resolution).
- Protocol bridge translation and forwarding lifecycle (`bridge`, `start`, `stop`).
- SSE parsing and streaming behavior including reconnect, multi-chunk parsing, completion/failure mapping, and adapter stream integration.
- JSON-RPC request/batch validation and constant error codes.
- Push notification registration, filtering, delivery, and retry behavior.

Additional package-level tests also touch protocol branches (for example `src/__tests__/w15-h2-branch-coverage.test.ts`).

Observability surfaces in this module:
- `ProtocolAdapter.health()` provides adapter state snapshots.
- Error paths consistently use `ForgeError` with protocol-oriented error codes such as:
  - `MESSAGE_ROUTING_FAILED`
  - `PROTOCOL_CONNECTION_FAILED`
  - `PROTOCOL_SEND_FAILED`
  - `PROTOCOL_TIMEOUT`
  - `SERIALIZATION_FAILED`
- No dedicated metrics emitter is implemented inside `src/protocol`; telemetry is currently state + error based.

## Risks and TODOs
- `InternalAdapter.stream()` sets timeout timers per wait cycle but does not clear the timer on successful wake-up, which can accumulate unnecessary timers during long streams.
- `A2AClientAdapter` maps `binary` payloads to `{ type: 'file', mimeType }` without carrying binary bytes.
- `ProtocolBridge` static MCP<->A2A translators intentionally implement minimal mapping; richer semantics require explicit extension.
- Public protocol symbols are re-exported from multiple entrypoints (`src/index.ts`, `src/facades/orchestration.ts`, `src/identity.ts`), which increases API drift risk.
- `A2AClientAdapter.connect()` only checks `/.well-known/agent.json` reachability; it does not validate downstream `tasks/send`/SSE endpoint compatibility.
- `PushNotificationService` stores task registrations in-memory only; no built-in durability or multi-instance coordination exists.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

