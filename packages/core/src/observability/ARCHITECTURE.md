# Observability Architecture (`packages/core/src/observability`)

## Scope
This document describes the in-process observability primitives implemented in `packages/core/src/observability`.

Included source files:
- `metrics-collector.ts`
- `health-aggregator.ts`
- `index.ts`

Included package surfaces that expose these primitives:
- `packages/core/src/index.ts` (`@dzupagent/core`)
- `packages/core/src/facades/orchestration.ts` (`@dzupagent/core/orchestration`)
- `packages/core/src/utils.ts` (`@dzupagent/core/utils`)

Explicitly out of scope:
- HTTP endpoint wiring for `/health` or `/metrics`
- Prometheus text exposition formatting/export pipelines
- OpenTelemetry SDK setup/exporters
- External alerting/dashboard integrations

## Responsibilities
`src/observability` provides two lightweight runtime building blocks:
- A mutable in-memory metric registry (`MetricsCollector` and the `globalMetrics` singleton).
- A composable health check runner that aggregates async subsystem checks (`HealthAggregator`).

Behavior implemented today:
- Store metrics by `(name + normalized labels)` key.
- Support counter-style increment, gauge assignment, and histogram-like observation accumulation.
- Provide point lookup (`get`) and snapshot/reset utilities (`toJSON`, `reset`).
- Execute health checks concurrently with `Promise.allSettled`.
- Convert rejected checks into synthetic error entries so one failing check does not abort the full health report.
- Return aggregate status plus per-check details, report timestamp, and process uptime since aggregator creation.

## Structure
| File | Role | Exports |
| --- | --- | --- |
| `metrics-collector.ts` | In-memory metric storage and mutation | `MetricType`, `MetricsCollector`, `globalMetrics` |
| `health-aggregator.ts` | Health check registration and aggregation | `HealthStatus`, `HealthCheck`, `HealthReport`, `HealthCheckFn`, `HealthAggregator` |
| `index.ts` | Local module barrel | re-exports both modules |

Key internal data structures:
- `MetricsCollector` uses `Map<string, MetricEntry>` where keys are formatted via a private `key(name, labels)` helper.
- `MetricEntry` stores `name`, `type`, `labels`, `value`, plus optional `sum`/`count`/`buckets`.
- `HealthAggregator` stores an array of `HealthCheckFn` plus `startTime` for uptime computation.

## Runtime and Control Flow
Metrics path:
1. Caller invokes `increment`, `gauge`, or `observe`.
2. Collector computes a canonical key:
   - No labels: key is `name`.
   - With labels: labels are key-sorted, then formatted as `name{k="v",...}`.
3. Collector updates existing map entry or creates a new one.
4. Snapshot consumers call `toJSON()` to read all entries, or `get(name, labels)` for one value.
5. `reset()` clears the map.

Current write semantics:
- `increment`: adds `amount` (default `1`) to `value`.
- `gauge`: sets `value` to absolute value.
- `observe`: sets `value` to last sample and accumulates `sum` and `count`.

Health path:
1. Callers register checks with `register(checkFn)`.
2. `check()` executes all registered checks with `Promise.allSettled`.
3. Fulfilled promises are used as-is.
4. Rejected promises are converted to `{ name: "check-<index>", status: "error", message }`.
5. Aggregate status reduction:
   - any `error` -> report `error`
   - else any `degraded` -> report `degraded`
   - else -> report `ok`
6. `check()` returns `{ status, checks, timestamp, uptime }`.

## Key APIs and Types
From `metrics-collector.ts`:
- `type MetricType = 'counter' | 'gauge' | 'histogram'`
- `class MetricsCollector`
- `increment(name: string, labels?: Record<string, string>, amount?: number): void`
- `gauge(name: string, value: number, labels?: Record<string, string>): void`
- `observe(name: string, value: number, labels?: Record<string, string>): void`
- `get(name: string, labels?: Record<string, string>): number | undefined`
- `toJSON(): Record<string, unknown>[]`
- `reset(): void`
- `const globalMetrics = new MetricsCollector()`

From `health-aggregator.ts`:
- `type HealthStatus = 'ok' | 'degraded' | 'error' | 'unconfigured'`
- `interface HealthCheck`
- `interface HealthReport`
- `type HealthCheckFn = () => Promise<HealthCheck>`
- `class HealthAggregator`
- `register(checkFn: HealthCheckFn): void`
- `check(): Promise<HealthReport>`

From `index.ts`:
- Pure barrel re-exports of the symbols above (no additional behavior).

## Dependencies
Direct runtime dependencies inside `src/observability/*`:
- None outside language/runtime primitives (`Map`, `Date`, `Promise`).

Package-level context:
- `@dzupagent/core` declares dependencies on `@dzupagent/agent-types`, `@dzupagent/runtime-contracts`, and `@dzupagent/security`, but observability code does not import them.
- `src/observability` also does not import optional peer deps (`zod`, `@langchain/*`, tokenizer/vector packages).

## Integration Points
How consumers get observability APIs:
- Root surface: `@dzupagent/core` via `src/index.ts`.
- Orchestration facade: `@dzupagent/core/orchestration`.
- Utils facade: `@dzupagent/core/utils`.
- Local module imports inside package internals can use `src/observability/index.ts`.

Packaging details relevant to this module:
- `package.json` does not define a dedicated `./observability` export.
- `tsup.config.ts` does not include `src/observability/index.ts` as a standalone build entry.
- As a result, public consumption is through the root/facade entrypoints, not a direct observability subpath.

Current in-repo wiring:
- No non-observability runtime module in `packages/core/src` imports `observability` for active behavior.
- Integration today is export-surface availability rather than deep internal coupling.

## Testing and Observability
Tests touching this module:
- `packages/core/src/__tests__/facades.test.ts`
  - verifies orchestration facade exports include `MetricsCollector` and `HealthAggregator`.
- `packages/core/src/__tests__/facade-orchestration.test.ts`
  - behavior tests for `HealthAggregator` (`ok`, `degraded`, `error`, thrown-check handling).
- `packages/core/src/__tests__/w15-b1-facades.test.ts`
  - includes `HealthAggregator` through orchestration facade in broader facade smoke/behavior coverage.

Current coverage gaps:
- No focused unit tests for `MetricsCollector` mutation/read/reset behavior.
- No test asserting label canonicalization (`{a:1,b:2}` equals `{b:2,a:1}` keying).
- No test coverage for `globalMetrics` singleton lifecycle/reset expectations.
- No direct test for `HealthStatus = 'unconfigured'` handling in aggregation logic.

## Risks and TODOs
- Metric-type drift risk: the same key can be mutated through different write methods (`increment` then `observe`) without guardrails.
- Histogram is partial: `observe` tracks `sum` and `count`, but bucket boundaries/distribution are not populated or exported.
- `MetricEntry.help` and `MetricEntry.buckets` fields exist but are not set through public APIs.
- `HealthStatus` includes `'unconfigured'`, but aggregate reduction currently treats it like `'ok'`.
- Empty-check behavior returns overall `'ok'`; some deployments may prefer `'unconfigured'` or `'degraded'`.
- `globalMetrics` is process-global mutable state and can leak across long-running contexts/tests if callers do not reset.
- `HealthAggregator` has append-only registration; no unregister or timeout/cancellation controls are built in.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js