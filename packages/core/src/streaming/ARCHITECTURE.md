# Streaming Architecture (`packages/core/src/streaming`)

## Scope

This document covers the streaming normalization module in `packages/core/src/streaming`:

- `event-types.ts`
- `sse-transformer.ts`
- `index.ts`

It also covers how these exports are exposed from package entrypoints (`src/index.ts`, `src/facades/quick-start.ts`, `src/advanced.ts`) inside `@dzupagent/core`.

Out of scope:

- SSE transport parsing/reconnect behavior in `src/protocol/a2a-sse-stream.ts`
- HTTP response writing, SSE framing, and client reconnection policy in consuming packages/apps

## Responsibilities

The streaming module has a narrow role:

1. Define a package-level normalized event contract for stream output (`StandardSSEEvent`, `StandardEventType`).
2. Convert LangChain/LangGraph `StreamEvent` records into that contract with `SSETransformer`.
3. Allow event-specific custom mapping overrides through `addTransformer(eventName, transformer)`.

It does not open network streams, emit SSE wire frames, buffer async streams, or persist streaming state.

## Structure

| File | Purpose | Main Exports |
| --- | --- | --- |
| `src/streaming/event-types.ts` | Defines normalized stream event type union and payload interfaces. | `StandardEventType`, `StandardSSEEvent`, `FileStreamStartPayload`, `FileStreamChunkPayload`, `FileStreamEndPayload` |
| `src/streaming/sse-transformer.ts` | Implements mapping from `StreamEvent` to `StandardSSEEvent \| null`. | `SSETransformer`, `EventTransformer` |
| `src/streaming/index.ts` | Local barrel for streaming module consumers. | Re-exports all of the above |

## Runtime and Control Flow

At runtime, transformation is synchronous and stateless per event (except reading custom transformer registrations):

1. Caller invokes `SSETransformer.transform(event)`.
2. `transform()` first checks a `Map<string, EventTransformer>` for an exact `event.event` custom transformer.
3. If a custom transformer exists, its return value is used directly.
4. Otherwise, built-in switch mappings run for known LangGraph event names.
5. Unknown or non-actionable events return `null` (caller decides whether to drop or handle).

Built-in mapping behavior implemented today:

- `on_chat_model_stream` -> `type: 'message'` with `{ content }` when `event.data?.chunk?.content` is a non-empty string.
- `on_chat_model_end` -> `type: 'tool_call'` with `{ tools }` when `event.data?.output?.tool_calls` is a non-empty array.
- `on_tool_start` -> `type: 'progress'` with `{ status: 'running', tool }` where `tool` defaults to `'unknown'`.
- `on_tool_end` -> `type: 'tool_result'` with `{ content }` extracted from string output, `output.content`, or `JSON.stringify(output)` fallback.
- `on_chain_end` -> `type: 'phase_change'` with `{ phase }` when `event.name` exists and does not start with `__`.
- default -> `null`.

## Key APIs and Types

### `EventTransformer`

```ts
type EventTransformer = (event: StreamEvent) => StandardSSEEvent | null
```

Custom handlers are keyed by the `StreamEvent.event` string.

### `SSETransformer`

```ts
class SSETransformer {
  addTransformer(eventName: string, transformer: EventTransformer): this
  transform(event: StreamEvent): StandardSSEEvent | null
}
```

Behavioral details:

- `addTransformer()` mutates internal transformer registry and supports fluent chaining.
- Custom transformers take precedence over built-in mappings.
- `transform()` does not perform async work.

### `StandardSSEEvent`

```ts
interface StandardSSEEvent {
  type: StandardEventType | string
  data: Record<string, unknown>
}
```

`type` intentionally allows string extension beyond the built-in union.

### `StandardEventType`

Current declared union in `event-types.ts`:

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

Only a subset is currently emitted by built-in `SSETransformer` logic (`message`, `tool_call`, `tool_result`, `phase_change`, `progress`).

### File stream payload interfaces

`FileStreamStartPayload`, `FileStreamChunkPayload`, and `FileStreamEndPayload` are currently type contracts only in this module; `SSETransformer` does not emit them by default.

## Dependencies

Module-level direct dependencies:

- `sse-transformer.ts` uses `StreamEvent` from `@langchain/core/tracers/log_stream` (type import).
- `event-types.ts` and `index.ts` have no external runtime imports.

Package-level context (`packages/core/package.json`):

- `@langchain/core` is listed as peer dependency (`>=1.0.0`) and dev dependency.
- Build is handled by `tsup`.
- No dedicated `./streaming` subpath is exported from `@dzupagent/core`.

## Integration Points

Streaming module integration inside `@dzupagent/core`:

1. `src/index.ts` exports `SSETransformer` and streaming event types/payload types.
2. `src/facades/quick-start.ts` exports `SSETransformer` and type-only `StandardSSEEvent`.
3. `src/advanced.ts` re-exports root `src/index.ts`, so streaming exports are available via `@dzupagent/core/advanced` as well.
4. `src/stable.ts` re-exports facade namespaces from `src/facades/index.ts`; streaming is therefore reachable via `stable.quickStart.SSETransformer`.

Import implications for consumers:

- Available: `@dzupagent/core`, `@dzupagent/core/quick-start`, `@dzupagent/core/advanced`, and facade namespace path via `@dzupagent/core/stable`.
- Not available: `@dzupagent/core/streaming` subpath (not declared in package exports).

Adjacent SSE-related code that is separate from this module:

- `src/protocol/a2a-sse-stream.ts` parses raw SSE text and emits `ForgeMessage` stream events for A2A protocol clients.
- That protocol stream path does not use `SSETransformer` or `StandardSSEEvent`.

## Testing and Observability

Current test posture in `packages/core`:

- No dedicated unit tests for `src/streaming/sse-transformer.ts` mapping branches or custom-transform precedence.
- Streaming surface is covered indirectly through facade/export smoke tests:
  - `src/__tests__/facades.test.ts`
  - `src/__tests__/facade-quick-start.test.ts`
  - `src/__tests__/w15-b1-facades.test.ts`

Coverage config context:

- `vitest.config.ts` includes `src/**/*.ts` in coverage, excluding tests and barrel `index.ts` files.
- Streaming branch behavior therefore depends on direct test additions rather than barrel import tests.

Observability:

- `SSETransformer` emits no logs, metrics, or traces.
- Any instrumentation must be added by callers around `transform()` or at transport/protocol layers.

## Risks and TODOs

1. Upstream shape drift risk: mapping relies on loosely typed nested fields (`event.data.chunk`, `event.data.output.tool_calls`), so upstream provider/runtime changes can silently drop events (`null` output).
2. `on_tool_end` fallback can produce `undefined` content when output is `undefined` (`JSON.stringify(undefined)`), which may break consumers expecting a string.
3. Contract mismatch risk: `StandardEventType` includes types not emitted by built-in transformer paths (`done`, `error`, `parallel_*`, `file_stream_*`).
4. Test gap: no focused tests for transformation rules, null-skip conditions, and custom-transform override precedence.
5. API discoverability gap: no `@dzupagent/core/streaming` subpath export.

## Changelog

- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-16: automated refresh via scripts/refresh-architecture-docs.js

