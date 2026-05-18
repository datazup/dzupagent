# Streaming Architecture (`packages/agent/src/streaming`)

## Scope
This document covers the streaming helper module implemented in `packages/agent/src/streaming`:

- `stream-action-parser.ts`
- `streaming-types.ts`
- `streaming-run-handle.ts`
- `text-delta-buffer.ts`
- `index.ts`

It does not describe the main `DzupAgent.stream()` runtime loop in `packages/agent/src/agent/streaming-run*.ts`, which emits `AgentStreamEvent` and uses separate stream orchestration/tool-dispatch helpers.

## Responsibilities
The streaming folder provides reusable primitives, not the primary runtime stream coordinator:

- Parse partial and complete tool-call payloads from chunked model output and execute tools incrementally (`StreamActionParser`).
- Provide a bounded async-iterable event queue for producer/consumer stream handoff (`StreamingRunHandle`).
- Normalize and type the local stream event union (`StreamEvent` and related interfaces).
- Buffer token deltas into whitespace-bounded text chunks (`TextDeltaBuffer`).
- Re-export these symbols via a local barrel (`streaming/index.ts`).

## Structure
| File | Exports | Notes |
| --- | --- | --- |
| `stream-action-parser.ts` | `StreamActionParser`, `StreamedToolCall`, `StreamActionEvent`, `StreamActionParserConfig` | Parses `content`, `tool_call_chunks`, and `tool_calls`; executes matching tools. |
| `streaming-types.ts` | `StreamEvent`, `TextDeltaEvent`, `ToolCallStartEvent`, `ToolCallEndEvent`, `DoneEvent`, `ErrorEvent` | Local discriminated union for stream transport/consumption. |
| `streaming-run-handle.ts` | `StreamingRunHandle`, `StreamingStatus`, `StreamingRunHandleOptions` | In-memory async iterator bridge with bounded buffer and terminal states. |
| `text-delta-buffer.ts` | `TextDeltaBuffer` | Emits complete whitespace-delimited chunks while retaining trailing partial text. |
| `index.ts` | Barrel re-exports | Convenience exports for this folder. |

Package-level exposure:

- `packages/agent/src/index.ts` re-exports all streaming symbols directly from these files.
- `packages/agent/package.json` exports only top-level entrypoints (`"."`, `"./agent"`, etc.); streaming APIs are consumed from `@dzupagent/agent` top-level exports, not a dedicated `./streaming` subpath.

## Runtime and Control Flow
### `StreamActionParser`
`processChunk()` runs three phases per chunk:

1. Extract text from `chunk.content` (`string` or multimodal array with `type: 'text'`).
2. Accumulate `tool_call_chunks` by `id` (fallback to `index`) into an internal pending map.
3. Execute any parseable object JSON args (`{...}`) immediately and emit ordered events.

Execution behavior:

- Each tool call emits `tool_call_start` then `tool_call_complete`, then either `tool_result` or `error`.
- Unknown tools emit `error` (`Tool "<name>" not found`).
- Sequential mode (`parallelExecution: false`) awaits each tool inline.
- Parallel mode tracks in-flight executions (`active` set), enforces `maxParallelTools`, and may return a completed prior result when saturation forces `Promise.race`.

`flush()`:

1. Re-checks pending chunk-assembled tool calls that were not fired yet.
2. Drains any in-flight parallel executions with `Promise.allSettled`.

### `StreamingRunHandle`
Producer/consumer queue flow:

1. Producer calls `push(event)` while status is `running`.
2. If a consumer is waiting, event resolves immediately.
3. Otherwise event is enqueued up to `maxBufferSize` (default `1000`); overflow is dropped.
4. Consumer iterates `for await (const event of handle.events())`.
5. Terminal calls (`complete`, `fail`, `cancel`) stop new pushes and eventually end iteration after buffered events are drained.

Failure path:

- `fail(error)` enqueues/delivers an `error` `StreamEvent` before transitioning to `failed`.

### `TextDeltaBuffer`
Text buffering flow:

1. `push(delta)` appends incoming text.
2. Finds the last whitespace boundary (`space`, `\n`, `\t`, `\r`).
3. Emits complete chunks matched by `/\S+\s*/g`.
4. Keeps trailing partial token in the internal buffer.
5. `flush()` returns leftover content and clears state; `reset()` clears without returning.

## Key APIs and Types
### Parser Surface (`stream-action-parser.ts`)
- `new StreamActionParser(tools, config?)`
- `processChunk(chunk): Promise<StreamActionEvent[]>`
- `flush(): Promise<StreamActionEvent[]>`

Relevant types:

- `StreamedToolCall`: `{ id, name, args }`
- `StreamActionEvent`:
  - `type`: `'text' | 'tool_call_start' | 'tool_call_complete' | 'tool_result' | 'error'`
  - `data`: `{ content?, toolCall?, result?, error? }`
- `StreamActionParserConfig`:
  - `parallelExecution?: boolean`
  - `maxParallelTools?: number`

### Run Handle Surface (`streaming-run-handle.ts`)
- `status: 'running' | 'completed' | 'failed' | 'cancelled'`
- `push(event: StreamEvent): void`
- `complete(): void`
- `fail(error: Error): void`
- `cancel(): void`
- `events(): AsyncIterable<StreamEvent>`

### Event Contract (`streaming-types.ts`)
`StreamEvent` is a union of:

- `TextDeltaEvent` (`type: 'text_delta'`, `content`)
- `ToolCallStartEvent` (`type: 'tool_call_start'`, `toolName`, `callId`)
- `ToolCallEndEvent` (`type: 'tool_call_end'`, `callId`, `result`)
- `DoneEvent` (`type: 'done'`, `finalOutput`)
- `ErrorEvent` (`type: 'error'`, `error: Error`)

## Dependencies
Direct runtime import dependencies inside this folder:

- `@langchain/core/tools` (`StructuredToolInterface`) in `stream-action-parser.ts`.
- Built-in JS/TS primitives (`Map`, `Set`, async iterables, promises).

Package-level dependency context (`packages/agent/package.json`):

- Peer dependencies: `@langchain/core`, `@langchain/langgraph`, `zod`.
- Runtime dependencies: internal `@dzupagent/*` packages (not directly imported by these streaming helper files).

## Integration Points
Internal package integrations:

- Public exports are wired in `packages/agent/src/index.ts` under the `// --- Streaming ---` block.
- The local `src/streaming/index.ts` barrel mirrors the same streaming symbols.
- `README.md` streaming section currently documents `StreamActionParser` explicitly; `StreamingRunHandle` and `TextDeltaBuffer` are exported but not highlighted in that section.

Runtime boundary with agent streaming loop:

- `DzupAgent.stream()` delegates to `agent/streaming-run.ts` and yields `AgentStreamEvent` (`text`, `tool_call`, `tool_result`, `done`, `error`, `budget_warning`, `stuck`).
- `agent/streaming-run*.ts` does not import `src/streaming/*` helpers; stream loop tool handling and event emission are implemented in separate `agent/*` modules.
- Consumers that mix these two surfaces must map between `StreamActionEvent` / `StreamEvent` and `AgentStreamEvent` contracts explicitly.

## Testing and Observability
Dedicated tests for this module:

- `src/__tests__/streaming.test.ts`
- `src/__tests__/streaming-run-handle-deep.test.ts`
- `src/__tests__/stream-action-parser.test.ts`
- `src/__tests__/stream-action-parser-branches.test.ts`
- `src/__tests__/stream-action-parser-deep.test.ts`

Covered behavior includes:

- `TextDeltaBuffer`: partial token accumulation, whitespace/newline boundaries, flush/reset/peek behavior.
- `StreamingRunHandle`: status transitions, waiter handoff, terminal semantics, push-after-terminal errors, fail-path error event delivery, buffer overflow dropping.
- `StreamActionParser`: multimodal text extraction, chunked tool-call assembly, ID fallback behavior, duplicate suppression, parse edge cases, unknown/missing tools, tool exceptions, sequential vs parallel limits, and `flush()` drain behavior.

Observability in module code:

- No direct metrics/tracing/event-bus emission from `src/streaming/*`.
- Observability is exposed through returned event objects (`StreamActionEvent` and `StreamEvent`), leaving instrumentation to callers.

## Risks and TODOs
- `StreamActionParser` fallback IDs for missing `tool_calls[].id` are nondeterministic (`Date.now()` + `Math.random()`), which can complicate deterministic replay or correlation.
- `StreamingRunHandle` silently drops events beyond `maxBufferSize`; this prevents unbounded growth but can hide data loss under slow consumers.
- `StreamActionParser` retains `pending` and `fired` entries for the parser lifetime; long-lived parser instances can accumulate state unless recreated per run.
- `tryParseJson` only accepts object-shaped JSON (`{...}`); arrays/primitives in streamed args are treated as unparseable and degrade to `{}` in non-streaming `tool_calls` string mode.
- There are three streaming event surfaces in this package (`StreamActionEvent`, `StreamEvent`, `AgentStreamEvent`) with different shapes and semantics; adapter glue must remain explicit to avoid contract drift.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

