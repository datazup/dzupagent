# @dzupagent/otel Architecture

## Scope
`@dzupagent/otel` is the observability package for DzupAgent runtimes. In this package, observability means:
- tracing helpers (`DzupTracer`, `ForgeSpanAttr`, trace context store)
- event-to-metric translation (`OTelBridge` + `EVENT_METRIC_MAP` fragments)
- in-process governance telemetry (`CostAttributor`, `SafetyMonitor`)
- tamper-evident event audit logging (`AuditTrail` + `InMemoryAuditStore`)
- plugin-based wiring into `@dzupagent/core` (`createOTelPlugin`)

The package is designed to run even when OpenTelemetry SDK packages are absent. All OTel SDK dependencies are optional peers, and the runtime defaults to no-op tracer behavior unless an external tracer is provided.

## Responsibilities
Primary responsibilities implemented in `src/`:
- expose a minimal OTel-compatible API surface (`otel-types.ts`, `noop.ts`) so the package can operate without hard runtime coupling to OTel SDK packages
- provide domain-focused span helpers for agent, LLM, tool, memory, and pipeline operations (`tracer.ts`)
- propagate app-level correlation context through async flows (`trace-context-store.ts`)
- map `DzupEvent` stream events to counter/histogram/gauge metrics (`event-metric-map*.ts` + `otel-bridge.ts`)
- attach cost, safety, and audit listeners to the same `DzupEventBus`
- offer a single plugin factory that wires selected capabilities at registration time (`otel-plugin.ts`)

Out of scope for this package:
- exporter configuration, collector wiring, and backend-specific telemetry pipelines
- durable production storage implementations for audit data (only in-memory store is provided here)
- hard enforcement or blocking of unsafe actions (safety detection is non-blocking)

## Structure
Top-level source modules:
- `src/index.ts`: public export surface (classes, functions, types, constants)
- `src/otel-types.ts`: minimal tracer/span/context interfaces + `SpanStatusCode`/`SpanKind`
- `src/noop.ts`: `NoopTracer`/`NoopSpan` fallback implementations
- `src/span-attributes.ts`: standardized attribute keys (`forge.*`, `gen_ai.*`)
- `src/trace-context-store.ts`: `AsyncLocalStorage` context (`withForgeContext`, `currentForgeContext`)
- `src/tracer.ts`: `DzupTracer` helper for span creation and trace header inject/extract
- `src/otel-bridge.ts`: event bus subscriber that emits metrics and selected span events
- `src/event-metric-map.ts`: composed `EVENT_METRIC_MAP` and metric name enumeration
- `src/event-metric-map/*.ts`: domain-specific metric fragments (`agent-lifecycle`, `tool-lifecycle`, `budget`, `delegation`, `execution-ledger`, `flow-compile`, `governance`, `memory-*`, `pipeline-*`, `platform-*`, `scheduler`, `skill-lifecycle`, `supervisor`, `telemetry`, `vector`, `workflow-domain`, `empty-events`)
- `src/cost-attribution.ts`: in-memory cost/token aggregation + threshold event emission
- `src/safety-monitor.ts`: regex-based safety signal detection and tool-failure streak tracking
- `src/audit-trail.ts`: hash-chain audit entry generation + query/verification helpers
- `src/vector-metrics.ts`: standalone vector metrics collector/report helper
- `src/otel-plugin.ts`: plugin factory that conditionally attaches all above components

Build/test/config files:
- `package.json`: workspace package metadata, scripts, dependency contract
- `tsup.config.ts`: ESM bundle output from `src/index.ts`
- `vitest.config.ts`: node test environment and coverage thresholds
- `README.md`: usage and API narrative documentation

## Runtime and Control Flow
1. Host app creates and registers plugin:
- `createOTelPlugin(config)` returns a `DzupPlugin` with `name: '@dzupagent/otel'`.
- `onRegister(ctx)` conditionally creates and attaches components based on config flags.

2. Event wiring happens through `DzupEventBus`:
- `OTelBridge.attach(eventBus)` subscribes with `onAny`.
- For each event, bridge checks `ignoreEvents`, records mapped metrics, and optionally emits a small set of span events (`agent:started`, `agent:failed`, `tool:error`, `provider:circuit_opened`).
- Bridge failures are swallowed to keep instrumentation non-fatal.

3. Metric generation path:
- `EVENT_METRIC_MAP[event.type]` returns mapping rules.
- each rule’s `extract(event)` produces `{ value, labels }`.
- sink receives `increment`, `observe`, or `gauge` calls.
- default sink is `InMemoryMetricSink` (counters, histograms as arrays, gauges).

4. Tracing path:
- `DzupTracer` starts domain spans with prefilled semantic attributes.
- `endSpanOk` / `endSpanWithError` set status and end spans.
- `inject`/`extract` move W3C `traceparent` and `baggage` through string carriers.

5. Context propagation path:
- `withForgeContext(ctx, fn)` runs code in merged `AsyncLocalStorage` context.
- `currentForgeContext()` reads active correlation context for downstream code.

6. Governance telemetry:
- `CostAttributor` tracks in-memory entries and emits `budget:warning` / `budget:exceeded` on threshold crossings.
- `SafetyMonitor` scans tool input payloads and tracks repeated `tool:error` events.
- `AuditTrail` maps selected events into category/action/details entries and appends hash-chained records to store.

## Key APIs and Types
Main exported runtime APIs from `src/index.ts`:
- tracing/context:
  - `DzupTracer`, `ForgeSpanAttr`, `withForgeContext`, `currentForgeContext`, `forgeContextStore`
  - types: `DzupTracerConfig`, `ForgeTraceSnapshot`, `ForgeTraceContext`, `ForgeSpanAttrKey`
- OTel compatibility primitives:
  - `OTelSpan`, `OTelTracer`, `OTelSpanOptions`, `OTelContext`
  - `SpanStatusCode`, `SpanKind`
  - `NoopSpan`, `NoopTracer`
- metrics bridge:
  - `OTelBridge`, `InMemoryMetricSink`, `EVENT_METRIC_MAP`, `getAllMetricNames`
  - types: `OTelBridgeConfig`, `MetricSink`, `MetricMapping`
- governance and audit:
  - `CostAttributor`, `SafetyMonitor`, `AuditTrail`, `InMemoryAuditStore`, `VectorMetricsCollector`
  - types: `CostEntry`, `CostReport`, `CostAlertThreshold`, `CostAttributorConfig`, `SafetyCategory`, `SafetySeverity`, `SafetyEvent`, `SafetyPatternRule`, `SafetyMonitorConfig`, `AuditCategory`, `AuditEntry`, `AuditStore`, `AuditTrailConfig`, `VectorMetrics`, `VectorMetricsReport`
- plugin:
  - `createOTelPlugin`
  - type: `OTelPluginConfig`

Current version constants in code:
- `src/index.ts`: `dzupagent_OTEL_VERSION = '0.1.0'`
- `src/otel-plugin.ts`: plugin `version: '0.1.0'`

## Dependencies
Package-level runtime dependency:
- `@dzupagent/core` (`0.2.0`): event bus types/runtime and plugin interfaces

Optional peer dependencies (consumer-provided):
- `@opentelemetry/api`
- `@opentelemetry/sdk-metrics`
- `@opentelemetry/sdk-trace-base`

Node built-ins used directly:
- `node:async_hooks` (`AsyncLocalStorage` for context propagation)
- `node:crypto` (`createHash`, `randomUUID` for audit chaining and IDs)

Build/test toolchain in this package:
- `tsup` (ESM bundle + d.ts generation)
- `typescript` (strict TS compilation)
- `vitest` (unit/integration tests + coverage)

## Integration Points
How this package integrates with the rest of DzupAgent:
- event source contract: consumes `DzupEventBus` and `DzupEvent` from `@dzupagent/core`
- plugin lifecycle: consumed via `PluginRegistry` / plugin registration in hosts using `@dzupagent/core`
- event taxonomy coupling: `EVENT_METRIC_MAP` is exhaustive over `DzupEvent['type']` through `satisfies Record<...>`; changes in core event types require map updates in this package
- optional tracer coupling: if consumer provides an OTel tracer-compatible object, `DzupTracer` wraps it; otherwise no-op tracer is used
- external metric export: `MetricSink` abstraction allows replacing `InMemoryMetricSink` with a sink that forwards to an exporter/backend
- audit persistence extension: `AuditStore` interface is the extension point for persistent storage beyond `InMemoryAuditStore`

## Testing and Observability
Test posture in `src/__tests__`:
- broad unit and integration coverage for bridge, metric map, tracer, context store, cost attribution, safety monitor, audit trail, plugin wiring, vector metrics, and deeper branch scenarios
- notable test modules include:
  - `event-metric-map*.test.ts` and `execution-ledger-metrics.test.ts`
  - `otel-bridge*.test.ts` and `otel-bridge.integration.test.ts`
  - `tracer*.test.ts`, `trace-context-store.test.ts`
  - `cost-attribution*.test.ts`, `safety-monitor*.test.ts`, `audit-trail.test.ts`

Package validation scripts (`package.json`):
- `yarn workspace @dzupagent/otel build`
- `yarn workspace @dzupagent/otel typecheck`
- `yarn workspace @dzupagent/otel lint`
- `yarn workspace @dzupagent/otel test`
- `yarn workspace @dzupagent/otel test:coverage`

Coverage configuration (`vitest.config.ts`):
- provider: `v8`
- thresholds: statements 90, branches 90, functions 80, lines 90

Operational observability traits of the package itself:
- instrumentation paths are intentionally fail-soft (exceptions in bridge/safety/audit listeners are swallowed)
- `InMemoryMetricSink`, `CostAttributor`, `SafetyMonitor`, and `InMemoryAuditStore` expose in-memory query/report methods suited for tests and local inspection

## Risks and TODOs
Current code-level risks and drift to track:
- version drift across package surfaces:
  - `package.json` is `0.2.0`, while exported constant and plugin version are `0.1.0`
  - README also documents different version values
- documentation/runtime mismatch in a few areas:
  - `SafetyMonitor.attach` comment says `tool:result` scans output, but implementation resets failure counters only
  - `AuditTrail.verifyChain` JSDoc says it can load entries when omitted, but method verifies only provided entries and returns valid for empty/undefined input
  - `tracer.ts` class comment references callback/context lifecycle behavior not present in current methods
- memory growth risk in long-lived processes:
  - `InMemoryMetricSink` stores histogram samples in unbounded arrays
  - `AuditTrail` default store is in-memory; retention pruning only runs every 100 appended entries
- governance signal limitations:
  - `CostAttributor.attach` currently records zero-cost placeholder entries from `agent:completed` and `tool:result`, so accurate cost/token reporting requires explicit `record()` integration from real usage sources
  - warning/exceeded state is shared across cost and token thresholds, so one dimension can suppress first-time emission in the other dimension
- audit taxonomy gap:
  - `AuditCategory` includes `safety_event` and `config_change`, but current `mapEvent` does not emit those categories

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js

