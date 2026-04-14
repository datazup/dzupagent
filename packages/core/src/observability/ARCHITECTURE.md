# Observability Module Architecture

## Scope
This document describes `packages/core/src/observability`, which currently provides:

- `MetricsCollector` + `globalMetrics` (lightweight in-memory metrics primitives)
- `HealthAggregator` (async subsystem health aggregation)
- A barrel export (`index.ts`)

The module is intentionally minimal and dependency-free. It is used as a base observability contract for other packages, especially `@dzupagent/server`.

## Source Layout

- `metrics-collector.ts`: in-memory counter/gauge/histogram collector
- `health-aggregator.ts`: registration and aggregation of async health checks
- `index.ts`: re-exports module surface

## Public API Surface

### Metrics

- `MetricType = 'counter' | 'gauge' | 'histogram'`
- `class MetricsCollector`
  - `increment(name, labels?, amount = 1): void`
  - `gauge(name, value, labels?): void`
  - `observe(name, value, labels?): void`
  - `toJSON(): Record<string, unknown>[]`
  - `get(name, labels?): number | undefined`
  - `reset(): void`
- `globalMetrics: MetricsCollector` (singleton instance)

### Health

- `HealthStatus = 'ok' | 'degraded' | 'error' | 'unconfigured'`
- `interface HealthCheck`
- `interface HealthReport`
- `type HealthCheckFn = () => Promise<HealthCheck>`
- `class HealthAggregator`
  - `register(checkFn): void`
  - `check(): Promise<HealthReport>`

## Feature Breakdown

### 1) MetricsCollector features

- Supports three write patterns:
  - counter increments (`increment`)
  - gauge absolute set (`gauge`)
  - histogram-like observations (`observe`, tracked as `sum` + `count` + last value)
- Label canonicalization:
  - labels are sorted by key before forming the storage key, so `{a:1,b:2}` and `{b:2,a:1}` map to the same series.
- Fast lookup and updates:
  - internal `Map<string, MetricEntry>` keyed by `name + normalized labels`.
- Export/snapshot methods:
  - `toJSON()` for API/debug output
  - `get()` for direct point lookups
  - `reset()` for test isolation or process lifecycle reset
- Shared singleton:
  - `globalMetrics` available for low-friction instrumentation when DI is not used.

### 2) HealthAggregator features

- Pluggable health checks:
  - checks are async functions registered via `register`.
- Fault-isolated execution:
  - executes all checks via `Promise.allSettled`, so one throwing check does not abort the report.
- Deterministic error normalization:
  - rejected checks are converted to synthetic `HealthCheck` entries with `status: 'error'` and a fallback name (`check-<index>`).
- Aggregate status computation:
  - overall status precedence is `error` > `degraded` > `ok`.
  - uptime and ISO timestamp are always included.

## Runtime Flow

### Metrics flow

1. Caller invokes `increment/gauge/observe`.
2. Collector derives deterministic series key from metric name + sorted labels.
3. Collector updates in-memory series entry.
4. Consumer reads:
   - via `get()` for single value
   - via `toJSON()` for list snapshot
   - via subclass adapters (for example Prometheus rendering in `@dzupagent/server`).

### Health flow

1. Subsystems register check callbacks once during startup.
2. Caller invokes `HealthAggregator.check()`.
3. All checks execute concurrently via `Promise.allSettled`.
4. Rejections are normalized into error checks.
5. Aggregate status is derived and report is emitted with `checks`, `timestamp`, and `uptime`.

## Cross-Package References and Usage

## Primary consumers

| Package/File | Usage |
|---|---|
| `packages/server/src/app.ts` | Accepts optional `metrics` collector in server config; records HTTP request count/latency and error counters; mounts `/metrics` route when collector is Prometheus-capable. |
| `packages/server/src/services/eval-orchestrator.ts` | Uses `MetricsCollector` for eval queue counters (`enqueued`, `started`, `completed`, etc.), wait-time histogram, and queue state gauges. |
| `packages/server/src/routes/evals.ts` | Accepts optional `metrics` in route config and passes it into `EvalOrchestrator`. |
| `packages/server/src/runtime/run-worker.ts` | Emits run completion counter and run duration observation (`forge_run_*`). |
| `packages/server/src/metrics/prometheus-collector.ts` | Extends `MetricsCollector` to expose Prometheus text rendering (`render()`), keeping parent JSON/get/reset compatibility. |

## Export surfaces

| Package/File | Usage |
|---|---|
| `packages/core/src/index.ts` | Re-exports observability primitives from the package root (`@dzupagent/core`). |
| `packages/core/src/facades/orchestration.ts` | Re-exports observability primitives in facade-oriented API tier. |

## Current adoption notes

- `MetricsCollector` is actively used in `@dzupagent/server` runtime and tests.
- `HealthAggregator` is exported but currently has no direct runtime consumer outside `@dzupagent/core` exports.
- `globalMetrics` is exported but currently has no internal package references beyond export wiring.

## Usage Examples

### Basic metrics in any package

```ts
import { MetricsCollector } from '@dzupagent/core'

const metrics = new MetricsCollector()

metrics.increment('http_requests_total', { method: 'GET', path: '/api/runs', status: '200' })
metrics.observe('http_request_duration_ms', 42, { method: 'GET', path: '/api/runs' })
metrics.gauge('queue_depth', 3)

console.log(metrics.get('queue_depth')) // 3
console.log(metrics.toJSON())
```

### Health aggregation for subsystem probes

```ts
import { HealthAggregator } from '@dzupagent/core'

const health = new HealthAggregator()

health.register(async () => ({ name: 'database', status: 'ok', latencyMs: 8 }))
health.register(async () => ({ name: 'redis', status: 'degraded', message: 'High latency' }))

const report = await health.check()
// report.status === 'degraded'
// report.checks contains both entries plus timestamp/uptime metadata
```

### Server-level integration (current production path)

```ts
import { createForgeApp, PrometheusMetricsCollector } from '@dzupagent/server'

const metrics = new PrometheusMetricsCollector()
const app = createForgeApp({
  // ... required config
  metrics,
})

// app now emits http/eval/run metrics and exposes /metrics
```

## Test Coverage Analysis

## Direct coverage in `@dzupagent/core`

| Behavior | Evidence | Coverage status |
|---|---|---|
| Export availability (`MetricsCollector`, `HealthAggregator`) | `packages/core/src/__tests__/facades.test.ts` | Covered (export wiring only) |
| Metrics behavior correctness (counter/gauge/observe/keying/reset) | No dedicated tests in `packages/core/src/__tests__` | Not covered directly |
| HealthAggregator behavior (allSettled handling, status precedence, uptime/timestamp) | No dedicated tests in `packages/core/src/__tests__` | Not covered directly |

## Indirect coverage via `@dzupagent/server`

| Behavior | Evidence | Coverage status |
|---|---|---|
| Parent collector compatibility (`toJSON`, `get`, `reset`) under subclass usage | `packages/server/src/__tests__/prometheus-collector.test.ts` | Covered indirectly |
| Label normalization and multi-series rendering in Prometheus collector | `packages/server/src/__tests__/prometheus-collector.test.ts` | Covered in subclass context |
| Eval queue metric counters/gauges/histogram plumbing | `packages/server/src/__tests__/eval-routes.test.ts`, `packages/server/src/__tests__/app-evals-metrics.test.ts` | Covered for eval flow |
| HTTP middleware metrics and `/metrics` route wiring in app factory | No dedicated assertions found | Partial gap |
| Run worker `forge_run_completed_total` / `forge_run_duration_ms` emissions | No dedicated assertions found | Gap |

## High-value test additions

1. Add `packages/core/src/__tests__/metrics-collector.test.ts`:
   - counter increments with and without labels
   - label-order canonicalization
   - gauge overwrite semantics
   - histogram `sum/count/last-value` expectations
   - `reset()` and `toJSON()` shape checks
2. Add `packages/core/src/__tests__/health-aggregator.test.ts`:
   - all checks `ok`
   - mixed `degraded` + `ok`
   - thrown/rejected checks converted to `error`
   - precedence (`error` over `degraded`)
   - timestamp and uptime shape assertions
3. Add targeted server tests for:
   - HTTP request/error metric middleware increments
   - `/metrics` route mounting behavior in `createForgeApp`
   - run-worker completion metrics.

## Design Characteristics and Caveats

- `MetricsCollector.observe()` stores aggregate `sum/count` and the latest observed value, but does not keep bucket distribution in core.
- `MetricEntry.help` and `MetricEntry.buckets` are defined in core but not populated by current core methods.
- Metric name/type collisions are not validated. Reusing a metric name across different semantic types can create mixed semantics in the same entry.
- `HealthStatus` includes `'unconfigured'`, but aggregate reduction currently only promotes `'error'` and `'degraded'`; `'unconfigured'` does not currently influence overall status.

## Summary

`src/observability` provides a small, stable abstraction layer for metrics and health checks, with real runtime usage concentrated in `@dzupagent/server` for request/eval/run instrumentation and Prometheus exposure. The core API surface is lightweight and useful, but direct unit coverage inside `@dzupagent/core` is currently thin, especially for `HealthAggregator` behavior and core `MetricsCollector` invariants.
