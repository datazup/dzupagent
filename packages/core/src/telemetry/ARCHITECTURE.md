# Telemetry Architecture (`packages/core/src/telemetry`)

## Scope
This document covers the telemetry module in `@dzupagent/core` under `packages/core/src/telemetry`.

Files in scope:
- `src/telemetry/trace-propagation.ts`
- `src/telemetry/ARCHITECTURE.md`

Adjacent files reviewed to verify integration and publish surface:
- `src/index.ts`
- `src/utils.ts`
- `src/facades/orchestration.ts`
- `src/__tests__/trace-propagation.test.ts`
- `src/__tests__/facade-orchestration.test.ts`
- `package.json`
- `README.md`

Out of scope:
- OpenTelemetry SDK wiring or exporters
- Span lifecycle management
- Telemetry backends and dashboards

## Responsibilities
The telemetry module provides lightweight trace-context propagation helpers with no OpenTelemetry runtime coupling.

Current responsibilities:
- Define a serializable trace context contract (`TraceContext`).
- Generate `traceId` and `spanId` for metadata that does not yet carry valid trace context.
- Serialize trace context into a W3C-style `traceparent` value.
- Parse `traceparent` back into typed trace context.
- Inject trace context into `_trace.traceparent` on metadata.
- Extract and validate `_trace.traceparent` from metadata.

Non-responsibilities in the current implementation:
- Span creation/closing.
- Async context propagation across call stacks.
- Logging, metrics emission, or event publishing.
- Direct dependency on `@opentelemetry/api` or `@dzupagent/otel`.

## Structure
Telemetry is implemented as a single source module.

| File | Purpose | Public exports |
| --- | --- | --- |
| `trace-propagation.ts` | Trace context generation, parsing, serialization, metadata injection/extraction | `TraceContext`, `formatTraceparent`, `parseTraceparent`, `injectTraceContext`, `extractTraceContext` |

Notable internal details:
- Private metadata key constant: `TRACE_KEY = '_trace'`.
- `generateTraceId()` uses `randomUUID().replace(/-/g, '')` for a 32-char lowercase hex trace ID.
- `generateSpanId()` uses `randomUUID().replace(/-/g, '').slice(0, 16)` for a 16-char lowercase hex span ID.

## Runtime and Control Flow
Primary injection path (`injectTraceContext`):
1. Accepts optional metadata (`Record<string, unknown>`), defaulting to `{}`.
2. Calls `extractTraceContext(metadata)`.
3. If an existing valid trace exists, returns a shallow copy of metadata unchanged.
4. Otherwise generates a new `TraceContext` with `traceFlags: 1`.
5. Returns a new metadata object that includes `_trace.traceparent` produced by `formatTraceparent`.

Primary extraction path (`extractTraceContext`):
1. Returns `null` when metadata is absent.
2. Reads `metadata._trace`; requires it to be an object.
3. Reads `_trace.traceparent`; requires it to be a string.
4. Delegates to `parseTraceparent`; returns parsed context or `null`.

`parseTraceparent` flow:
1. Splits input by `-`.
2. Requires at least 4 segments.
3. Uses segments `[1]`, `[2]`, `[3]` as `traceId`, `spanId`, and flags.
4. Validates `traceId` (`32` lowercase hex) and `spanId` (`16` lowercase hex).
5. Parses flags via `parseInt(flagsHex, 16)` and rejects `NaN`.
6. Returns `TraceContext` on success, `null` otherwise.

Error behavior is fail-soft (`null`), not exception-based.

## Key APIs and Types
`TraceContext`:
- `traceId: string`
- `spanId: string`
- `traceFlags: number`

`formatTraceparent(ctx: TraceContext): string`:
- Formats as `00-{traceId}-{spanId}-{flags}`.
- Flags are padded with `toString(16).padStart(2, '0')`.

`parseTraceparent(traceparent: string): TraceContext | null`:
- Parses and validates ID shapes and flag parseability.
- Returns `null` on malformed inputs.

`injectTraceContext(metadata?: Record<string, unknown>): Record<string, unknown>`:
- Idempotent for already-valid `_trace.traceparent`.
- Preserves existing fields.
- Returns a new object rather than mutating input.

`extractTraceContext(metadata?: Record<string, unknown>): TraceContext | null`:
- Reads only `_trace.traceparent`.
- Returns `null` for absent/invalid structures.

## Dependencies
Runtime dependency of this module:
- Node built-in `node:crypto` (`randomUUID`).

Package-level dependency context:
- No telemetry-specific external npm package is required for this module.
- `@dzupagent/core` package dependencies are broader, but trace propagation is intentionally standalone.

## Integration Points
Export and consumption surfaces in `@dzupagent/core`:
- Main barrel re-export in `src/index.ts`.
- Utility facade re-export in `src/utils.ts`.
- Orchestration facade re-export in `src/facades/orchestration.ts`.

Published entry points from `package.json` exports:
- `@dzupagent/core` (via `.`) includes telemetry helpers through the main barrel.
- `@dzupagent/core/utils` includes telemetry helpers through the utils facade.
- `@dzupagent/core/orchestration` includes telemetry helpers through orchestration facade.

Current in-package call sites:
- No non-test runtime module in `packages/core/src` currently invokes these telemetry helpers directly.
- The module is presently an exported utility used through external consumers and validated by tests.

## Testing and Observability
Tests covering telemetry module behavior:
- `src/__tests__/trace-propagation.test.ts` covers formatting/parsing and round-trip behavior.
- `src/__tests__/trace-propagation.test.ts` covers malformed input handling.
- `src/__tests__/trace-propagation.test.ts` covers metadata immutability and idempotency.
- `src/__tests__/trace-propagation.test.ts` covers generated trace value shape and uniqueness.
- `src/__tests__/trace-propagation.test.ts` covers JSON serialization round-trip scenario.
- `src/__tests__/facade-orchestration.test.ts` verifies telemetry helpers through the `orchestration` facade export surface.

Observability behavior of this module itself:
- No logs, metrics, or events emitted.
- Designed as trace-context payload utility for callers that implement observability pipelines.

## Risks and TODOs
Current limitations visible from code/tests:
- `parseTraceparent` accepts strings with more than 4 segments (`parts.length < 4` guard only).
- The traceparent version segment is not validated beyond position.
- Trace flag parsing accepts variable-length hex and does not enforce one-byte bounds.
- `formatTraceparent` does not clamp `traceFlags` to `0x00..0xff`.
- Only `traceparent` is modeled; no `tracestate` or baggage support.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

