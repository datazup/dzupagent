# @dzupagent/otel Architecture

## Scope
`@dzupagent/otel` is a DzupAgent observability package that instruments `@dzupagent/core` event flows. The package scope in `packages/otel/src` covers:
- tracing helpers and semantic attributes (`DzupTracer`, `ForgeSpanAttr`, trace context helpers)
- event-to-metric projection (`OTelBridge` + `EVENT_METRIC_MAP`)
- local governance telemetry (`CostAttributor`, `SafetyMonitor`)
- tamper-evident audit capture (`AuditTrail`, `AuditStore`, `InMemoryAuditStore`)
- plugin-first wiring (`createOTelPlugin`) so hosts can enable only selected features

The package is intentionally usable without OpenTelemetry SDK runtime installation. It exposes minimal OTel-compatible interfaces and falls back to `NoopTracer`/`NoopSpan` when no real tracer is provided.

## Responsibilities
- Provide a stable public API from `src/index.ts` for tracing, metrics bridge, safety, cost, audit, plugin wiring, and related types.
- Keep telemetry collection fail-soft: bridge/safety/audit listeners do not throw into the event bus path.
- Maintain a central event metric map composed from domain fragments under `src/event-metric-map/`.
- Offer extension points through `MetricSink` (custom metric export), `AuditStore` (durable audit persistence), and `DzupTracerConfig.tracer` (external tracer injection).
- Keep package-level behavior framework-oriented (no app-specific dashboards, storage backends, or policy enforcement logic).

Out of scope in current code:
- OTel exporter/collector setup
- durable built-in audit backend (only in-memory store is bundled)
- hard blocking/remediation actions in safety monitor (detection-only)

## Structure
- `src/index.ts`: package export surface and `dzupagent_OTEL_VERSION`.
- `src/otel-plugin.ts`: `createOTelPlugin(config)` factory; conditionally instantiates and attaches tracer/bridge/cost/safety/audit components.
- `src/tracer.ts`: `DzupTracer` span factories (`startAgentSpan`, `startLLMSpan`, `startToolSpan`, `startMemorySpan`, `startPhaseSpan`), carrier inject/extract, and span completion helpers.
- `src/trace-context-store.ts`: `AsyncLocalStorage`-based `ForgeTraceContext` (`withForgeContext`, `currentForgeContext`, `forgeContextStore`).
- `src/span-attributes.ts`: `forge.*` + `gen_ai.*` attribute keys.
- `src/otel-types.ts` and `src/noop.ts`: minimal tracer/span interfaces and noop implementations.
- `src/otel-bridge.ts`: event bus subscriber that records metrics and creates limited span events.
- `src/event-metric-map.ts`: full `EVENT_METRIC_MAP` composition + `getAllMetricNames()`.
- `src/event-metric-map/*.ts`: runtime/agent/tool fragments (`adapter-runtime`, `agent-lifecycle`, `tool-lifecycle`, `telemetry`, `supervisor`, `delegation`, `scheduler`).
- `src/event-metric-map/*.ts`: platform/protocol/identity/registry fragments (`platform-identity`, `platform-registry-protocol`, `provider-run`).
- `src/event-metric-map/*.ts`: memory/vector/pipeline/workflow fragments (`memory-core`, `memory-retrieval-sources`, `vector`, `pipeline-core`, `pipeline-runtime`, `pipeline-retry`, `workflow-domain`).
- `src/event-metric-map/*.ts`: governance/planning fragments (`budget`, `approval`, `governance`, `execution-ledger`, `flow-compile`, `skill-lifecycle`, `persona-registry`).
- `src/event-metric-map/*.ts`: coverage and previously-empty event fragments (`empty-events`, `empty-events-agent`, `empty-events-runtime`).
- `src/cost-attribution.ts`: in-memory cost aggregation and threshold event emission.
- `src/safety-monitor.ts`: regex pattern detection and tool failure streak tracking.
- `src/audit-trail.ts`: hash-chain audit entries with query and verification helpers.
- `src/vector-metrics.ts`: standalone vector metrics accumulator/report generator.
- `src/__tests__/*.test.ts`: 29 Vitest files for bridge, map coverage, plugin wiring, tracing/context, cost, safety, audit, vector metrics, and branch coverage.

Build/runtime metadata files:
- `package.json`: scripts, deps, peer deps, and `exports`/`types` contract.
- `tsup.config.ts`: ESM + d.ts build from `src/index.ts` into `dist/`.
- `tsconfig.json` + `tsconfig.dts.json`: strict TS config (d.ts config relaxes only `noUnusedLocals`).
- `vitest.config.ts`: test and coverage thresholds.
- `README.md`: usage-oriented package guide.

## Runtime and Control Flow
1. Host registration: `createOTelPlugin(config)` returns a `DzupPlugin` (`name: '@dzupagent/otel'`, `version: '0.1.0'` in current code), and `onRegister` enables each capability only when configured.
2. Instantiation and attachment: tracer is created first when requested; bridge reuses or creates a tracer; bridge/cost/safety/audit components attach listeners to the same `DzupEventBus`.
3. Event-to-metric path: `OTelBridge.attach(eventBus)` subscribes with `onAny`, skips ignored events, looks up `EVENT_METRIC_MAP[event.type]`, runs `extract(event)`, and writes into `MetricSink` as counter/histogram/gauge operations.
4. Span-event path: bridge emits spans only for `agent:started`, `agent:failed`, `tool:error`, and `provider:circuit_opened`; bridge-side errors are swallowed to keep instrumentation non-fatal.
5. Tracing and context path: `DzupTracer` creates domain spans with semantic attributes, finalizes via `endSpanOk`/`endSpanWithError`, propagates `traceparent`/`baggage` via inject/extract, and reads context from `AsyncLocalStorage`.
6. Governance and audit path: `CostAttributor` aggregates and emits budget events, `SafetyMonitor` scans inputs and tracks tool-error streaks, and `AuditTrail` converts mapped events into hash-chained audit records.

## Key APIs and Types
Tracing and context:
- `DzupTracer`
- `ForgeSpanAttr`, `ForgeSpanAttrKey`
- `withForgeContext`, `currentForgeContext`, `forgeContextStore`
- `DzupTracerConfig`, `ForgeTraceSnapshot`, `ForgeTraceContext`

OTel compatibility primitives:
- `OTelSpan`, `OTelTracer`, `OTelSpanOptions`, `OTelContext`
- `SpanStatusCode`, `SpanKind`
- `NoopSpan`, `NoopTracer`

Metrics bridge and mapping:
- `OTelBridge`, `OTelBridgeConfig`
- `MetricSink`, `InMemoryMetricSink`
- `EVENT_METRIC_MAP`, `MetricMapping`, `getAllMetricNames`

Governance/audit/vector:
- `CostAttributor`, `CostEntry`, `CostReport`, `CostAlertThreshold`, `CostAttributorConfig`
- `SafetyMonitor`, `SafetyCategory`, `SafetySeverity`, `SafetyEvent`, `SafetyPatternRule`, `SafetyMonitorConfig`
- `AuditTrail`, `InMemoryAuditStore`, `AuditCategory`, `AuditEntry`, `AuditStore`, `AuditTrailConfig`
- `VectorMetricsCollector`, `VectorMetrics`, `VectorMetricsReport`

Plugin integration:
- `createOTelPlugin`
- `OTelPluginConfig`

Version constant:
- `dzupagent_OTEL_VERSION` (currently `'0.2.0'`)

## Dependencies
Runtime dependency:
- `@dzupagent/core@0.2.0` for `DzupEventBus`, `DzupEvent` typing, and plugin contracts.

Optional peer dependencies:
- `@opentelemetry/api`
- `@opentelemetry/sdk-metrics`
- `@opentelemetry/sdk-trace-base`

Node built-ins used directly:
- `node:async_hooks` (`AsyncLocalStorage`)
- `node:crypto` (`createHash`, `randomUUID`)

Build/test toolchain:
- `tsup`
- `typescript`
- `vitest`

## Integration Points
- Host runtimes integrate via plugin registration (`@dzupagent/core/plugins`).
- Event taxonomy coupling is direct: metric mapping keys and extraction logic depend on `DzupEvent['type']` and event payload shape from `@dzupagent/core`.
- `MetricSink` enables routing bridge output to non-memory metrics backends.
- `AuditStore` is the durable storage extension seam for audit entries.
- `DzupTracer` accepts injected tracer implementations that satisfy the minimal `OTelTracer` interface, allowing integration with real OTel tracer providers.

## Testing and Observability
Tests:
- 29 test files in `src/__tests__`.
- Coverage includes event map validity/type alignment (`event-metric-map.test.ts`, `event-metric-map-coverage.test.ts`, fragment tests).
- Coverage includes bridge behavior (`otel-bridge.test.ts`, `otel-bridge-extended.test.ts`, `otel-bridge.integration.test.ts`).
- Coverage includes tracer/context/noop/types (`tracer*.test.ts`, `trace-context-store.test.ts`, `noop-and-span-attributes.test.ts`, `otel-types.test.ts`).
- Coverage includes governance and audit (`cost-attribution*.test.ts`, `safety-monitor*.test.ts`, `audit-trail.test.ts`, `audit-cost-integration.test.ts`).
- Coverage includes vector metrics (`vector-metrics*.test.ts`).

Package scripts:
- `build`: `tsup`
- `typecheck`: `tsc --noEmit`
- `lint`: `eslint src/`
- `test`: `vitest run`
- `test:coverage`: `vitest run --coverage`

Coverage config (`vitest.config.ts`):
- provider: `v8`
- thresholds: statements 90, branches 90, functions 80, lines 90

Operational observability behavior:
- instrumentation paths are fail-soft by design (listener-side errors are swallowed in bridge/safety/audit attach handlers)
- in-memory helpers (`InMemoryMetricSink`, `CostAttributor` reports, `SafetyMonitor` event list, `InMemoryAuditStore`) provide local introspection without external telemetry infra

## Risks and TODOs
- Version drift: plugin reports `version: '0.1.0'` while package and exported constant are `0.2.0`.
- In-memory growth risk: `InMemoryMetricSink` stores histogram samples in unbounded arrays.
- In-memory growth risk: default `InMemoryAuditStore` is unbounded except periodic prune in `AuditTrail` every 100 appended entries.
- Contract/comment drift: `SafetyMonitor.attach` comment mentions output scanning on `tool:result`, but implementation only resets failure counters.
- Contract/comment drift: `AuditTrail.verifyChain` comment implies loading entries when omitted, but method only verifies provided entries.
- Contract/comment drift: `DzupTracer` class comment describes callback/context behavior not implemented by current methods.
- Cost attribution limitation: attached event handlers create zero-cost placeholder entries (`agent:completed`, `tool:result`), so meaningful cost data still requires explicit `record()` calls with real values.
- Cost attribution limitation: threshold flags are shared across token and cost channels, so one channel can suppress first-time emission for the other.
- Audit taxonomy gap: `AuditCategory` includes `safety_event` and `config_change`, but `mapEvent` does not currently emit entries for those categories.
- Dependency range drift to monitor: peer range for `@opentelemetry/sdk-metrics` is `^1.21.0`, while dev dependency uses `^2.6.0`.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js