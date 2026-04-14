# Streaming Architecture (`packages/agent/src/streaming`)

Last updated: 2026-04-04

## Scope

This document covers the streaming tool-call parser module in `@dzupagent/agent`:

- `packages/agent/src/streaming/stream-action-parser.ts`
- `packages/agent/src/streaming/index.ts`

It also includes:

- public API and feature breakdown
- runtime flow and event semantics
- usage examples and practical use cases
- references from other packages and how they consume related streaming events
- current test and coverage status

## Design Intent

`StreamActionParser` is designed for tool-call execution during token streaming, not after full-response completion.

Key goals:

1. Parse partial `tool_call` deltas incrementally from model chunks.
2. Trigger tool execution as soon as JSON args become complete.
3. Emit a stable event stream for text, tool lifecycle, results, and errors.
4. Support sequential or bounded-parallel tool execution.

## Module Map

| File | Responsibility | Key Exports |
| --- | --- | --- |
| `stream-action-parser.ts` | Stateful parser + executor for streaming/non-streaming tool calls | `StreamActionParser`, `StreamedToolCall`, `StreamActionEvent`, `StreamActionParserConfig` |
| `index.ts` | Local barrel | Re-exports all streaming parser symbols |

## Public Contract

### `StreamedToolCall`

Canonical call object after parse:

```ts
interface StreamedToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}
```

### `StreamActionEvent`

Event envelope emitted by parser:

```ts
interface StreamActionEvent {
  type: 'text' | 'tool_call_start' | 'tool_call_complete' | 'tool_result' | 'error'
  data: {
    content?: string
    toolCall?: StreamedToolCall
    result?: string
    error?: string
  }
}
```

### `StreamActionParserConfig`

```ts
interface StreamActionParserConfig {
  parallelExecution?: boolean // default false
  maxParallelTools?: number   // default 3
}
```

## Internal State Model

`StreamActionParser` keeps mutable state across chunks:

- `tools: Map<string, StructuredToolInterface>`
- `pending: Map<string, { name: string; argsJson: string }>`
- `fired: Set<string>` to prevent duplicate execution
- `active: Set<Promise<StreamActionEvent>>` for in-flight parallel runs
- `parallel` + `maxConcurrent` execution config

This means a parser instance is intended to live for one streaming response lifecycle, then be flushed.

## Input Shapes and Parsing Rules

`processChunk()` accepts mixed chunk shapes:

- `content`: string or array of typed parts (only `{ type: 'text', text }` is concatenated)
- `tool_call_chunks`: partial tool-call deltas with incremental `args` fragments
- `tool_calls`: complete calls (non-streaming style)

JSON parse guard behavior (`tryParseJson`):

- only parses when trimmed args start with `{` and end with `}`
- only accepts JSON objects (`Record<string, unknown>`)
- parse failures return `undefined` (deferred for chunks, default `{}` for complete `tool_calls` string args)

## Execution Flow

### High-level flow

```text
processChunk(chunk)
  -> emit text event (if text found)
  -> merge tool_call_chunks into pending[id]
  -> if pending[id] now parseable and not fired:
       emit tool_call_start
       exec(toolCall)
  -> process complete tool_calls similarly
  -> return emitted events

flush()
  -> execute any parseable pending calls not yet fired
  -> await remaining parallel active jobs
  -> return trailing events
```

### Event ordering guarantees

Sequential mode (`parallelExecution = false`):

1. `tool_call_start`
2. `tool_call_complete`
3. terminal event: `tool_result` or `error`

Parallel mode (`parallelExecution = true`):

1. `tool_call_start`
2. immediate `tool_call_complete`
3. `tool_result` or `error` appears later:
   - on a subsequent saturated call (via `Promise.race`)
   - or on `flush()`

### Concurrency semantics

- When `active.size < maxParallelTools`, new call is queued and only completion marker is returned immediately.
- When saturated, parser waits for first completed active promise (`Promise.race`), emits that result in same `processChunk` response, then starts next tool.
- `flush()` drains unresolved active promises (`Promise.allSettled`) and returns fulfilled events.

## Feature Breakdown

### 1) Partial-delta accumulation

- Supports tool args arriving across multiple stream chunks.
- Uses tool call `id`; falls back to `index` string when missing.
- Avoids duplicate execution with `fired`.

### 2) Mixed-mode compatibility

- Works with both partial chunks (`tool_call_chunks`) and full calls (`tool_calls`) in same parser.

### 3) Early execution trigger

- Executes as soon as object JSON becomes parseable, without waiting for full assistant response.

### 4) Parallel tool execution (bounded)

- Optional bounded concurrency with `maxParallelTools`.
- Internal tracking ensures active-set cleanup when promises settle.

### 5) Text extraction passthrough

- Emits `text` events from string content and text-part arrays in chunk payloads.

### 6) Structured error surfacing

- Missing tool => `error` event with tool metadata.
- Tool invoke exception => `error` event with message.

## Usage Examples

### Example 1: Sequential execution from complete tool calls

```ts
import { StreamActionParser } from '@dzupagent/agent'

const parser = new StreamActionParser([weatherTool])

const events = await parser.processChunk({
  tool_calls: [
    { id: 'w1', name: 'weather', args: { city: 'Sarajevo' } },
  ],
})

// events:
// - tool_call_start
// - tool_call_complete
// - tool_result | error
```

### Example 2: Incremental chunk assembly (`tool_call_chunks`)

```ts
await parser.processChunk({
  tool_call_chunks: [{ id: 'c1', name: 'search', args: '{"query":"best ' }],
})
// no tool execution yet (invalid JSON)

const events = await parser.processChunk({
  tool_call_chunks: [{ id: 'c1', args: 'pizza"}' }],
})
// now parseable -> emits start/complete/result

const tail = await parser.flush()
// drains pending parseable calls + in-flight parallel work
```

### Example 3: Parallel execution with bounded concurrency

```ts
const parser = new StreamActionParser([toolA, toolB], {
  parallelExecution: true,
  maxParallelTools: 2,
})

await parser.processChunk({ tool_calls: [{ id: '1', name: 'toolA', args: {} }] })
await parser.processChunk({ tool_calls: [{ id: '2', name: 'toolB', args: {} }] })

// Third call waits for first completed active run to free a slot
const events = await parser.processChunk({
  tool_calls: [{ id: '3', name: 'toolA', args: {} }],
})

const remaining = await parser.flush()
```

## Practical Use Cases

1. Real-time chat UIs where tool progress should appear before final LLM completion.
2. Multi-tool plans where each call can start as soon as args JSON closes.
3. Integrating provider-native chunk streams that emit partial tool-call args.
4. Latency reduction for expensive tools by overlapping model generation and tool invocation.
5. Building adapter layers that need parser-driven event normalization before SSE/WebSocket transport.

## Cross-Package References and Usage

### Direct references to `StreamActionParser`

Static search over `packages/**` shows:

- Definition and local barrel:
  - `packages/agent/src/streaming/stream-action-parser.ts`
  - `packages/agent/src/streaming/index.ts`
- Root package export:
  - `packages/agent/src/index.ts`
- Documentation mention:
  - `packages/agent/README.md`
- Direct test usage:
  - `packages/agent/src/__tests__/stream-action-parser.test.ts`

No production code in other packages currently imports or instantiates `StreamActionParser` directly.

### Related cross-package streaming usage (adjacent)

Although `StreamActionParser` itself is not consumed cross-package, several packages consume the broader `DzupAgent.stream()` event model:

1. `@dzupagent/express`
   - `packages/express/src/agent-router.ts`: invokes `agent.stream(...)`.
   - `packages/express/src/sse-handler.ts`: maps agent events (`text`, `tool_call`, `tool_result`, `done`, `error`, etc.) to SSE frames.
2. `@dzupagent/server`
   - `packages/server/src/runtime/dzip-agent-run-executor.ts`: iterates `agent.stream(...)`, logs tool phases, emits bus deltas, and aggregates output.

This establishes event-shape interoperability around streaming behavior, even without direct parser reuse.

### Relationship to `DzupAgent.stream()`

Current `DzupAgent.stream()` implementation handles tool calls from final `fullResponse.tool_calls` in each streamed iteration and executes them via `executeStreamingToolCall` in `run-engine.ts`.

`StreamActionParser` is a separate utility and is not currently wired into that path. It is available as an exported building block for custom runtime loops that need chunk-level incremental tool-call parsing.

## Test Coverage Status

### Direct parser tests

Primary dedicated test:

- `packages/agent/src/__tests__/stream-action-parser.test.ts`

Current coverage of behaviors in this test:

1. Parallel execution mode (`parallelExecution: true`)
2. `maxParallelTools` cap enforcement
3. `flush()` draining of pending active tool runs

### Adjacent streaming tests (broader agent path)

- `packages/agent/src/__tests__/token-usage.test.ts` validates token extraction and guardrail warnings in `DzupAgent.stream()`.
- `packages/agent/src/__tests__/dzip-agent-run-parity.test.ts` validates generate/stream parity for middleware, iteration limits, stuck detection, and stream fallback.

Executed on 2026-04-04:

```bash
yarn workspace @dzupagent/agent test \
  src/__tests__/stream-action-parser.test.ts \
  src/__tests__/token-usage.test.ts \
  src/__tests__/dzip-agent-run-parity.test.ts
```

Result: 3 files passed, 10 tests passed.

### Focused coverage metrics for parser file

Executed on 2026-04-04:

```bash
yarn workspace @dzupagent/agent test:coverage -- src/__tests__/stream-action-parser.test.ts
```

From `packages/agent/coverage/coverage-summary.json`:

- `src/streaming/stream-action-parser.ts`
  - Lines: `74.41%` (128/172)
  - Statements: `74.41%` (128/172)
  - Functions: `88.88%` (8/9)
  - Branches: `46.42%` (13/28)

Note: the coverage command exits non-zero because package-wide global thresholds are enforced for single-test runs.

### Coverage Gaps and Risks

Uncovered or lightly covered parser behaviors:

1. Sequential execution path (`parallelExecution: false`) event ordering.
2. Missing tool path (`Tool "<name>" not found`).
3. Tool exception path producing `error` event.
4. `tool_call_chunks` JSON-incomplete then complete transitions.
5. `content` array extraction branch (`[{ type: 'text', text: ... }]`).
6. `tryParseJson` rejection branches and malformed JSON handling.
7. Duplicate suppression (`fired` set) for repeated IDs across chunks/calls.

### Recommended Next Tests

1. Add a sequential-mode test verifying exact event sequence and result shape.
2. Add partial-chunk assembly tests covering parse-later and `flush()`-triggered execution.
3. Add error-path tests for unknown tools and thrown tool exceptions.
4. Add text extraction tests for both string and structured content-array chunks.
5. Add dedupe tests for repeated IDs in mixed `tool_call_chunks` + `tool_calls` inputs.
