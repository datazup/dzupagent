# Streaming Architecture (`@dzupagent/codegen`)

## Scope
This document covers the streaming subsystem implemented in `packages/codegen/src/streaming`.

- `codegen-stream-event.ts`
- `merge-codegen-streams.ts`
- `index.ts`

It also covers immediate integration points inside `packages/codegen` that expose or verify this subsystem.

- `src/index.ts` (root exports)
- `src/__tests__/codegen-streaming.test.ts` (behavioral tests)
- package-level publish surface in `package.json` (`.` root export only)

Out of scope for this document:

- Adapter event streaming and event-bus forwarding in `src/generation/codegen-run-engine.ts`
- Sandbox session stream events in `src/sandbox/sandbox-protocol-v2.ts`
- Preview streaming usage in `src/tools/preview-app.tool.ts`

Those are separate streaming contracts.

## Responsibilities
`src/streaming` has two responsibilities.

- Define a typed codegen stream event union (`CodegenStreamEvent`) for file patch, test result, pipeline step, done, and error events.
- Provide fan-in merging (`mergeCodegenStreams`) for multiple `AsyncIterable<CodegenStreamEvent>` sources.

It intentionally does not:

- Start code generation runs.
- Translate adapter events.
- Emit to `DzupEventBus`.
- Manage sandbox sessions or command-stream lifecycles.

## Structure
Current files and roles:

- `codegen-stream-event.ts`: declares `CodegenStreamEvent` as a discriminated union.
- `codegen-stream-event.ts` event variants: `codegen:file_patch`, `codegen:test_result`, `codegen:pipeline_step`, `codegen:done`, `codegen:error`.
- `merge-codegen-streams.ts`: exports `mergeCodegenStreams(...iterables)`.
- `merge-codegen-streams.ts`: starts one async drain task per source iterable.
- `merge-codegen-streams.ts`: uses an in-memory queue to interleave source output by arrival.
- `merge-codegen-streams.ts`: converts source exceptions into emitted `codegen:error` events.
- `index.ts`: re-exports `CodegenStreamEvent` and `mergeCodegenStreams`.

Export surface in package:

- `src/index.ts` re-exports streaming APIs.
- `src/runtime.ts`, `src/tools.ts`, and `src/vfs.ts` do not re-export streaming APIs.
- `package.json` publishes only root subpath `.` for these symbols (no dedicated `./streaming` export).

## Runtime and Control Flow
`mergeCodegenStreams` runtime behavior:

1. Accepts zero or more `AsyncIterable<CodegenStreamEvent>` sources.
2. If zero sources are passed, returns immediately.
3. Spawns one background async loop per source.
4. Each source loop pushes queue items with one of three shapes: `{ done: false, value, sourceIndex }`, `{ done: true, sourceIndex }`, `{ error: true, sourceIndex, err }`.
5. A shared notifier resolves waiting consumer loop iterations.
6. Main loop drains queued items until all sources are terminal (`done` or `error`).
7. On source error, the merge emits one `codegen:error` event with normalized message text and continues draining remaining sources.

Ordering semantics:

- Per-source event order is preserved.
- Cross-source ordering is best-effort arrival order.
- No global priority, timestamp sort, or fairness policy is implemented.

## Key APIs and Types
`CodegenStreamEvent` (`src/streaming/codegen-stream-event.ts`):

- `{ type: 'codegen:file_patch'; filePath: string; patch: string }`
- `{ type: 'codegen:test_result'; passed: boolean; output: string; testFile?: string }`
- `{ type: 'codegen:pipeline_step'; step: string; status: 'started' | 'completed' | 'failed'; durationMs?: number }`
- `{ type: 'codegen:done'; summary: string; filesChanged: string[] }`
- `{ type: 'codegen:error'; message: string; step?: string }`

`mergeCodegenStreams` (`src/streaming/merge-codegen-streams.ts`):

- Signature: `(...iterables: AsyncIterable<CodegenStreamEvent>[]) => AsyncGenerator<CodegenStreamEvent>`
- Emits source events unchanged.
- Emits synthesized `codegen:error` when a source throws.

## Dependencies
Direct dependencies of the streaming module:

- No runtime third-party dependencies.
- Type-only local dependency from `merge-codegen-streams.ts` to `codegen-stream-event.ts`.

Build and package context affecting this module:

- Built by `tsup` from package root entrypoints (`src/index.ts`, `src/runtime.ts`, `src/tools.ts`, `src/vfs.ts`, `src/compat.ts`).
- Type-checked by package TypeScript config.
- Published through root export map in `package.json`.

## Integration Points
Verified usage and exposure inside `packages/codegen`:

- `src/index.ts` exports `CodegenStreamEvent` from `./streaming/index.js`.
- `src/index.ts` exports `mergeCodegenStreams` from `./streaming/index.js`.
- `src/__tests__/codegen-streaming.test.ts` imports both symbols and validates behavior.

Verified non-integration boundaries that matter for consumers:

- `CodegenRunEngine` (`src/generation/codegen-run-engine.ts`) maps `adapter:stream_delta` to `agent:stream_delta` on `DzupEventBus`, but does not consume `CodegenStreamEvent` or `mergeCodegenStreams`.
- `SandboxProtocolV2` defines `ExecEvent` (`stdout`, `stderr`, `exit`) for `executeStream`, separate from `CodegenStreamEvent`.
- `preview_app` tool consumes sandbox `executeStream` events directly, not `CodegenStreamEvent`.

## Testing and Observability
Primary tests:

- `src/__tests__/codegen-streaming.test.ts`

Covered behaviors in this test file:

- Event-type discrimination and field-shape checks for all `CodegenStreamEvent` variants.
- Single-source pass-through.
- Multi-source merge and interleaving.
- Empty-source and zero-source behavior.
- Continued draining when one source throws.
- Error normalization for non-`Error` thrown values.
- Pass-through of `codegen:done` payload.

Package-level test and coverage environment (applies to this module too):

- Vitest `node` environment.
- Coverage provider `v8`.
- Thresholds: statements 60, branches 50, functions 50, lines 60.

Observability characteristics:

- This module emits no logs, metrics, or traces.
- Operational visibility depends on whichever consumer iterates and records emitted events.

## Risks and TODOs
Current risks from implementation reality:

- In-memory queue is unbounded; high producer throughput can grow memory if consumer iteration is slow.
- No explicit cancellation or abort hook (for example, `AbortSignal`) in merge API.
- Synthesized `codegen:error` includes normalized message but omits `sourceIndex` in payload, reducing multi-source debugging fidelity.
- Streaming contracts remain split across codegen events, adapter events, and sandbox exec events; there is no shared bridge in this module.

Reasonable TODO directions consistent with current code:

- Consider optional bounded buffering or backpressure strategy for the merge queue.
- Consider optional source metadata propagation for synthesized error events.
- Consider optional cancellation support in the merge API if long-lived fan-in usage expands.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js.
- 2026-05-17: rewritten against current `src/streaming` implementation, root exports, package manifest, and streaming-focused tests.
