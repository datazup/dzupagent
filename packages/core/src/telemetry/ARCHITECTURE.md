# Telemetry Trace Propagation Architecture

This document describes the implementation in `packages/core/src/telemetry/trace-propagation.ts`, how it is used across the monorepo, and the current test coverage state.

## Scope

Module: `packages/core/src/telemetry/trace-propagation.ts`

Public API:
- `formatTraceparent(ctx: TraceContext): string`
- `parseTraceparent(traceparent: string): TraceContext | null`
- `injectTraceContext(metadata?: Record<string, unknown>): Record<string, unknown>`
- `extractTraceContext(metadata?: Record<string, unknown>): TraceContext | null`
- `TraceContext` type

Core design goal:
- Provide W3C-compatible trace context propagation across process boundaries without taking a hard dependency on `@opentelemetry/api` or `@dzupagent/otel`.

## Data Contract

The module stores context under `metadata._trace.traceparent`.

Wire format:
- `traceparent = "00-{traceId}-{spanId}-{flags}"`
- `traceId`: 32 lowercase hex chars
- `spanId`: 16 lowercase hex chars
- `flags`: hexadecimal flags (typically `01` for sampled)

Internal type:

```ts
export interface TraceContext {
  traceId: string
  spanId: string
  traceFlags: number
}
```

## Feature Breakdown

### 1) W3C `traceparent` formatter

`formatTraceparent` converts a `TraceContext` into a W3C-style header string.

Behavior:
- Uses version `00`.
- Converts numeric `traceFlags` to hex and zero-pads to at least 2 chars.
- Produces deterministic output for the same input.

### 2) W3C `traceparent` parser

`parseTraceparent` parses and validates a traceparent string.

Behavior:
- Returns `null` for malformed/invalid inputs.
- Validates hex format and lengths for `traceId` and `spanId`.
- Parses hex flags into `traceFlags` number.

### 3) Idempotent metadata injection

`injectTraceContext` ensures metadata carries trace context from run creation onward.

Behavior:
- Non-mutating: returns a new metadata object.
- Preserves existing valid `_trace.traceparent` (idempotent).
- Generates new IDs when absent/invalid.
- Stores trace context in `metadata._trace.traceparent`.

### 4) Safe metadata extraction

`extractTraceContext` reads context from metadata and validates it through `parseTraceparent`.

Behavior:
- Defensive on absent metadata and wrong types.
- Returns `null` rather than throwing for malformed inputs.

### 5) Queue-safe serialization compatibility

The module intentionally uses plain JSON-friendly data in metadata (`string` under `_trace.traceparent`), making it safe for queue persistence and worker deserialization.

## Runtime Flow (Cross-Package)

### End-to-end flow used by `@dzupagent/server`

1. Run request enters route layer.
- `packages/server/src/routes/runs.ts` merges request metadata and routing metadata.
- It calls `injectTraceContext(...)` before `runStore.create(...)`.

2. Run metadata is enqueued and persisted.
- Queue payload includes `run.metadata` (already carrying `_trace.traceparent`).

3. Worker process dequeues job.
- `packages/server/src/runtime/run-worker.ts` calls `extractTraceContext(job.metadata)`.
- If present, it builds `ForgeTraceContext` (`traceId`, `spanId`, `agentId`, `runId`, optional `tenantId`).

4. Execution runs inside OTel context bridge.
- Worker invokes run executor using `withForgeContext(...)` when trace context exists.
- This links the core metadata trace into the OTel context system (`@dzupagent/otel`).

5. Correlation in logs/events.
- Worker includes `traceId` in run logs for dequeue, completion, and failure paths.

## Usage Examples

### Example A: Create run metadata with trace context

```ts
import { injectTraceContext } from '@dzupagent/core'

const metadata = injectTraceContext({
  sessionId: 'sess-123',
  tenantId: 'tenant-acme',
})

// metadata._trace.traceparent is now present
```

### Example B: Extract in worker and bridge into execution context

```ts
import { extractTraceContext } from '@dzupagent/core'
import { withForgeContext } from '@dzupagent/otel'

const traceCtx = extractTraceContext(job.metadata as Record<string, unknown> | undefined)

if (traceCtx) {
  await withForgeContext(
    {
      traceId: traceCtx.traceId,
      spanId: traceCtx.spanId,
      runId: job.runId,
      agentId: job.agentId,
      baggage: {},
    },
    executeRun,
  )
} else {
  await executeRun()
}
```

### Example C: Parse and validate incoming traceparent directly

```ts
import { parseTraceparent } from '@dzupagent/core'

const parsed = parseTraceparent(
  '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
)

if (!parsed) {
  // invalid format
}
```

## Reference Map: Where It Is Used

### Export surfaces in `core`

- `packages/core/src/index.ts`
  - Root package re-export of all telemetry helpers and `TraceContext`.
- `packages/core/src/facades/orchestration.ts`
  - Facade-level re-export for orchestration-focused imports.

### Direct runtime usage in other packages

- `packages/server/src/routes/runs.ts`
  - Calls `injectTraceContext` when creating runs.
- `packages/server/src/runtime/run-worker.ts`
  - Calls `extractTraceContext`, maps to `ForgeTraceContext`, executes under `withForgeContext`.

### Test-level usage in other packages

- `packages/server/src/__tests__/e2e-run-pipeline.test.ts`
  - Verifies trace flows through create -> queue -> execute -> persisted run metadata.
- `packages/server/src/__tests__/run-worker.test.ts`
  - Verifies extracted trace is visible in active Forge/OTel context during executor run.

## Test Coverage

### Module unit tests (`@dzupagent/core`)

File:
- `packages/core/src/__tests__/trace-propagation.test.ts`

Current assertions cover:
- `formatTraceparent`
  - W3C formatting correctness.
  - flag zero-padding.
- `parseTraceparent`
  - valid parse path.
  - malformed and invalid-length/invalid-hex rejection.
- `injectTraceContext`
  - injection into empty and missing metadata.
  - non-mutation of original object.
  - metadata preservation.
  - idempotency when valid trace already exists.
  - uniqueness across injections.
- `extractTraceContext`
  - undefined/empty/wrong-shape guards.
  - valid extraction path.
- round-trip and persistence safety
  - inject -> extract invariants.
  - format -> parse round-trip.
  - JSON serialize/deserialize scenario.

Executed test command:
- `yarn workspace @dzupagent/core test -- src/__tests__/trace-propagation.test.ts`
- Result: 24 tests passed.

Coverage run (targeted file execution under package-wide thresholds):
- `yarn workspace @dzupagent/core test:coverage -- src/__tests__/trace-propagation.test.ts`
- Module-specific result for `src/telemetry/trace-propagation.ts`:
  - Statements: 100%
  - Branches: 92.85%
  - Functions: 100%
  - Lines: 100%
- Note: the overall command exits non-zero due to global package thresholds, not telemetry module failure.

Uncovered branch points reported for this file:
- line 75 (`if (!traceId || !spanId || !flagsHex) return null`)
- line 80 (`if (Number.isNaN(traceFlags)) return null`)

### Cross-package integration tests (`@dzupagent/server`)

Executed targeted commands:
- `yarn workspace @dzupagent/server test -- src/__tests__/e2e-run-pipeline.test.ts -t "trace propagation: traceId flows through the pipeline"`
  - Result: 3 passed (trace propagation scenario), 8 skipped in that file.
- `yarn workspace @dzupagent/server test -- src/__tests__/run-worker.test.ts -t "propagates forge trace context into run executor"`
  - Result: 1 passed, 6 skipped in that file.

These tests validate end-to-end adoption beyond core unit behavior.

## Operational Notes and Constraints

- Lightweight by design:
  - No direct dependency on OTel SDK types in `core`.
  - This keeps `@dzupagent/core` usable in environments that do not install OTel stack.
- Fail-open integration in server:
  - Route and worker treat trace inject/extract errors as non-fatal.
- Current parser behavior:
  - Validates `traceId`/`spanId` shape strictly.
  - Does not enforce exact 4-part structure or strict flags width/version constraints beyond current checks.
  - This is acceptable for current internal use but should be tightened if strict external header interoperability is required.

## When to Extend This Module

Extend `trace-propagation.ts` if you need:
- strict W3C compliance checks (version/flags width/forbidden values),
- baggage propagation support (e.g., `tracestate`, custom baggage map),
- explicit parent/child span derivation helpers,
- adapters for HTTP headers and message buses in addition to metadata objects.
