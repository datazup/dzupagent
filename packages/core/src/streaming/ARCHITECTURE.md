# Streaming Architecture (`packages/core/src/streaming`)

Last updated: 2026-04-03

## Scope

This document covers the streaming normalization module in `@dzupagent/core`:

- `packages/core/src/streaming/sse-transformer.ts`
- `packages/core/src/streaming/event-types.ts`
- `packages/core/src/streaming/index.ts`

It also maps:

- package export surfaces that expose this module
- references/usages in other packages
- test coverage status for this module and adjacent streaming layers

## Design Intent

`packages/core/src/streaming` is a small compatibility layer that converts LangGraph `StreamEvent` objects into a simple, UI-friendly SSE payload contract.

Core goals:

1. Normalize provider/framework-specific events into stable event shapes.
2. Keep frontend and transport layers independent from LangGraph internals.
3. Allow consumers to override built-in mappings with custom transformers.

## Module Map

| File | Responsibility | Key Exports |
| --- | --- | --- |
| `event-types.ts` | Defines normalized event type union and payload interfaces | `StandardEventType`, `StandardSSEEvent`, `FileStreamStartPayload`, `FileStreamChunkPayload`, `FileStreamEndPayload` |
| `sse-transformer.ts` | Maps LangGraph `StreamEvent` -> `StandardSSEEvent \| null` with custom override support | `SSETransformer`, `EventTransformer` |
| `index.ts` | Folder barrel | Re-exports all streaming types + `SSETransformer` |

## Public Contract

### `StandardEventType`

Current built-in event union:

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

### `StandardSSEEvent`

Canonical normalized envelope:

```ts
interface StandardSSEEvent {
  type: StandardEventType | string
  data: Record<string, unknown>
}
```

Notes:

1. `type` allows `string`, so consumers can safely emit custom event names.
2. `data` is intentionally generic to avoid hard coupling to one runtime shape.

### File stream payload types

`event-types.ts` includes payload interfaces for incremental file content transport:

- `FileStreamStartPayload`
- `FileStreamChunkPayload`
- `FileStreamEndPayload`

These are part of the public typing contract but are not emitted by built-in `SSETransformer` rules.

## `SSETransformer` Behavior

### Custom transformer precedence

`SSETransformer.addTransformer(eventName, fn)` registers an exact-match override by `event.event`.

Flow:

```text
transform(event)
  -> if custom transformer exists for event.event: use it
  -> else apply built-in switch mapping
  -> return StandardSSEEvent or null (skip)
```

### Built-in event mappings

| LangGraph `event.event` | Output `type` | Output shape | Skip conditions |
| --- | --- | --- | --- |
| `on_chat_model_stream` | `message` | `{ content }` from `event.data.chunk.content` | non-string or empty `content` |
| `on_chat_model_end` | `tool_call` | `{ tools: [{ name, args }] }` from `event.data.output.tool_calls` | no tool calls present |
| `on_tool_start` | `progress` | `{ status: 'running', tool: event.name ?? 'unknown' }` | none |
| `on_tool_end` | `tool_result` | `{ content }` from string output, `output.content`, or `JSON.stringify(output)` | none |
| `on_chain_end` | `phase_change` | `{ phase: event.name }` | missing `name` or internal name starting with `__` |
| default | `null` | n/a | all unsupported events |

## End-to-End Runtime Flow

Typical usage path:

```text
LangGraph stream emits StreamEvent
  -> SSETransformer.transform(event)
    -> StandardSSEEvent or null
  -> transport layer serializes as SSE frame
  -> client consumes stable { type, data } payloads
```

Transport formatting (`data: <json>\n\n`) is outside this module.

## Usage Examples

### 1) Basic normalization loop

```ts
import { SSETransformer } from '@dzupagent/core'
import type { StreamEvent } from '@langchain/core/tracers/log_stream'

const transformer = new SSETransformer()

for await (const event of stream as AsyncIterable<StreamEvent>) {
  const normalized = transformer.transform(event)
  if (!normalized) continue

  // Write to SSE transport
  res.write(`event: ${normalized.type}\n`)
  res.write(`data: ${JSON.stringify(normalized.data)}\n\n`)
}
```

### 2) Custom event override

```ts
import { SSETransformer } from '@dzupagent/core'

const transformer = new SSETransformer()
  .addTransformer('on_chain_start', (event) => ({
    type: 'phase_change',
    data: { phase: event.name ?? 'unknown', status: 'started' },
  }))
```

Because custom rules run first, this can replace or extend built-in behavior for specific event names.

### 3) Emitting file-stream event types

```ts
import type { StandardSSEEvent, FileStreamChunkPayload } from '@dzupagent/core'

const payload: FileStreamChunkPayload = {
  filePath: 'src/service.ts',
  chunk: 'export function run() {}',
  chunkIndex: 0,
}

const evt: StandardSSEEvent = {
  type: 'file_stream_chunk',
  data: payload as unknown as Record<string, unknown>,
}
```

## Export Surfaces

This module is exposed through:

1. Root package export (`@dzupagent/core`) via `packages/core/src/index.ts`.
2. Quick-start facade (`@dzupagent/core/quick-start`) via `packages/core/src/facades/quick-start.ts`.
3. Local folder barrel (`packages/core/src/streaming/index.ts`) for internal imports.

There is currently no dedicated package subpath export like `@dzupagent/core/streaming` in `packages/core/package.json`.

## Cross-Package References and Usage

### Direct references to core streaming types/classes

Static search (`rg`) shows direct references to `SSETransformer` / `StandardSSEEvent` only in `@dzupagent/core` source/docs:

- `packages/core/src/index.ts`
- `packages/core/src/facades/quick-start.ts`
- `packages/core/src/__tests__/facades.test.ts`
- `packages/core/README.md`
- local streaming files

No direct imports from non-core packages were found for:

- `SSETransformer`
- `StandardSSEEvent`
- `StandardEventType`
- file-stream payload interfaces

### Semantically related streaming implementations

Even without direct import reuse, other packages implement compatible streaming layers with similar event vocabularies.

### `@dzupagent/agent-adapters`

1. `src/streaming/streaming-handler.ts`
   - Maps adapter events into `tool_call`, `tool_result`, `progress`, `done`, `error`.
   - Serializes to SSE/JSONL/NDJSON.
2. `src/http/adapter-http-handler.ts`
   - Wraps adapter events in SSE via `StreamingHandler` and returns `text/event-stream`.

This is the closest functional neighbor to `SSETransformer` in the monorepo.

### `@dzupagent/agent`

`src/agent/dzip-agent.ts` emits streaming events (`text`, `tool_call`, `tool_result`, `error`, `done`) that can be adapted into SSE contracts by downstream layers.

### `@dzupagent/server`

1. `src/routes/events.ts` streams event-gateway envelopes over SSE.
2. `src/routes/runs.ts` streams run-scoped events over SSE (`init`, event-type frames, terminal `done`).

### Core protocol SSE (adjacent but separate concern)

`packages/core/src/protocol/a2a-sse-stream.ts` is an SSE transport parser/client for A2A protocol streams. It does not consume `SSETransformer`, but it validates and operationalizes SSE framing in another core subsystem.

## Test Coverage Status

### Direct coverage for `packages/core/src/streaming`

Current status:

1. No dedicated unit tests for:
   - `sse-transformer.ts` built-in mappings
   - custom transformer precedence/override
   - `event-types.ts` typing contract behavior via compile-time tests
2. Existing direct test signal is only export smoke coverage:
   - `packages/core/src/__tests__/facades.test.ts` checks `quick-start` exports include `SSETransformer`.

Targeted runs executed on 2026-04-03:

- `yarn workspace @dzupagent/core test src/__tests__/facades.test.ts` -> pass (31 tests)
- `yarn workspace @dzupagent/core test src/__tests__/facades.test.ts --coverage` -> tests pass, command fails global thresholds (expected for a single-file run)

From that focused coverage run:

- `src/streaming/sse-transformer.ts` lines covered: `16.48%`
- Branch/function coverage for this file: `0%`

Interpretation: module behavior is effectively untested today.

### Adjacent streaming-layer test coverage (outside this module)

Validated on 2026-04-03:

1. `yarn workspace @dzupagent/core test src/protocol/__tests__/a2a-sse.test.ts`
   - pass (21 tests)
   - covers SSE parsing, reconnection, status/event conversion for A2A protocol.
2. `yarn workspace @dzupagent/agent-adapters test src/__tests__/streaming-handler.test.ts`
   - pass (22 tests)
   - covers event mapping, progress tracking, SSE/JSONL/NDJSON formatting, readable stream output.
3. `yarn workspace @dzupagent/agent-adapters test src/__tests__/adapter-http-handler.test.ts`
   - pass (44 tests)
   - includes streaming endpoint behavior and SSE response handling.
4. `yarn workspace @dzupagent/server test src/__tests__/event-gateway.test.ts`
   - pass (4 tests)
   - covers filtered event fan-out used by server-side SSE routes.

These tests improve confidence in the ecosystem streaming path, but they do not replace direct tests for `SSETransformer`.

## Current Gaps and Recommendations

### Gaps

1. `SSETransformer` mapping logic lacks behavior tests.
2. `on_tool_end` can emit non-string `content` fallback (`JSON.stringify(undefined)` path).
3. File-stream event payload interfaces exist but no default emitter path in transformer.
4. No explicit contract tests asserting event schema compatibility between:
   - `core` streaming normalization
   - `agent-adapters` streaming handler
   - `server` SSE transport routes

### Recommended additions

1. Add `packages/core/src/streaming/__tests__/sse-transformer.test.ts`:
   - one test per built-in mapping
   - custom transformer precedence test
   - skip/null behavior tests
2. Add contract tests for shared event names and payload expectations across packages.
3. Decide whether `file_stream_*` should be:
   - emitted by built-in transformer rules, or
   - documented as extension-only types.
4. Consider adding `@dzupagent/core/streaming` subpath export for explicit consumer discoverability.
