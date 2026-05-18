# Streaming Architecture (`packages/core/src/streaming`)

## Scope
This document covers the streaming normalization module in `@dzupagent/core` under `packages/core/src/streaming`:

- `event-types.ts`
- `sse-transformer.ts`
- `index.ts`

It also documents how these streaming exports are surfaced through package entrypoints inside `packages/core/src`.

Out of scope:

- SSE transport parsing/reconnect logic in `src/protocol/a2a-sse-stream*`
- HTTP/EventSource delivery mechanics in consuming servers/apps
- Provider-specific streaming semantics beyond the `StreamEvent` fields consumed here

## Responsibilities
`src/streaming` is a narrow translation layer from LangChain/LangGraph stream events into a package-level SSE event contract.

Implemented responsibilities:

- Define normalized event and payload types (`StandardSSEEvent`, `StandardEventType`, file-stream payload interfaces)
- Transform selected `StreamEvent` variants into `StandardSSEEvent` objects
- Allow caller-registered event-specific overrides via `addTransformer`

Not implemented in this module:

- Stream iteration
- Buffering/chunk accumulation
- Network I/O
- Retry/reconnect
- Persistence
- Built-in metrics/logging/tracing

## Structure
| File | Role | Main Exports |
| --- | --- | --- |
| `src/streaming/event-types.ts` | Declares shared SSE event/type contracts | `StandardEventType`, `StandardSSEEvent`, `FileStreamStartPayload`, `FileStreamChunkPayload`, `FileStreamEndPayload` |
| `src/streaming/sse-transformer.ts` | Converts `StreamEvent` into normalized events (or drops them) | `SSETransformer`, `EventTransformer` |
| `src/streaming/index.ts` | Barrel re-export for the streaming module | Re-exports all types + transformer |

## Runtime and Control Flow
`SSETransformer.transform(event)` is synchronous and stateless (except the custom transformer registry map).

Execution order:

1. Read `event.event`.
2. Check `customTransformers` for an exact event-name match.
3. If a custom transformer exists, return its result immediately.
4. Otherwise apply built-in `switch` handling.
5. Return `StandardSSEEvent` or `null` (skip/drop).

Built-in mappings:

- `on_chat_model_stream`
- Reads `event.data?.chunk?.content`; emits `{ type: 'message', data: { content } }` only when content is a non-empty string.

- `on_chat_model_end`
- Reads `event.data?.output?.tool_calls`; when it is a non-empty array, emits `{ type: 'tool_call', data: { tools: [{ name, args }] } }`.

- `on_tool_start`
- Emits `{ type: 'progress', data: { status: 'running', tool } }` with `tool = event.name ?? 'unknown'`.

- `on_tool_end`
- Reads `event.data?.output` and derives `content` as:
  1. raw string output,
  2. `output.content` when that property is a string,
  3. fallback `JSON.stringify(output)`.
- Emits `{ type: 'tool_result', data: { content } }`.

- `on_chain_end`
- Emits `{ type: 'phase_change', data: { phase: event.name } }` when `event.name` exists and does not start with `__`.

- default
- Returns `null`.

## Key APIs and Types
### `EventTransformer`

```ts
type EventTransformer = (event: StreamEvent) => StandardSSEEvent | null
```

### `SSETransformer`

```ts
class SSETransformer {
  addTransformer(eventName: string, transformer: EventTransformer): this
  transform(event: StreamEvent): StandardSSEEvent | null
}
```

Behavioral notes:

- `addTransformer` mutates an internal `Map<string, EventTransformer>` and supports chaining.
- Custom transformers always win over built-in mapping for the same event key.
- Returning `null` means "ignore this event".

### `StandardSSEEvent`

```ts
interface StandardSSEEvent {
  type: StandardEventType | string
  data: Record<string, unknown>
}
```

`type` intentionally allows both known union members and custom string values.

### `StandardEventType`
Current union members in code:

- `message`
- `tool_call`
- `tool_result`
- `phase_change`
- `progress`
- `done`
- `error`
- `parallel_candidate`
- `parallel_complete`
- `file_stream_start`
- `file_stream_chunk`
- `file_stream_end`

Built-in transformer branches currently emit only:

- `message`
- `tool_call`
- `tool_result`
- `phase_change`
- `progress`

### File-stream payload interfaces
`FileStreamStartPayload`, `FileStreamChunkPayload`, and `FileStreamEndPayload` are declared contracts in `event-types.ts`. No built-in branch in `SSETransformer` emits those event types.

## Dependencies
Module-level dependencies in `src/streaming`:

- `sse-transformer.ts` imports `StreamEvent` from `@langchain/core/tracers/log_stream` (type usage)
- `event-types.ts` has no imports
- `index.ts` only re-exports local symbols

Package-level dependency context (`packages/core/package.json`):

- `@langchain/core` is declared as a peer dependency (`>=1.0.0`) and dev dependency
- Streaming has no dedicated package export path (`./streaming` is not in `exports`)

## Integration Points
Streaming symbols are exposed through these entrypoints:

- Root: `src/index.ts` (`@dzupagent/core`) exports `SSETransformer` and all streaming event types/payload interfaces.
- LLM tier: `src/llm.ts` (`@dzupagent/core/llm`) exports the same streaming symbols.
- Quick-start facade: `src/facades/quick-start.ts` (`@dzupagent/core/quick-start`) exports `SSETransformer` and `StandardSSEEvent` only.

Additional packaging behavior:

- `src/advanced.ts` re-exports `src/index.ts`, so streaming is also available through `@dzupagent/core/advanced`.
- `src/stable.ts` re-exports `src/facades/index.ts`; streaming is reachable there via `quickStart.SSETransformer`.

Within `packages/core/src`, there is no internal runtime consumer creating or invoking `SSETransformer`; this module is currently a reusable utility surface for downstream callers.

## Testing and Observability
Current direct test coverage:

- No dedicated unit test file exercises `src/streaming/sse-transformer.ts` branch behavior.
- Facade/export smoke coverage exists and verifies symbol availability, including `SSETransformer` on quick-start/facade entrypoints (for example `src/__tests__/facades.test.ts`, `src/__tests__/facade-quick-start.test.ts`, `src/__tests__/w15-b1-facades.test.ts`).

Coverage configuration (`vitest.config.ts`):

- Includes `src/**/*.ts`
- Excludes `src/**/index.ts` barrels and test files
- Uses V8 coverage provider

Observability characteristics:

- `SSETransformer` does not emit logs, traces, or metrics.
- Monitoring must be implemented by surrounding stream loop/transport layers that call `transform()`.

## Risks and TODOs
- Event-shape drift risk: built-in branches rely on loosely shaped nested payload fields (`event.data.chunk`, `event.data.output`, `tool_calls`).
- `on_tool_end` fallback ambiguity: `JSON.stringify(output)` can return `undefined` or JSON text that may not match downstream UI expectations.
- Contract/runtime drift: `StandardEventType` includes union members not produced by built-in branches (`done`, `error`, `parallel_*`, `file_stream_*`).
- Validation gap: no direct tests currently verify custom-transformer precedence, null-drop semantics, or each built-in mapping branch.
- Discoverability constraint: consumers cannot import `@dzupagent/core/streaming` directly because no subpath export exists.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js