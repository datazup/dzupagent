# Streaming Architecture (`@dzupagent/codegen`)

## Scope
This document covers the code under `packages/codegen/src/streaming`:

- `codegen-stream-event.ts`
- `merge-codegen-streams.ts`
- `index.ts`

It also references direct package-level integration points that expose this module:

- `packages/codegen/src/index.ts` (root exports)
- `packages/codegen/src/__tests__/codegen-streaming.test.ts` (behavioral coverage)

Out of scope:

- Adapter/event-bus streaming in `src/generation/codegen-run-engine.ts`
- Sandbox command streaming in `src/sandbox/sandbox-protocol-v2.ts` and provider implementations

Those are separate streaming surfaces with different event contracts.

## Responsibilities
`src/streaming` provides a small, generic stream contract for codegen pipeline consumers:

- Define a discriminated union (`CodegenStreamEvent`) for pipeline/file/test/error progress events.
- Provide a fan-in utility (`mergeCodegenStreams`) that merges multiple `AsyncIterable<CodegenStreamEvent>` sources into one async generator.
- Convert source-level iterable failures into `codegen:error` events so other sources can continue draining.

The module does not currently:

- Start or manage generation runs.
- Connect directly to `DzupEventBus`.
- Own adapter or sandbox streaming lifecycles.

## Structure
Current files and roles:

- `codegen-stream-event.ts`
- Defines `CodegenStreamEvent` union members and payload shape.

- `merge-codegen-streams.ts`
- Implements async fan-in merge with per-source concurrency.
- Emits synthetic `codegen:error` when a source throws.

- `index.ts`
- Re-exports `CodegenStreamEvent` and `mergeCodegenStreams`.

Package export path:

- `src/index.ts` re-exports streaming symbols from `./streaming/index.js`.
- `package.json` exposes only root entrypoint (`dist/index.js`), so streaming is consumed through `@dzupagent/codegen` root exports.

## Runtime and Control Flow
`mergeCodegenStreams(...iterables)` behavior:

1. If no iterables are passed, it returns immediately.
2. It starts one async drain task per source iterable.
3. Each source pushes queue items (`value`, `done`, or `error`) into a shared queue.
4. The main loop waits for queue notifications and yields events as items arrive.
5. On source error, it decrements active-source count and yields one `codegen:error` event with normalized message text.
6. It continues processing remaining sources until all sources have ended (`done` or `error`).

Ordering guarantees and limits:

- Intra-source order is preserved.
- Cross-source order is arrival-based (interleaved).
- No global timestamp ordering or deterministic source prioritization is implemented.

## Key APIs and Types
`CodegenStreamEvent` variants:

- `codegen:file_patch`
- Payload: `{ filePath: string; patch: string }`

- `codegen:test_result`
- Payload: `{ passed: boolean; output: string; testFile?: string }`

- `codegen:pipeline_step`
- Payload: `{ step: string; status: 'started' | 'completed' | 'failed'; durationMs?: number }`

- `codegen:done`
- Payload: `{ summary: string; filesChanged: string[] }`

- `codegen:error`
- Payload: `{ message: string; step?: string }`

Merge API:

- `mergeCodegenStreams(...iterables: AsyncIterable<CodegenStreamEvent>[]): AsyncGenerator<CodegenStreamEvent>`

Error handling semantics:

- Source throws do not terminate the merged stream immediately.
- Each thrown source contributes one emitted `codegen:error` event.
- Remaining healthy sources continue and can still emit `codegen:done`.

## Dependencies
Direct dependencies inside `src/streaming`:

- No external package dependencies.
- Internal dependency only: `merge-codegen-streams.ts` imports `CodegenStreamEvent` type from `codegen-stream-event.ts`.

Build/runtime context:

- Compiled with package TypeScript/tsup pipeline.
- Exposed through the root package export surface defined in `src/index.ts` and `package.json`.

## Integration Points
Current verified integrations in `packages/codegen`:

- Root re-export in `src/index.ts`:
  - `export type { CodegenStreamEvent } from './streaming/index.js'`
  - `export { mergeCodegenStreams } from './streaming/index.js'`

- Direct in-package usage:
  - `src/__tests__/codegen-streaming.test.ts`

Current boundary reality:

- `CodegenRunEngine` uses adapter event types and forwards normalized bus events, but it does not import `CodegenStreamEvent` or `mergeCodegenStreams`.
- Sandbox streaming (`ExecEvent`) is a separate contract and does not compose with `CodegenStreamEvent` in current code.

## Testing and Observability
Test coverage for this module lives in:

- `src/__tests__/codegen-streaming.test.ts`

Covered behaviors include:

- Discriminant/type-shape checks for all `CodegenStreamEvent` variants.
- Merge with single and multiple sources.
- Empty-source and zero-source behavior.
- Error isolation (one source fails, others continue).
- Non-`Error` thrown values converted to `codegen:error` message.
- Pass-through integrity for terminal `codegen:done` events.

Observability notes:

- This module itself emits no logs/metrics/traces.
- Observability is provided by consumers that iterate and process emitted events.

## Risks and TODOs
Current risks:

- Unbounded queue growth risk in `mergeCodegenStreams` if producers outpace consumer iteration.
- No cancellation/abort integration; consumer stop behavior relies on async generator lifecycle only.
- `codegen:error` events generated by merge include message only (no source identifier in payload), which can reduce debugging precision for multi-source fan-in.
- Streaming contracts are fragmented across codegen events, adapter events, and sandbox exec events with no current shared adapter layer in this module.

Current TODO direction (grounded in existing code boundaries):

- Add optional backpressure or queue-limit policy for high-volume stream merging.
- Add optional source metadata propagation in emitted error events (for example, source index).
- Define and document a mapping layer only if a future consumer needs bridging between `CodegenStreamEvent` and other streaming contracts.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js.
- 2026-04-26: rewritten from current local implementation in `src/streaming`, package root exports, and streaming tests.
