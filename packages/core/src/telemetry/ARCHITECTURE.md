# Telemetry Module Architecture (`packages/core/src/telemetry`)

## Scope
This document covers the telemetry implementation currently present in `packages/core/src/telemetry`:
- `trace-propagation.ts`

It also covers in-package integration points within `packages/core`:
- root public exports in `src/index.ts`
- orchestration facade re-exports in `src/facades/orchestration.ts`
- facade namespace exposure via `src/facades/index.ts` and `src/stable.ts`

Out of scope:
- server/runtime usage in other packages
- OpenTelemetry SDK setup, exporters, and backend configuration

## Responsibilities
The telemetry module in `@dzupagent/core` is intentionally narrow. It is responsible for lightweight W3C-style trace context serialization/parsing so callers can move correlation context through opaque metadata objects.

Concretely, it owns:
- Creating trace context IDs (`traceId`, `spanId`) for metadata propagation.
- Formatting and parsing `traceparent` strings.
- Injecting trace context into metadata under a stable key (`_trace.traceparent`).
- Extracting and validating trace context from previously stored metadata.

It does not own:
- span lifecycle management
- metrics/log emission
- OTel context activation APIs

## Structure
| File | Purpose | Main exports |
| --- | --- | --- |
| `trace-propagation.ts` | Pure utility helpers for trace context generation, formatting, parsing, metadata inject/extract | `TraceContext`, `formatTraceparent`, `parseTraceparent`, `injectTraceContext`, `extractTraceContext` |

Internal constants and helpers in `trace-propagation.ts`:
- `TRACE_KEY = '_trace'`
- `generateTraceId()` uses `randomUUID()` with dashes stripped.
- `generateSpanId()` uses `randomUUID()` with dashes stripped and truncated to 16 hex chars.

## Runtime and Control Flow
Caller-driven flow in this module:

1. Caller prepares metadata (or passes nothing).
2. Caller invokes `injectTraceContext(metadata?)`.
3. `injectTraceContext` first calls `extractTraceContext`.
4. If valid context is already present, `injectTraceContext` returns a shallow copy unchanged (idempotent behavior).
5. If context is absent or invalid, `injectTraceContext` creates a new context and writes `_trace.traceparent`.
6. Metadata can be serialized/deserialized (JSON-safe string payload).
7. Downstream caller invokes `extractTraceContext(metadata)` to recover `TraceContext` or `null`.

Parsing flow for `parseTraceparent(traceparent)`:

1. Split by `-`.
2. Require at least 4 parts.
3. Validate `traceId` as 32 lowercase hex chars.
4. Validate `spanId` as 16 lowercase hex chars.
5. Parse flags from hex to number.
6. Return structured `TraceContext` or `null` on validation failure.

## Key APIs and Types
`TraceContext`:
- `traceId: string` (expected 32 lowercase hex chars)
- `spanId: string` (expected 16 lowercase hex chars)
- `traceFlags: number` (hex flags parsed/serialized as numeric)

`formatTraceparent(ctx: TraceContext): string`:
- Produces `00-{traceId}-{spanId}-{flags}`.
- Uses `traceFlags.toString(16).padStart(2, '0')` for flags formatting.

`parseTraceparent(traceparent: string): TraceContext | null`:
- Defensive parser; returns `null` instead of throwing.
- Validates `traceId` and `spanId` shape/charset.

`injectTraceContext(metadata?: Record<string, unknown>): Record<string, unknown>`:
- Non-mutating: always returns a new object.
- Preserves other metadata fields.
- Preserves existing valid trace context.

`extractTraceContext(metadata?: Record<string, unknown>): TraceContext | null`:
- Returns `null` for missing/malformed metadata.
- Reads only `_trace.traceparent`.

## Dependencies
Direct runtime dependencies in telemetry code:
- Node built-in `node:crypto` (`randomUUID`).

No direct dependency on:
- `@opentelemetry/api`
- `@dzupagent/otel`
- other third-party runtime libraries

Package context (`packages/core/package.json`):
- telemetry relies only on platform/runtime primitives and is independent of package peer deps like `@langchain/core` and `zod`.

## Integration Points
Within `packages/core`, telemetry APIs are exposed through:
- `src/index.ts` root exports `injectTraceContext`, `extractTraceContext`, `formatTraceparent`, `parseTraceparent`, and the `TraceContext` type.
- `src/facades/orchestration.ts` re-exports of the same APIs/types.
- `src/facades/index.ts` namespace export exposes telemetry under the `orchestration` namespace.
- `src/stable.ts` facade-only entrypoint makes telemetry reachable indirectly through `facades.orchestration`.

Current in-package call sites:
- no production module in `packages/core/src` calls telemetry helpers directly
- usage is validated through focused unit tests and facade-surface tests

## Testing and Observability
Telemetry-specific tests:
- `src/__tests__/trace-propagation.test.ts`
- This test covers formatting/parsing success and failure paths.
- This test validates inject idempotency and immutability.
- This test validates JSON serialization round-trip safety.

Facade wiring tests:
- `src/__tests__/facade-orchestration.test.ts`
- This test verifies telemetry exports from the orchestration facade.
- This test checks inject/extract/format/parse behavior through facade imports.

Observability characteristics:
- module emits no logs, metrics, or events
- module provides data needed for correlation but does not perform instrumentation itself

## Risks and TODOs
- `parseTraceparent` currently accepts inputs with more than 4 hyphen-delimited parts (`parts.length < 4` check only), which is tolerant but not strict W3C validation.
- Parser does not enforce `version === '00'`; version is ignored.
- Parser does not enforce flags width of exactly 2 hex characters.
- `formatTraceparent` does not clamp `traceFlags` to one byte, so values above `0xff` produce longer-than-2-character flags.
- Only `traceparent` is modeled; `tracestate`/baggage propagation is not supported.
- Telemetry API has no dedicated subpath export (for example `@dzupagent/core/telemetry`); consumers import from root or orchestration facade.

## Changelog
- 2026-04-16: automated refresh via scripts/refresh-architecture-docs.js