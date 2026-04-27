# Streaming Architecture (`packages/agent/src/streaming`)

## Scope

This document covers the streaming utilities in `@dzupagent/agent` under `packages/agent/src/streaming`:

- `stream-action-parser.ts`
- `streaming-types.ts`
- `streaming-run-handle.ts`
- `text-delta-buffer.ts`
- `index.ts`

This scope is intentionally limited to the streaming helper module surface. The main agent runtime stream loop lives in `packages/agent/src/agent/streaming-run.ts` and uses `AgentStreamEvent` from `agent-types`, not the `StreamEvent` type from this folder.

## Responsibilities

The streaming module currently provides three independent building blocks plus a local barrel export:

- `StreamActionParser`: incremental parsing and execution of tool calls from partial or complete model chunks.
- `StreamingRunHandle`: in-memory producer/consumer handle for pushing and asynchronously consuming `StreamEvent` items.
- `TextDeltaBuffer`: whitespace-aware buffering utility for partial text token assembly.
- `streaming-types`: typed event contract used by `StreamingRunHandle`.

The module does not currently orchestrate `DzupAgent.stream()` directly.

## Structure

| File | Main Exports | Purpose |
| --- | --- | --- |
| `stream-action-parser.ts` | `StreamActionParser`, `StreamedToolCall`, `StreamActionEvent`, `StreamActionParserConfig` | Parse chunked tool call deltas and execute tools as soon as arguments are parseable. |
| `streaming-types.ts` | `StreamEvent` union and event interfaces | Defines `text_delta`, `tool_call_start`, `tool_call_end`, `done`, and `error` event shapes. |
| `streaming-run-handle.ts` | `StreamingRunHandle`, `StreamingStatus`, `StreamingRunHandleOptions` | Async-iterable queue abstraction with terminal states and bounded buffering. |
| `text-delta-buffer.ts` | `TextDeltaBuffer` | Buffers partial text and emits complete whitespace-delimited chunks. |
| `index.ts` | Re-exports above symbols | Local streaming barrel.

`packages/agent/src/index.ts` re-exports these streaming symbols as part of the package public API.

## Runtime and Control Flow

### `StreamActionParser`

`processChunk(chunk)` behavior:

1. Extract text from `chunk.content`.
1. Emit a `text` event when non-empty content exists.
1. Merge `tool_call_chunks` by `id` (or `index` fallback) into internal pending state.
1. When merged JSON args become parseable object JSON (`{...}`), emit `tool_call_start` and execute.
1. Process complete `tool_calls` in the same pass and execute immediately.

Execution behavior (`exec`):

- Looks up tool by `tc.name` from constructor-provided `StructuredToolInterface[]`.
- Emits `error` when tool is missing.
- Invokes tool and emits:
  - `tool_call_complete` plus `tool_result` in sequential mode.
  - `tool_call_complete` immediately and deferred `tool_result`/`error` in parallel mode.
- In parallel mode, `maxParallelTools` is enforced with an `active` promise set and `Promise.race` when saturated.

`flush()` behavior:

1. Re-check pending chunk-assembled calls and execute any newly parseable, unfired call.
1. Await and drain remaining parallel executions via `Promise.allSettled`.

### `StreamingRunHandle`

Producer/consumer flow:

1. Producer calls `push(event)` while status is `running`.
1. If consumer is waiting, event is delivered directly.
1. Otherwise event is queued, up to `maxBufferSize` (default `1000`); overflow events are dropped.
1. Consumer iterates `for await (const event of handle.events())`.
1. `complete()`, `fail(error)`, or `cancel()` transitions to terminal status and finishes iteration after buffered events drain.

### `TextDeltaBuffer`

1. `push(delta)` appends incoming text.
1. Finds last whitespace boundary.
1. Emits complete chunks matched by `/\S+\s*/g`.
1. Leaves trailing partial token in internal buffer.
1. `flush()` returns remaining buffered text; `reset()` clears state.

## Key APIs and Types

### `StreamActionParser` API

- `constructor(tools: StructuredToolInterface[], config?: StreamActionParserConfig)`
- `processChunk(chunk: ChunkInput): Promise<StreamActionEvent[]>`
- `flush(): Promise<StreamActionEvent[]>`

Related types:

- `StreamedToolCall`
- `StreamActionEvent` with event kinds: `text | tool_call_start | tool_call_complete | tool_result | error`
- `StreamActionParserConfig`:
  - `parallelExecution?: boolean`
  - `maxParallelTools?: number`

### `StreamingRunHandle` API

- `status: StreamingStatus` (`running | completed | failed | cancelled`)
- `push(event: StreamEvent): void`
- `complete(): void`
- `fail(error: Error): void`
- `cancel(): void`
- `events(): AsyncIterable<StreamEvent>`

### `StreamEvent` contract (`streaming-types.ts`)

- `TextDeltaEvent` (`type: 'text_delta'`, `content`)
- `ToolCallStartEvent` (`type: 'tool_call_start'`, `toolName`, `callId`)
- `ToolCallEndEvent` (`type: 'tool_call_end'`, `callId`, `result`)
- `DoneEvent` (`type: 'done'`, `finalOutput`)
- `ErrorEvent` (`type: 'error'`, `error`)

## Dependencies

Direct dependencies used by this module:

- `@langchain/core/tools` (`StructuredToolInterface`) in `stream-action-parser.ts`
- Internal TypeScript/Node runtime primitives (`Promise`, async iterables, Maps/Sets)

Package-level context (`packages/agent/package.json`):

- Runtime deps include `@dzupagent/*` packages, but streaming files here only directly import `@langchain/core/tools`.
- Peer deps include `@langchain/core`, `@langchain/langgraph`, and `zod`.

## Integration Points

Current integration surface in `@dzupagent/agent`:

- Exported via `packages/agent/src/index.ts` and `packages/agent/src/streaming/index.ts`.
- Mentioned in `packages/agent/README.md` streaming section.

Current usage status inside the package:

- `StreamActionParser`, `StreamingRunHandle`, and `TextDeltaBuffer` are heavily covered by tests.
- No production runtime path in `packages/agent/src/agent/streaming-run.ts` currently imports these utilities.
- `DzupAgent.stream()` currently emits `AgentStreamEvent` (`text`, `tool_call`, `tool_result`, `budget_warning`, `stuck`, `error`, `done`) from `agent/streaming-run.ts`, separate from `StreamEvent` and `StreamActionEvent` contracts in this folder.

## Testing and Observability

Dedicated streaming tests in `packages/agent/src/__tests__`:

- `streaming.test.ts`
- `streaming-run-handle-deep.test.ts`
- `stream-action-parser.test.ts`
- `stream-action-parser-branches.test.ts`
- `stream-action-parser-deep.test.ts`

Additional stream-adjacent runtime tests:

- `stream-tool-guardrail-parity.test.ts`
- `token-lifecycle-stream-wiring.test.ts`
- `stream-textual-workflow.test.ts`

Observed coverage focus from tests:

- `StreamActionParser`: text extraction branches, chunk assembly, ID fallbacks, duplicate suppression, parse edge cases, unknown tools, thrown tool errors, sequential vs parallel execution, and flush behavior.
- `StreamingRunHandle`: queueing, waiter handoff, terminal transitions, idempotent terminal calls, error-event delivery, cancellation behavior, and bounded buffer dropping.
- `TextDeltaBuffer`: whitespace boundary parsing, partial token buffering, newline handling, flush/reset behavior.

Observability characteristics in module code:

- No direct metrics or event bus emission in `src/streaming/*`.
- Observability is event-shaped output only (`StreamActionEvent` / `StreamEvent`) for consumers to instrument.

## Risks and TODOs

- `StreamActionParser` fallback IDs for missing `tool_calls[].id` use `Date.now()` and `Math.random()`, so IDs are non-deterministic.
- `StreamingRunHandle` silently drops events after `maxBufferSize`; this avoids unbounded memory growth but can lose data under slow consumers.
- `StreamEvent` and `StreamActionEvent` contracts differ from `AgentStreamEvent`; adapters need explicit mapping when combining these surfaces.
- `src/streaming/*` utilities are exported but not currently wired into `DzupAgent.stream()` runtime loop, so behavior can diverge unless maintained intentionally.

## Changelog

- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

