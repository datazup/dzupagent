# Telemetry Module Architecture (`packages/core/src/telemetry`)

## Scope
This document covers the telemetry module in `@dzupagent/core` under `packages/core/src/telemetry`.

Included files:
- `src/telemetry/trace-propagation.ts`
- `src/telemetry/ARCHITECTURE.md`

Included integration surfaces inside `packages/core`:
- root exports in `src/index.ts`
- orchestration facade exports in `src/facades/orchestration.ts`
- test coverage in `src/__tests__/trace-propagation.test.ts` and `src/__tests__/facade-orchestration.test.ts`

Out of scope:
- OpenTelemetry SDK setup and exporter wiring
- telemetry ingestion backends
- runtime instrumentation in other packages

## Responsibilities
The module provides lightweight trace context propagation utilities for metadata crossing process boundaries.

Current responsibilities:
- Define a minimal serializable `TraceContext` shape.
- Generate new trace identifiers when no valid trace context exists.
- Format a trace context to a `traceparent` string.
- Parse and validate a `traceparent` string into `TraceContext`.
- Inject trace data into metadata under `_trace.traceparent`.
- Extract trace data from metadata and return `TraceContext | null`.

Explicit non-responsibilities:
- Span lifecycle management.
- Metric emission, logging, or tracing exporters.
- OTel API context management.

## Structure
Telemetry is currently a single-file implementation.

| File | Purpose | Public exports |
| --- | --- | --- |
| `trace-propagation.ts` | Generate, format, parse, inject, and extract trace context in metadata-safe form | `TraceContext`, `formatTraceparent`, `parseTraceparent`, `injectTraceContext`, `extractTraceContext` |

Internal implementation details:
- `TRACE_KEY` constant is fixed to `'_trace'`.
- `generateTraceId()` uses `randomUUID()` with dashes removed.
- `generateSpanId()` uses the first 16 hex chars of a UUID-without-dashes string.

## Runtime and Control Flow
Primary inject/extract flow:
1. Caller provides optional metadata (`Record<string, unknown>`).
2. `injectTraceContext` first calls `extractTraceContext(metadata)`.
3. If extraction returns a valid `TraceContext`, `injectTraceContext` returns a shallow copy of metadata without replacing `_trace`.
4. If extraction fails, `injectTraceContext` generates a new context (`traceId`, `spanId`, `traceFlags: 1`).
5. `injectTraceContext` returns a new object containing `_trace.traceparent`.
6. Downstream code can call `extractTraceContext` and recover the parsed context.

`parseTraceparent` flow:
1. Split incoming string by `-`.
2. Require at least 4 parts.
3. Read part indexes `[1]` as `traceId`, `[2]` as `spanId`, `[3]` as flags.
4. Validate `traceId` as lowercase 32-char hex and `spanId` as lowercase 16-char hex.
5. Parse flags with base-16 integer conversion.
6. Return `TraceContext` or `null` on any malformed input.

## Key APIs and Types
`TraceContext`:
- `traceId: string`
- `spanId: string`
- `traceFlags: number`

`formatTraceparent(ctx: TraceContext): string`:
- Returns `00-{traceId}-{spanId}-{flagsHex}`.
- Uses `traceFlags.toString(16).padStart(2, '0')`.

`parseTraceparent(traceparent: string): TraceContext | null`:
- Defensive parser.
- Returns `null` instead of throwing.

`injectTraceContext(metadata?: Record<string, unknown>): Record<string, unknown>`:
- Non-mutating API (returns new object).
- Idempotent for already valid `_trace.traceparent`.

`extractTraceContext(metadata?: Record<string, unknown>): TraceContext | null`:
- Reads only `_trace.traceparent`.
- Returns `null` for missing or invalid payloads.

## Dependencies
Direct runtime dependency in telemetry implementation:
- Node built-in `node:crypto` (`randomUUID`).

Package-level context (from `packages/core/package.json`):
- No direct telemetry dependency on `@langchain/*`, `zod`, or other optional peers.
- Telemetry utilities are plain TypeScript + Node standard library.

## Integration Points
Exports and entrypoints:
- Root package export path `@dzupagent/core` exposes telemetry utilities via `src/index.ts`.
- Orchestration facade export path `@dzupagent/core/orchestration` exposes the same telemetry utilities via `src/facades/orchestration.ts`.
- `@dzupagent/core/stable` reaches telemetry indirectly through facade namespace exports.

Current in-package usage:
- No non-test runtime module in `src/` imports telemetry utilities directly.
- Integration is currently API-surface exposure plus test verification.

## Testing and Observability
Telemetry-focused tests:
- `src/__tests__/trace-propagation.test.ts` covers:
  - valid and invalid parse cases
  - format behavior
  - inject idempotency and immutability
  - inject/extract round-trips
  - JSON serialization round-trip safety

Facade exposure tests:
- `src/__tests__/facade-orchestration.test.ts` validates telemetry exports and behavior through `../facades/orchestration.js`.

Observability status of this module:
- No internal metrics, logs, or events emitted by telemetry helpers.
- Module provides correlation payload only; observability execution is delegated to upstream/downstream systems.

## Risks and TODOs
- `parseTraceparent` accepts strings with more than 4 dash-separated segments because it checks only `parts.length < 4`.
- Parser does not validate or enforce `version` segment semantics.
- Parser accepts any parseable hex flags length, not strictly two hex chars.
- `formatTraceparent` does not constrain `traceFlags` to one byte.
- Only `traceparent` is modeled; no `tracestate`/baggage handling.
- Telemetry remains helper-only in this package (no direct production call sites in `packages/core/src` outside export surfaces).

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

