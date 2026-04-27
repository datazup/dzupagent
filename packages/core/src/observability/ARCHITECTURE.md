# Observability Architecture

## Scope
This document covers `packages/core/src/observability` in `@dzupagent/core`.

The scope is intentionally narrow and includes only:
- In-memory metric collection (`MetricsCollector`, `globalMetrics`)
- Async health check aggregation (`HealthAggregator`)
- Module-level re-exports from `src/observability/index.ts`

It does not include:
- Prometheus formatting/rendering (implemented in `@dzupagent/server`)
- OpenTelemetry SDK integration (not present in this module)
- HTTP health route wiring (implemented outside `packages/core/src/observability`)

## Responsibilities
The observability module provides lightweight primitives that other runtime layers can compose:
- Capture process-local counters, gauges, and histogram-like observations without external dependencies.
- Provide deterministic metric series keying by metric name + sorted labels.
- Expose snapshot/read/reset APIs for tests, diagnostics, and bridge adapters.
- Aggregate subsystem health checks concurrently and return one normalized report with status, checks, timestamp, and uptime.
- Isolate individual health-check failures so one rejected check does not abort reporting.

## Structure
Source files:
- `metrics-collector.ts`
- `health-aggregator.ts`
- `index.ts`

Primary exports:
- `MetricsCollector`, `globalMetrics`, `MetricType`
- `HealthAggregator`, `HealthStatus`, `HealthCheck`, `HealthReport`, `HealthCheckFn`

Re-export surfaces inside `@dzupagent/core`:
- Root barrel: `src/index.ts`
- Orchestration facade: `src/facades/orchestration.ts`
- Local barrel: `src/observability/index.ts`

## Runtime and Control Flow
Metrics flow (`MetricsCollector`):
1. Caller invokes `increment`, `gauge`, or `observe`.
2. Collector builds a series key via `key(name, labels)` where label entries are sorted lexicographically by label name.
3. Collector updates (or creates) a `Map<string, MetricEntry>` entry.
4. Consumers read current values via `get(name, labels)` or bulk snapshots via `toJSON()`.
5. State can be cleared with `reset()` (used for lifecycle/test isolation).

Health flow (`HealthAggregator`):
1. Subsystems register async checks with `register(checkFn)`.
2. `check()` executes all registered checks with `Promise.allSettled`.
3. Rejected checks are normalized to synthetic `HealthCheck` entries:
   - `name: check-<index>`
   - `status: 'error'`
   - `message` derived from rejection reason.
4. Aggregation reduces statuses with precedence:
   - `error` wins immediately
   - otherwise any `degraded` yields `degraded`
   - otherwise `ok`
5. Returned `HealthReport` includes `checks`, `timestamp` (`ISO string`), and `uptime` (`Date.now() - startTime`).

## Key APIs and Types
`metrics-collector.ts`:
- `type MetricType = 'counter' | 'gauge' | 'histogram'`
- `class MetricsCollector`
- `increment(name: string, labels?: Record<string, string>, amount = 1): void`
- `gauge(name: string, value: number, labels?: Record<string, string>): void`
- `observe(name: string, value: number, labels?: Record<string, string>): void`
- `toJSON(): Record<string, unknown>[]`
- `get(name: string, labels?: Record<string, string>): number | undefined`
- `reset(): void`
- `globalMetrics: MetricsCollector`

Behavioral notes:
- `increment` accumulates `value`.
- `gauge` overwrites `value`.
- `observe` tracks histogram-like fields (`sum`, `count`) and stores the last sample in `value`.
- Internally, metric entries also carry `help` and optional `buckets`, but current write APIs do not populate these fields.

`health-aggregator.ts`:
- `type HealthStatus = 'ok' | 'degraded' | 'error' | 'unconfigured'`
- `interface HealthCheck { name; status; latencyMs?; message?; metadata? }`
- `interface HealthReport { status; checks; timestamp; uptime }`
- `type HealthCheckFn = () => Promise<HealthCheck>`
- `class HealthAggregator`
- `register(checkFn: HealthCheckFn): void`
- `check(): Promise<HealthReport>`

## Dependencies
Direct runtime dependencies for this module:
- None (no imports from external packages or other internal modules).

Package-level context (`packages/core/package.json`):
- `@dzupagent/core` depends on `@dzupagent/agent-types` and `@dzupagent/runtime-contracts`, but observability files themselves do not consume them.
- No observability-specific peer dependency is required by this module.

## Integration Points
Within `@dzupagent/core`:
- Root package consumers can import observability APIs from `@dzupagent/core` via `src/index.ts` re-exports.
- Orchestration-focused consumers can import the same APIs from `@dzupagent/core/orchestration` via facade re-exports.

Cross-package usage in the monorepo:
- `@dzupagent/server` consumes `MetricsCollector` as a base collector type in routing/runtime services.
- `packages/server/src/metrics/prometheus-collector.ts` extends `MetricsCollector` to add Prometheus text rendering.
- Server runtime paths (`eval` orchestration, run worker, metrics route wiring) use the collector abstraction passed through server composition types.

Current usage gap:
- No direct runtime consumers of `HealthAggregator` were found outside core test/facade coverage.
- `globalMetrics` is exported but has no direct in-repo usage references under `packages/core/src`.

## Testing and Observability
Core tests covering this module today:
- `src/__tests__/facades.test.ts`
  - Verifies observability exports (`MetricsCollector`, `HealthAggregator`) are reachable from `facades/orchestration`.
- `src/__tests__/facade-orchestration.test.ts`
  - Includes behavioral tests for `HealthAggregator` (`ok`, `degraded`, `error`, thrown check handling).

Coverage gap in core:
- No dedicated tests for `MetricsCollector` behavior (counter/gauge/observe semantics, label canonicalization, reset behavior, `toJSON` output shape).

Indirect server-side validation:
- Server tests validate `MetricsCollector` usage through eval metrics and Prometheus collector integration.

## Risks and TODOs
- `MetricsCollector` does not enforce metric-type consistency per name+labels series. Mixed write patterns can change semantics without explicit guardrails.
- `observe` models histogram-like aggregates with `sum/count/last value`, but no bucket distribution is produced in core.
- `MetricEntry.help` and `MetricEntry.buckets` exist structurally but are not written by public APIs.
- `HealthStatus` includes `'unconfigured'`, but aggregate status reduction in `check()` only escalates on `'error'` and `'degraded'`.
- `HealthAggregator.check()` returns `'ok'` when no checks are registered; if "no checks" should be treated differently, this must be handled by caller policy or a module change.
- `globalMetrics` is process-local singleton state; careless shared usage can create cross-test leakage unless `reset()` is called.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js