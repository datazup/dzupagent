# 06 — Observability and Tracing

> **Created:** 2026-03-24
> **Status:** Planning
> **Package scope:** `@dzipagent/otel` (new), `@dzipagent/core`, `@dzipagent/server`
> **Priority:** P0-P2 across 10 features
> **Estimated total effort:** 74 hours

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Feature Specifications](#2-feature-specifications)
   - [F1: OpenTelemetry Integration (P0, 12h)](#f1-opentelemetry-integration)
   - [F2: Distributed Tracing (P0, 8h)](#f2-distributed-tracing)
   - [F3: Prometheus Metrics Export (P0, 4h)](#f3-prometheus-metrics-export)
   - [F4: Structured Logging (P0, 4h)](#f4-structured-logging)
   - [F5: Evaluation Framework (P1, 12h)](#f5-evaluation-framework)
   - [F6: Cost Attribution (P1, 6h)](#f6-cost-attribution)
   - [F7: Agent Call Graph Visualization (P2, 4h)](#f7-agent-call-graph-visualization)
   - [F8: Anomaly Detection (P2, 8h)](#f8-anomaly-detection)
   - [F9: Safety Monitoring (P1, 8h)](#f9-safety-monitoring)
   - [F10: Compliance Audit Trail (P1, 8h)](#f10-compliance-audit-trail)
3. [Data Models](#3-data-models)
4. [Data Flow Diagrams](#4-data-flow-diagrams)
5. [File Structure](#5-file-structure)
6. [Testing Strategy](#6-testing-strategy)
7. [Migration Path](#7-migration-path)
8. [Dependencies](#8-dependencies)

---

## 1. Architecture Overview

### 1.1 Current State

DzipAgent has four observability primitives today, all in-process and disconnected:

| Component | Location | Limitation |
|-----------|----------|------------|
| `MetricsCollector` | `@dzipagent/core/src/observability/metrics-collector.ts` | In-memory counters/gauges/histograms. No export format beyond `.toJSON()`. No histogram buckets. Singleton `globalMetrics` with no context propagation. |
| `HealthAggregator` | `@dzipagent/core/src/observability/health-aggregator.ts` | Health checks with `ok/degraded/error/unconfigured` states. Used by server `/api/health/ready`. No metric export from health data. |
| `createLangfuseHandler` | `@dzipagent/core/src/middleware/langfuse.ts` | Dynamic import of `langfuse-langchain`. Returns a LangChain callback handler. No integration with `DzipEventBus` or `MetricsCollector`. |
| `DzipEventBus` | `@dzipagent/core/src/events/event-bus.ts` | ~25 typed events covering agent/tool/memory/budget/pipeline/approval/MCP/provider/hook/plugin lifecycle. Fire-and-forget. `EventLogSink` captures events into `EventLogStore`. |
| `CostTracker` / `calculateCostCents` | `@dzipagent/core/src/middleware/cost-tracking.ts` | Per-call cost calculation. Abstract `CostTracker` interface. No aggregation, no per-agent or per-phase attribution. |

The `/api/health/metrics` endpoint in `@dzipagent/server` returns `MetricsCollector.toJSON()` as JSON. Prometheus cannot scrape this.

### 1.2 Target Architecture

```
                          DzipAgent Runtime
 +-----------------------------------------------------------------+
 |                                                                   |
 |  DzipEventBus -----> OTelBridge -----> DzipTracer               |
 |       |                  |                  |                     |
 |       |                  |           +------+------+              |
 |       v                  v           |      |      |              |
 |  EventLogSink     ForgeLogger     Spans  Metrics  Logs           |
 |  (run history)    (structured)      |      |      |              |
 |       |                  |          |      |      |              |
 |       v                  v          v      v      v              |
 |  EventLogStore   Log Transport   OTel Exporters                  |
 |  (in-memory/pg)  (console/file)  (OTLP/gRPC, OTLP/HTTP, ...)   |
 |                                     |      |      |              |
 +-------------------------------------|------|------|---------------+
                                       v      v      v
                              +---------------------------+
                              |   External Backends       |
                              |                           |
                              |  Jaeger / Tempo (traces)  |
                              |  Prometheus (metrics)     |
                              |  Grafana Loki (logs)      |
                              |  Langfuse (LLM-specific)  |
                              |  Arize Phoenix (OTel)     |
                              +---------------------------+
```

### 1.3 Design Principles

1. **OTel is the backbone, DzipEventBus is the source.** Every `DzipEvent` emission can produce OTel spans and metrics. The `OTelBridge` subscribes to the event bus and translates events into OTel operations. This keeps `@dzipagent/core` free of OTel dependencies.

2. **Plugin architecture for exporters.** `@dzipagent/otel` is a `DzipPlugin` that registers itself via `PluginRegistry`. It wires up event handlers, hooks, and middleware. Consumers who do not need OTel pay zero cost.

3. **AsyncLocalStorage for context propagation.** A single `AsyncLocalStorage<ForgeTraceContext>` carries trace ID, span ID, agent ID, run ID, and baggage through all async operations. This is the "single source of truth" for correlating logs, spans, and metrics.

4. **Langfuse coexists, does not compete.** Langfuse provides LLM-specific observability (prompt versioning, evaluation scores, LLM cost dashboards). OTel provides infrastructure-level tracing. Both can run simultaneously. The existing `createLangfuseHandler` remains; the new OTel plugin adds a parallel trace path.

5. **CLEAR framework alignment.** Every metric maps to one of: Cost (token/dollar spend), Latency (p50/p95/p99 durations), Efficiency (cache hit rates, compression ratios), Assurance (safety scores, eval pass rates), Reliability (error rates, circuit breaker states).

### 1.4 Package Boundary Rules

| Package | Owns | Depends On |
|---------|------|------------|
| `@dzipagent/core` | `DzipEventBus`, `DzipEvent` types, `MetricsCollector`, `HealthAggregator`, `EventLogStore`, `DzipPlugin` interface, `AgentHooks` interface | Nothing from other `@dzipagent/*` packages |
| `@dzipagent/otel` (new) | `DzipTracer`, `OTelBridge`, `ForgeLogger`, Prometheus exporter, span helpers, safety monitors, audit trail, cost attribution | `@dzipagent/core` (for types and event bus) |
| `@dzipagent/server` | `/metrics` Prometheus endpoint, `/api/health` routes | `@dzipagent/core`, optionally `@dzipagent/otel` |
| `@dzipagent/evals` (new) | Scorer interfaces, LLMJudgeScorer, DeterministicScorer, EvalRunner | `@dzipagent/core` (for LLM invoke) |

**Critical constraint:** `@dzipagent/core` MUST NOT import from `@dzipagent/otel`. The OTel plugin injects itself at runtime through `DzipPlugin.onRegister()`.

---

## 2. Feature Specifications

---

### F1: OpenTelemetry Integration

**Priority:** P0 | **Effort:** 12h | **Package:** `@dzipagent/otel`

#### 2.1.1 Overview

Wrap the OpenTelemetry JS SDK to provide DzipAgent-specific tracing with semantic conventions for LLM agent systems. Auto-instrument all major operations through the event bus and hooks.

#### 2.1.2 Interfaces

```typescript
// --- @dzipagent/otel/src/tracer.ts ---

import type { Tracer, Span, SpanOptions, Context } from '@opentelemetry/api'

/**
 * Semantic attribute keys for DzipAgent spans.
 *
 * Follows OpenTelemetry semantic conventions where applicable,
 * extends with `forge.*` namespace for agent-specific attributes.
 *
 * @example
 * ```ts
 * span.setAttribute(ForgeSpanAttr.AGENT_ID, 'code-gen-agent')
 * span.setAttribute(ForgeSpanAttr.MODEL_ID, 'claude-sonnet-4-6')
 * ```
 */
export const ForgeSpanAttr = {
  // Agent identity
  AGENT_ID: 'forge.agent.id',
  AGENT_NAME: 'forge.agent.name',
  RUN_ID: 'forge.run.id',
  PHASE: 'forge.pipeline.phase',
  TENANT_ID: 'forge.tenant.id',

  // LLM attributes (aligned with emerging OTel GenAI semantic conventions)
  MODEL_ID: 'gen_ai.request.model',
  MODEL_PROVIDER: 'gen_ai.system',
  TOKENS_INPUT: 'gen_ai.usage.input_tokens',
  TOKENS_OUTPUT: 'gen_ai.usage.output_tokens',
  TOKENS_TOTAL: 'gen_ai.usage.total_tokens',
  COST_CENTS: 'forge.cost.cents',
  TEMPERATURE: 'gen_ai.request.temperature',
  MAX_TOKENS: 'gen_ai.request.max_tokens',

  // Tool attributes
  TOOL_NAME: 'forge.tool.name',
  TOOL_DURATION_MS: 'forge.tool.duration_ms',
  TOOL_INPUT_SIZE: 'forge.tool.input_size_bytes',
  TOOL_OUTPUT_SIZE: 'forge.tool.output_size_bytes',

  // Memory attributes
  MEMORY_NAMESPACE: 'forge.memory.namespace',
  MEMORY_OPERATION: 'forge.memory.operation',
  MEMORY_RESULT_COUNT: 'forge.memory.result_count',

  // Error attributes
  ERROR_CODE: 'forge.error.code',
  ERROR_RECOVERABLE: 'forge.error.recoverable',

  // Budget attributes
  BUDGET_TOKENS_USED: 'forge.budget.tokens_used',
  BUDGET_TOKENS_LIMIT: 'forge.budget.tokens_limit',
  BUDGET_COST_USED: 'forge.budget.cost_used_cents',
  BUDGET_COST_LIMIT: 'forge.budget.cost_limit_cents',
  BUDGET_ITERATIONS: 'forge.budget.iterations',
  BUDGET_ITERATIONS_LIMIT: 'forge.budget.iterations_limit',
} as const

export type ForgeSpanAttrKey = typeof ForgeSpanAttr[keyof typeof ForgeSpanAttr]

/**
 * Configuration for the DzipTracer.
 */
export interface DzipTracerConfig {
  /** Service name reported to OTel backends (default: 'forgeagent') */
  serviceName?: string

  /** Service version (default: package.json version) */
  serviceVersion?: string

  /**
   * Exporter configuration.
   * - 'otlp-grpc': OTLP over gRPC (default for production)
   * - 'otlp-http': OTLP over HTTP/protobuf
   * - 'console': Print spans to stdout (development)
   * - 'none': No-op exporter (testing)
   */
  exporter?: 'otlp-grpc' | 'otlp-http' | 'console' | 'none'

  /** OTLP endpoint URL (default: http://localhost:4317 for gRPC, :4318 for HTTP) */
  endpoint?: string

  /** Additional OTel resource attributes */
  resourceAttributes?: Record<string, string>

  /** Sampling ratio 0.0-1.0 (default: 1.0 in dev, 0.1 in production) */
  samplingRatio?: number

  /** Whether to enable auto-instrumentation of HTTP client/server (default: true) */
  autoInstrumentHttp?: boolean

  /** Headers to send with OTLP export (for auth) */
  exportHeaders?: Record<string, string>
}

/**
 * DzipTracer wraps the OTel SDK tracer with DzipAgent-specific helpers.
 *
 * It provides convenience methods for starting spans with the correct
 * semantic attributes pre-populated, and manages the trace context
 * via AsyncLocalStorage.
 *
 * @example
 * ```ts
 * const tracer = new DzipTracer({ serviceName: 'my-agent-service' })
 *
 * await tracer.startAgentSpan({
 *   agentId: 'code-gen',
 *   runId: 'run-123',
 * }, async (span) => {
 *   // All nested operations inherit this span as parent
 *   await tracer.startLLMSpan({
 *     model: 'claude-sonnet-4-6',
 *     provider: 'anthropic',
 *   }, async (llmSpan) => {
 *     const result = await model.invoke(messages)
 *     llmSpan.setAttribute(ForgeSpanAttr.TOKENS_INPUT, result.inputTokens)
 *   })
 * })
 * ```
 */
export interface DzipTracer {
  /** The underlying OTel tracer instance */
  readonly tracer: Tracer

  /**
   * Start an agent-level span (root or child of incoming context).
   * Sets forge.agent.id, forge.agent.name, forge.run.id.
   */
  startAgentSpan<T>(
    attrs: { agentId: string; agentName?: string; runId: string; parentContext?: Context },
    fn: (span: Span) => Promise<T>,
  ): Promise<T>

  /**
   * Start an LLM invocation span.
   * Sets gen_ai.* attributes per OTel GenAI semantic conventions.
   */
  startLLMSpan<T>(
    attrs: { model: string; provider: string; temperature?: number; maxTokens?: number },
    fn: (span: Span) => Promise<T>,
  ): Promise<T>

  /**
   * Start a tool execution span.
   * Sets forge.tool.* attributes.
   */
  startToolSpan<T>(
    attrs: { toolName: string; inputSize?: number },
    fn: (span: Span) => Promise<T>,
  ): Promise<T>

  /**
   * Start a memory operation span.
   * Sets forge.memory.* attributes.
   */
  startMemorySpan<T>(
    attrs: { namespace: string; operation: 'read' | 'write' | 'search' | 'delete' },
    fn: (span: Span) => Promise<T>,
  ): Promise<T>

  /**
   * Start a pipeline phase span.
   * Sets forge.pipeline.phase attribute.
   */
  startPhaseSpan<T>(
    attrs: { phase: string; agentId: string; runId: string },
    fn: (span: Span) => Promise<T>,
  ): Promise<T>

  /**
   * Get the current trace context (traceId, spanId).
   * Returns null if no active span.
   */
  currentContext(): ForgeActiveContext | null

  /**
   * Inject trace context into a carrier object (for cross-process propagation).
   * Uses W3C Trace Context format.
   */
  inject(carrier: Record<string, string>): void

  /**
   * Extract trace context from a carrier object (from incoming request).
   * Uses W3C Trace Context format.
   */
  extract(carrier: Record<string, string>): Context

  /**
   * Gracefully shut down the tracer, flushing pending spans.
   */
  shutdown(): Promise<void>
}

export interface ForgeActiveContext {
  traceId: string
  spanId: string
  agentId: string | undefined
  runId: string | undefined
}
```

#### 2.1.3 AsyncLocalStorage Context

```typescript
// --- @dzipagent/otel/src/trace-context-store.ts ---

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The context carried through all async operations within a DzipAgent run.
 *
 * This is NOT the OTel Context (which has its own propagation).
 * This is DzipAgent's application-level context, used to correlate
 * logs, metrics, and spans without passing parameters everywhere.
 */
export interface ForgeTraceContext {
  /** W3C trace ID (32 hex chars) */
  traceId: string
  /** Current span ID (16 hex chars) */
  spanId: string
  /** Agent that owns this execution */
  agentId: string
  /** Current run ID */
  runId: string
  /** Current pipeline phase (if in a pipeline) */
  phase?: string
  /** Tenant ID (for multi-tenant deployments) */
  tenantId?: string
  /** Arbitrary baggage propagated across agent boundaries */
  baggage: Record<string, string>
}

/**
 * Global AsyncLocalStorage instance for DzipAgent trace context.
 *
 * @example
 * ```ts
 * import { forgeContextStore } from '@dzipagent/otel'
 *
 * // Inside an instrumented operation:
 * const ctx = forgeContextStore.getStore()
 * if (ctx) {
 *   logger.info('Processing', { traceId: ctx.traceId, agentId: ctx.agentId })
 * }
 * ```
 */
export const forgeContextStore = new AsyncLocalStorage<ForgeTraceContext>()

/**
 * Run a function within a ForgeTraceContext.
 * Nested calls see the provided context via forgeContextStore.getStore().
 */
export function withForgeContext<T>(ctx: ForgeTraceContext, fn: () => T): T {
  return forgeContextStore.run(ctx, fn)
}

/**
 * Get the current trace context, or undefined if not within an instrumented scope.
 */
export function currentForgeContext(): ForgeTraceContext | undefined {
  return forgeContextStore.getStore()
}
```

#### 2.1.4 OTel Bridge (Event Bus to OTel)

```typescript
// --- @dzipagent/otel/src/otel-bridge.ts ---

import type { DzipEventBus } from '@dzipagent/core'
import type { DzipEvent } from '@dzipagent/core'
import type { DzipTracer } from './tracer.js'
import type { ForgeLogger } from './logger.js'
import type { MetricsExporter } from './metrics-exporter.js'

/**
 * OTelBridge subscribes to DzipEventBus and translates events into
 * OTel spans, metrics, and structured log entries.
 *
 * It is the single wiring point between DzipAgent's event-driven
 * architecture and the OpenTelemetry SDK.
 *
 * Design: The bridge does NOT create new spans for every event.
 * It enriches existing spans (started by DzipTracer helpers) and
 * records metrics. Events like `agent:started` add span events,
 * while `agent:completed` finalize duration metrics.
 */
export interface OTelBridgeConfig {
  tracer: DzipTracer
  logger: ForgeLogger
  metricsExporter: MetricsExporter
  /**
   * Events to ignore (e.g., high-frequency events in production).
   * Default: none ignored.
   */
  ignoreEvents?: DzipEvent['type'][]
}

export interface OTelBridge {
  /**
   * Attach the bridge to an event bus. Returns an unsubscribe function.
   *
   * @example
   * ```ts
   * const bridge = createOTelBridge({ tracer, logger, metricsExporter })
   * const detach = bridge.attach(eventBus)
   * // Later:
   * detach()
   * ```
   */
  attach(eventBus: DzipEventBus): () => void

  /** Flush pending telemetry data. Call before process exit. */
  flush(): Promise<void>
}

/**
 * Event-to-metric mapping rules.
 *
 * Each DzipEvent type maps to zero or more metric operations.
 * This table drives the OTelBridge's metric recording.
 */
export const EVENT_METRIC_MAP: Record<
  DzipEvent['type'],
  Array<{
    metric: string
    type: 'counter' | 'histogram'
    labelsFrom: (event: DzipEvent) => Record<string, string>
    valueFrom?: (event: DzipEvent) => number
  }>
> = {
  'agent:started': [{
    metric: 'dzip_agent_runs_total',
    type: 'counter',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'agent:started' }>
      return { agent_id: ev.agentId, status: 'started' }
    },
  }],
  'agent:completed': [
    {
      metric: 'dzip_agent_runs_total',
      type: 'counter',
      labelsFrom: (e) => {
        const ev = e as Extract<DzipEvent, { type: 'agent:completed' }>
        return { agent_id: ev.agentId, status: 'completed' }
      },
    },
    {
      metric: 'dzip_agent_duration_seconds',
      type: 'histogram',
      labelsFrom: (e) => {
        const ev = e as Extract<DzipEvent, { type: 'agent:completed' }>
        return { agent_id: ev.agentId }
      },
      valueFrom: (e) => {
        const ev = e as Extract<DzipEvent, { type: 'agent:completed' }>
        return ev.durationMs / 1000
      },
    },
  ],
  'agent:failed': [{
    metric: 'dzip_agent_runs_total',
    type: 'counter',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'agent:failed' }>
      return { agent_id: ev.agentId, status: 'failed', error_type: ev.errorCode }
    },
  }],
  'tool:called': [{
    metric: 'forge_tool_calls_total',
    type: 'counter',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'tool:called' }>
      return { tool_name: ev.toolName }
    },
  }],
  'tool:result': [{
    metric: 'forge_tool_duration_seconds',
    type: 'histogram',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'tool:result' }>
      return { tool_name: ev.toolName }
    },
    valueFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'tool:result' }>
      return ev.durationMs / 1000
    },
  }],
  'tool:error': [{
    metric: 'forge_tool_errors_total',
    type: 'counter',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'tool:error' }>
      return { tool_name: ev.toolName, error_type: ev.errorCode }
    },
  }],
  'memory:written': [{
    metric: 'forge_memory_operations_total',
    type: 'counter',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'memory:written' }>
      return { namespace: ev.namespace, operation: 'write' }
    },
  }],
  'memory:searched': [{
    metric: 'forge_memory_operations_total',
    type: 'counter',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'memory:searched' }>
      return { namespace: ev.namespace, operation: 'search' }
    },
  }],
  'memory:error': [{
    metric: 'forge_memory_errors_total',
    type: 'counter',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'memory:error' }>
      return { namespace: ev.namespace }
    },
  }],
  'budget:warning': [{
    metric: 'forge_budget_warnings_total',
    type: 'counter',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'budget:warning' }>
      return { level: ev.level }
    },
  }],
  'budget:exceeded': [{
    metric: 'forge_budget_exceeded_total',
    type: 'counter',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'budget:exceeded' }>
      return { reason: ev.reason }
    },
  }],
  'pipeline:phase_changed': [{
    metric: 'forge_pipeline_phase_transitions_total',
    type: 'counter',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'pipeline:phase_changed' }>
      return { from: ev.previousPhase, to: ev.phase }
    },
  }],
  'pipeline:validation_failed': [{
    metric: 'forge_pipeline_validation_failures_total',
    type: 'counter',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'pipeline:validation_failed' }>
      return { phase: ev.phase }
    },
  }],
  'approval:requested': [{
    metric: 'forge_approval_requests_total',
    type: 'counter',
    labelsFrom: () => ({ status: 'requested' }),
  }],
  'approval:granted': [{
    metric: 'forge_approval_requests_total',
    type: 'counter',
    labelsFrom: () => ({ status: 'granted' }),
  }],
  'approval:rejected': [{
    metric: 'forge_approval_requests_total',
    type: 'counter',
    labelsFrom: () => ({ status: 'rejected' }),
  }],
  'mcp:connected': [{
    metric: 'forge_mcp_connections_total',
    type: 'counter',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'mcp:connected' }>
      return { server: ev.serverName, status: 'connected' }
    },
  }],
  'mcp:disconnected': [{
    metric: 'forge_mcp_connections_total',
    type: 'counter',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'mcp:disconnected' }>
      return { server: ev.serverName, status: 'disconnected' }
    },
  }],
  'provider:failed': [{
    metric: 'forge_provider_failures_total',
    type: 'counter',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'provider:failed' }>
      return { provider: ev.provider, tier: ev.tier }
    },
  }],
  'provider:circuit_opened': [{
    metric: 'forge_provider_circuit_state_changes_total',
    type: 'counter',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'provider:circuit_opened' }>
      return { provider: ev.provider, state: 'open' }
    },
  }],
  'provider:circuit_closed': [{
    metric: 'forge_provider_circuit_state_changes_total',
    type: 'counter',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'provider:circuit_closed' }>
      return { provider: ev.provider, state: 'closed' }
    },
  }],
  'hook:error': [{
    metric: 'forge_hook_errors_total',
    type: 'counter',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'hook:error' }>
      return { hook: ev.hookName }
    },
  }],
  'plugin:registered': [{
    metric: 'forge_plugins_registered_total',
    type: 'counter',
    labelsFrom: (e) => {
      const ev = e as Extract<DzipEvent, { type: 'plugin:registered' }>
      return { plugin: ev.pluginName }
    },
  }],
}
```

#### 2.1.5 OTel Plugin (DzipPlugin implementation)

```typescript
// --- @dzipagent/otel/src/otel-plugin.ts ---

import type { DzipPlugin, PluginContext } from '@dzipagent/core'
import type { DzipTracerConfig } from './tracer.js'
import type { ForgeLoggerConfig } from './logger.js'
import type { PrometheusExporterConfig } from './prometheus.js'

/**
 * Configuration for the OTel observability plugin.
 *
 * @example
 * ```ts
 * import { createOTelPlugin } from '@dzipagent/otel'
 *
 * const otelPlugin = createOTelPlugin({
 *   tracer: { serviceName: 'my-service', exporter: 'otlp-grpc' },
 *   logger: { level: 'info', transports: ['console'] },
 *   prometheus: { enabled: true },
 * })
 *
 * pluginRegistry.register(otelPlugin)
 * ```
 */
export interface OTelPluginConfig {
  /** Tracer configuration. Omit to disable tracing. */
  tracer?: DzipTracerConfig

  /** Structured logger configuration. Omit to use default console logger. */
  logger?: ForgeLoggerConfig

  /** Prometheus metrics exporter. Omit to disable Prometheus. */
  prometheus?: PrometheusExporterConfig

  /** Cost attribution configuration. Omit to disable. */
  costAttribution?: CostAttributionConfig

  /** Safety monitoring configuration. Omit to disable. */
  safetyMonitor?: SafetyMonitorConfig

  /** Audit trail configuration. Omit to disable. */
  auditTrail?: AuditTrailConfig
}

export interface CostAttributionConfig {
  /** Enable per-agent cost tracking (default: true) */
  perAgent?: boolean
  /** Enable per-phase cost tracking (default: true) */
  perPhase?: boolean
  /** Enable per-tool cost tracking (default: false) */
  perTool?: boolean
  /** Cost alert thresholds in cents */
  alerts?: Array<{ thresholdCents: number; channel: 'event' | 'webhook'; webhookUrl?: string }>
}

export interface SafetyMonitorConfig {
  /** Enable prompt injection detection on inputs (default: true) */
  detectInputInjection?: boolean
  /** Enable prompt injection detection on outputs (default: true) */
  detectOutputInjection?: boolean
  /** Enable memory poisoning detection (default: true) */
  detectMemoryPoisoning?: boolean
  /** Enable tool misuse detection (default: true) */
  detectToolMisuse?: boolean
  /** Consecutive tool failures before alert (default: 3) */
  toolFailureThreshold?: number
}

export interface AuditTrailConfig {
  /** Store interface for persisting audit entries */
  store: AuditStore
  /** Whether to compute hash chain for tamper detection (default: true) */
  enableHashChain?: boolean
  /** Retention period in days (default: 90). Entries older than this are pruned. */
  retentionDays?: number
  /** Which event categories to audit (default: all) */
  categories?: AuditCategory[]
}

export type AuditCategory =
  | 'agent_lifecycle'
  | 'tool_execution'
  | 'memory_mutation'
  | 'approval_action'
  | 'safety_event'
  | 'cost_threshold'
  | 'config_change'

/**
 * Create the OTel observability plugin.
 *
 * This is the primary entry point for DzipAgent observability.
 * The returned DzipPlugin registers event handlers, hooks, and
 * middleware that instrument agent operations.
 */
export function createOTelPlugin(config: OTelPluginConfig): DzipPlugin
```

---

### F2: Distributed Tracing

**Priority:** P0 | **Effort:** 8h | **Package:** `@dzipagent/otel`

#### 2.2.1 Overview

Propagate W3C Trace Context across agent boundaries so that multi-agent workflows produce a single, connected trace. When Agent A spawns Agent B (via sub-agent spawner, A2A, or agents-as-tools), the child inherits the parent's trace context.

#### 2.2.2 Trace Context in ForgeMessage

```typescript
// --- Extension to @dzipagent/core ForgeMessage envelope ---
// (Defined in 02-COMMUNICATION-PROTOCOLS.md; shown here for reference)

/**
 * Trace metadata embedded in every ForgeMessage.
 * Follows W3C Trace Context (https://www.w3.org/TR/trace-context/).
 */
export interface TraceHeaders {
  /**
   * W3C traceparent header value.
   * Format: {version}-{trace-id}-{parent-id}-{trace-flags}
   * Example: '00-4bf92f3577b86cd56801e28d01644077-00f067aa0ba902b7-01'
   */
  traceparent: string

  /**
   * W3C tracestate header value (optional).
   * Vendor-specific trace data.
   * Example: 'forge=agent:code-gen;run:r123'
   */
  tracestate?: string

  /**
   * W3C baggage header value (optional).
   * Key-value pairs propagated across service boundaries.
   * Example: 'tenantId=t1,userId=u1,priority=high'
   */
  baggage?: string
}

/**
 * Extension to ForgeMessage for trace propagation.
 * The trace field is optional; messages without it start a new trace.
 */
export interface ForgeMessageTrace {
  trace?: TraceHeaders
}
```

#### 2.2.3 Cross-Agent Span Relationships

```typescript
// --- @dzipagent/otel/src/distributed-tracing.ts ---

import type { Context, SpanContext } from '@opentelemetry/api'

/**
 * Propagation strategies for cross-agent tracing.
 */
export interface TracePropagator {
  /**
   * Inject current trace context into an outgoing message carrier.
   * Called before sending a message to another agent.
   */
  injectIntoMessage(carrier: Record<string, string>): void

  /**
   * Extract trace context from an incoming message carrier.
   * Called when receiving a message from another agent.
   * Returns an OTel Context that can be used as parent.
   */
  extractFromMessage(carrier: Record<string, string>): Context

  /**
   * Inject trace context into HTTP headers (for A2A/REST calls).
   */
  injectIntoHeaders(headers: Headers | Record<string, string>): void

  /**
   * Extract trace context from incoming HTTP headers.
   */
  extractFromHeaders(headers: Headers | Record<string, string>): Context

  /**
   * Create a link to a remote span (for cases where parent-child
   * is not appropriate, e.g., fire-and-forget agent spawning).
   */
  createSpanLink(remoteContext: SpanContext): SpanLink
}

export interface SpanLink {
  context: SpanContext
  attributes?: Record<string, string>
}

/**
 * Trace context injector for the sub-agent spawner.
 *
 * When DzipAgent spawns a sub-agent (via SubAgentSpawner),
 * this function injects the current trace context into the
 * sub-agent's configuration so the child creates a child span.
 *
 * @example
 * ```ts
 * // Inside SubAgentSpawner (conceptual):
 * const childConfig = {
 *   ...subAgentConfig,
 *   traceContext: extractTraceContextForChild(),
 * }
 * ```
 */
export function extractTraceContextForChild(): Record<string, string>

/**
 * Restore trace context when starting a sub-agent.
 * Called at the beginning of a sub-agent run to establish
 * the parent-child relationship.
 */
export function restoreTraceContextFromParent(
  carrier: Record<string, string>,
): Context
```

#### 2.2.4 Trace Topology Examples

```
Single Agent Run:
  [agent:code-gen run:r1]
    |-- [llm:claude-sonnet]
    |-- [tool:file_write]
    |-- [llm:claude-sonnet]
    |-- [tool:run_tests]

Multi-Agent Workflow (supervisor pattern):
  [agent:supervisor run:r1]
    |-- [llm:claude-sonnet] (plan)
    |-- [agent:code-gen run:r2]          <-- child span
    |     |-- [llm:claude-sonnet]
    |     |-- [tool:file_write]
    |-- [agent:test-runner run:r3]       <-- child span
    |     |-- [tool:run_tests]
    |     |-- [llm:claude-haiku] (analyze failures)
    |-- [llm:claude-sonnet] (synthesize)

A2A Cross-Service:
  [agent:orchestrator service:svc-A]
    |-- [a2a:send-task to=svc-B]
    |     |-- [agent:code-gen service:svc-B]    <-- linked span (cross-service)
    |           |-- [llm:claude-sonnet]
    |           |-- [tool:file_write]
    |-- [a2a:get-result from=svc-B]
```

---

### F3: Prometheus Metrics Export

**Priority:** P0 | **Effort:** 4h | **Package:** `@dzipagent/otel` + `@dzipagent/server`

#### 2.3.1 Overview

Expose a `/metrics` endpoint in Prometheus text exposition format (not JSON). Replace the current JSON-only `MetricsCollector.toJSON()` endpoint with a proper Prometheus scrape target. The existing `MetricsCollector` is adapted, not replaced, so consumers who only use `.toJSON()` are unaffected.

#### 2.3.2 Interfaces

```typescript
// --- @dzipagent/otel/src/prometheus.ts ---

/**
 * Configuration for the Prometheus metrics exporter.
 */
export interface PrometheusExporterConfig {
  /** Whether Prometheus export is enabled (default: true) */
  enabled?: boolean

  /** Metric name prefix (default: 'forge_') */
  prefix?: string

  /**
   * Default histogram buckets for latency metrics.
   * Default: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120]
   * (in seconds)
   */
  defaultBuckets?: number[]

  /**
   * Per-metric bucket overrides.
   * Key is the metric name (without prefix), value is the bucket array.
   */
  bucketOverrides?: Record<string, number[]>
}

/**
 * Metrics exporter that produces Prometheus text exposition format.
 *
 * Wraps the existing MetricsCollector and adds:
 * - Proper histogram bucket support
 * - Text exposition format output
 * - HELP and TYPE annotations
 * - Label sanitization (Prometheus naming rules)
 */
export interface MetricsExporter {
  /** Record a counter increment */
  counter(name: string, labels: Record<string, string>, value?: number): void

  /** Record a histogram observation */
  histogram(name: string, labels: Record<string, string>, value: number): void

  /** Set a gauge value */
  gauge(name: string, labels: Record<string, string>, value: number): void

  /**
   * Render all metrics in Prometheus text exposition format.
   *
   * @example Output:
   * ```
   * # HELP dzip_agent_runs_total Total agent runs by status
   * # TYPE dzip_agent_runs_total counter
   * dzip_agent_runs_total{agent_id="code-gen",status="completed"} 42
   * dzip_agent_runs_total{agent_id="code-gen",status="failed"} 3
   *
   * # HELP forge_llm_latency_seconds LLM call latency in seconds
   * # TYPE forge_llm_latency_seconds histogram
   * forge_llm_latency_seconds_bucket{model_id="claude-sonnet-4-6",le="0.5"} 10
   * forge_llm_latency_seconds_bucket{model_id="claude-sonnet-4-6",le="1"} 25
   * forge_llm_latency_seconds_bucket{model_id="claude-sonnet-4-6",le="+Inf"} 30
   * forge_llm_latency_seconds_sum{model_id="claude-sonnet-4-6"} 18.7
   * forge_llm_latency_seconds_count{model_id="claude-sonnet-4-6"} 30
   * ```
   */
  toPrometheusText(): string

  /** Render all metrics as JSON (delegates to existing MetricsCollector.toJSON()) */
  toJSON(): Record<string, unknown>[]

  /** Reset all metrics */
  reset(): void
}

/**
 * Standard metric definitions.
 * Each entry defines the metric name, type, help text, and default labels.
 */
export const DZIP_METRICS = {
  // Agent metrics
  AGENT_RUNS_TOTAL: {
    name: 'agent_runs_total',
    type: 'counter' as const,
    help: 'Total number of agent runs',
    labels: ['agent_id', 'status', 'error_type'],
  },
  AGENT_DURATION_SECONDS: {
    name: 'agent_duration_seconds',
    type: 'histogram' as const,
    help: 'Agent run duration in seconds',
    labels: ['agent_id'],
  },

  // LLM metrics
  LLM_CALLS_TOTAL: {
    name: 'llm_calls_total',
    type: 'counter' as const,
    help: 'Total number of LLM calls',
    labels: ['model_id', 'provider', 'status'],
  },
  LLM_TOKENS_TOTAL: {
    name: 'llm_tokens_total',
    type: 'counter' as const,
    help: 'Total tokens consumed',
    labels: ['model_id', 'direction'],  // direction: input | output
  },
  LLM_LATENCY_SECONDS: {
    name: 'llm_latency_seconds',
    type: 'histogram' as const,
    help: 'LLM call latency in seconds',
    labels: ['model_id', 'provider'],
  },
  LLM_COST_CENTS: {
    name: 'llm_cost_cents_total',
    type: 'counter' as const,
    help: 'Total LLM cost in cents',
    labels: ['model_id', 'agent_id'],
  },

  // Tool metrics
  TOOL_CALLS_TOTAL: {
    name: 'tool_calls_total',
    type: 'counter' as const,
    help: 'Total number of tool calls',
    labels: ['tool_name', 'status'],
  },
  TOOL_DURATION_SECONDS: {
    name: 'tool_duration_seconds',
    type: 'histogram' as const,
    help: 'Tool call duration in seconds',
    labels: ['tool_name'],
  },
  TOOL_ERRORS_TOTAL: {
    name: 'tool_errors_total',
    type: 'counter' as const,
    help: 'Total tool execution errors',
    labels: ['tool_name', 'error_type'],
  },

  // Memory metrics
  MEMORY_OPERATIONS_TOTAL: {
    name: 'memory_operations_total',
    type: 'counter' as const,
    help: 'Total memory operations',
    labels: ['namespace', 'operation'],
  },
  MEMORY_ERRORS_TOTAL: {
    name: 'memory_errors_total',
    type: 'counter' as const,
    help: 'Total memory operation errors',
    labels: ['namespace'],
  },

  // A2A metrics
  A2A_TASKS_TOTAL: {
    name: 'a2a_tasks_total',
    type: 'counter' as const,
    help: 'Total A2A task requests',
    labels: ['target_agent', 'status'],
  },
  A2A_LATENCY_SECONDS: {
    name: 'a2a_latency_seconds',
    type: 'histogram' as const,
    help: 'A2A task latency in seconds',
    labels: ['target_agent'],
  },

  // Budget metrics
  BUDGET_WARNINGS_TOTAL: {
    name: 'budget_warnings_total',
    type: 'counter' as const,
    help: 'Total budget warning events',
    labels: ['level'],
  },
  BUDGET_EXCEEDED_TOTAL: {
    name: 'budget_exceeded_total',
    type: 'counter' as const,
    help: 'Total budget exceeded events',
    labels: ['reason'],
  },

  // Provider metrics
  PROVIDER_FAILURES_TOTAL: {
    name: 'provider_failures_total',
    type: 'counter' as const,
    help: 'Total provider failures',
    labels: ['provider', 'tier'],
  },
  PROVIDER_CIRCUIT_CHANGES_TOTAL: {
    name: 'provider_circuit_state_changes_total',
    type: 'counter' as const,
    help: 'Provider circuit breaker state transitions',
    labels: ['provider', 'state'],
  },

  // Pipeline metrics
  PIPELINE_PHASE_TRANSITIONS_TOTAL: {
    name: 'pipeline_phase_transitions_total',
    type: 'counter' as const,
    help: 'Pipeline phase transitions',
    labels: ['from', 'to'],
  },

  // Approval metrics
  APPROVAL_REQUESTS_TOTAL: {
    name: 'approval_requests_total',
    type: 'counter' as const,
    help: 'Approval gate requests',
    labels: ['status'],
  },

  // Safety metrics
  SAFETY_EVENTS_TOTAL: {
    name: 'safety_events_total',
    type: 'counter' as const,
    help: 'Safety-related detection events',
    labels: ['event_type', 'severity'],
  },
} as const
```

#### 2.3.3 Server Integration

```typescript
// --- Extension to @dzipagent/server/src/routes/health.ts ---

/**
 * Updated /metrics endpoint to serve Prometheus text exposition format.
 *
 * When a MetricsExporter is provided in config, /api/health/metrics
 * returns text/plain with Prometheus-format metrics.
 * When only MetricsCollector is provided, falls back to JSON.
 *
 * Content negotiation: If Accept header contains 'text/plain',
 * returns Prometheus format. Otherwise returns JSON.
 */

// New config field for ForgeServerConfig:
export interface ForgeServerConfigExtension {
  /** Prometheus-compatible metrics exporter (from @dzipagent/otel) */
  metricsExporter?: {
    toPrometheusText(): string
    toJSON(): Record<string, unknown>[]
  }
}

// Route handler (conceptual):
// app.get('/metrics', (c) => {
//   const accept = c.req.header('Accept') ?? ''
//   if (config.metricsExporter && accept.includes('text/plain')) {
//     return c.text(config.metricsExporter.toPrometheusText(), 200, {
//       'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
//     })
//   }
//   // Fallback to JSON
//   return c.json({ metrics: config.metrics?.toJSON() ?? [] })
// })
```

---

### F4: Structured Logging

**Priority:** P0 | **Effort:** 4h | **Package:** `@dzipagent/otel`

#### 2.4.1 Overview

Replace ad-hoc `console.error` calls throughout DzipAgent with a structured JSON logger that automatically includes trace context. Logs correlate with OTel spans via shared `traceId` and `spanId` fields.

#### 2.4.2 Interfaces

```typescript
// --- @dzipagent/otel/src/logger.ts ---

/**
 * Log levels in ascending severity order.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * A structured log entry emitted by ForgeLogger.
 */
export interface ForgeLogEntry {
  /** ISO-8601 timestamp */
  timestamp: string
  /** Log severity level */
  level: LogLevel
  /** Human-readable message */
  message: string
  /** Structured context fields (always present, may be empty) */
  context: {
    traceId?: string
    spanId?: string
    agentId?: string
    runId?: string
    phase?: string
    tenantId?: string
  }
  /** Additional data fields specific to this log entry */
  data?: Record<string, unknown>
  /** Error information (present only for error-level logs) */
  error?: {
    name: string
    message: string
    stack?: string
    code?: string
  }
}

/**
 * Log transport interface.
 * Implementations write log entries to different destinations.
 */
export interface LogTransport {
  /** Transport name (for identification) */
  name: string
  /** Write a log entry. Must not throw. */
  write(entry: ForgeLogEntry): void
  /** Flush pending writes (for buffered transports). */
  flush?(): Promise<void>
}

/**
 * Configuration for ForgeLogger.
 */
export interface ForgeLoggerConfig {
  /** Minimum log level to emit (default: 'info') */
  level?: LogLevel
  /**
   * Transports to write to.
   * Default: ['console'] which uses ConsoleTransport (JSON to stdout).
   * Options: 'console', 'file', or custom LogTransport instances.
   */
  transports?: Array<'console' | LogTransport>
  /**
   * Static fields added to every log entry.
   * Useful for environment, service name, etc.
   */
  defaultFields?: Record<string, string>
  /**
   * Whether to automatically include trace context from AsyncLocalStorage.
   * Default: true.
   */
  autoTraceContext?: boolean
}

/**
 * Structured logger for DzipAgent.
 *
 * Automatically enriches log entries with trace context from
 * AsyncLocalStorage (traceId, spanId, agentId, runId, phase).
 *
 * @example
 * ```ts
 * const logger = createForgeLogger({ level: 'info' })
 *
 * logger.info('Agent started', { agentId: 'code-gen', runId: 'r1' })
 * // Output: {"timestamp":"...","level":"info","message":"Agent started",
 * //          "context":{"traceId":"abc","spanId":"def","agentId":"code-gen","runId":"r1"}}
 *
 * logger.error('Tool failed', { toolName: 'write_file' }, new Error('ENOENT'))
 * // Output: {"timestamp":"...","level":"error","message":"Tool failed",
 * //          "context":{...},"data":{"toolName":"write_file"},
 * //          "error":{"name":"Error","message":"ENOENT","stack":"..."}}
 * ```
 */
export interface ForgeLogger {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>, err?: Error): void

  /**
   * Create a child logger with additional default fields.
   * Useful for scoping logs to a specific component.
   *
   * @example
   * ```ts
   * const toolLogger = logger.child({ component: 'tool-executor' })
   * toolLogger.info('Running tool', { tool: 'write_file' })
   * // Includes component: 'tool-executor' in every entry
   * ```
   */
  child(fields: Record<string, string>): ForgeLogger

  /** Flush all transports */
  flush(): Promise<void>
}

/**
 * Create a configured ForgeLogger instance.
 */
export function createForgeLogger(config?: ForgeLoggerConfig): ForgeLogger
```

#### 2.4.3 Built-in Transports

```typescript
// --- @dzipagent/otel/src/transports/console-transport.ts ---

/**
 * Writes JSON-formatted log entries to stdout (info/debug/warn)
 * or stderr (error).
 *
 * This is the default transport. Each entry is a single JSON line
 * (NDJSON), suitable for ingestion by Fluentd, Filebeat, Loki, etc.
 */
export class ConsoleTransport implements LogTransport {
  readonly name = 'console'
  write(entry: ForgeLogEntry): void
}

// --- @dzipagent/otel/src/transports/file-transport.ts ---

/**
 * Writes log entries to a rotating file.
 *
 * Configuration:
 * - path: File path (default: './logs/forge.log')
 * - maxSizeBytes: Max file size before rotation (default: 10MB)
 * - maxFiles: Number of rotated files to keep (default: 5)
 */
export interface FileTransportConfig {
  path?: string
  maxSizeBytes?: number
  maxFiles?: number
}

export class FileTransport implements LogTransport {
  readonly name = 'file'
  constructor(config?: FileTransportConfig)
  write(entry: ForgeLogEntry): void
  flush(): Promise<void>
}

// --- @dzipagent/otel/src/transports/otel-log-transport.ts ---

/**
 * Bridges ForgeLogger entries to OTel Log SDK.
 *
 * Converts ForgeLogEntry to OTel LogRecord and exports via
 * the configured OTel log exporter (OTLP). This enables
 * logs, traces, and metrics to flow through the same pipeline.
 */
export class OTelLogTransport implements LogTransport {
  readonly name = 'otel'
  write(entry: ForgeLogEntry): void
  flush(): Promise<void>
}
```

---

### F5: Evaluation Framework

**Priority:** P1 | **Effort:** 12h | **Package:** `@dzipagent/evals`

#### 2.5.1 Overview

A framework for evaluating LLM agent outputs against quality criteria. Supports both deterministic checks (regex, JSON schema, keyword presence) and LLM-as-judge scoring. Results integrate with OTel spans as attributes and with Prometheus as metrics.

#### 2.5.2 Interfaces

```typescript
// --- @dzipagent/evals/src/scorer.ts ---

/**
 * A single evaluation score.
 */
export interface Score {
  /** Scorer that produced this score */
  scorerName: string
  /** Numeric score (0.0 to 1.0 normalized) */
  value: number
  /** Whether this score passes the threshold */
  pass: boolean
  /** Threshold used for pass/fail (default: 0.5) */
  threshold: number
  /** Human-readable explanation of the score */
  reasoning?: string
  /** Additional metadata */
  metadata?: Record<string, unknown>
}

/**
 * Base scorer interface. All scorers implement this.
 *
 * Scorers are stateless functions that evaluate a single
 * input/output pair and return a Score.
 */
export interface Scorer {
  /** Unique name for this scorer */
  readonly name: string

  /**
   * Evaluate an output against criteria.
   *
   * @param input - The original input/prompt
   * @param output - The agent's output to evaluate
   * @param reference - Optional reference/expected output
   * @returns A score between 0.0 and 1.0
   */
  evaluate(
    input: string,
    output: string,
    reference?: string,
  ): Promise<Score>
}

// --- @dzipagent/evals/src/llm-judge.ts ---

/**
 * Configuration for LLM-as-judge scorer.
 */
export interface LLMJudgeConfig {
  /** The LLM model to use for judging (e.g., 'claude-sonnet-4-6') */
  model: string
  /** Provider for the judge model (e.g., 'anthropic') */
  provider?: string
  /**
   * Evaluation criteria described in natural language.
   * The judge LLM receives this as part of its system prompt.
   *
   * @example 'Evaluate whether the code follows TypeScript best practices,
   * uses proper error handling, and includes JSDoc comments.'
   */
  criteria: string
  /**
   * Optional rubric with score descriptions.
   * Maps score ranges to descriptions for the judge.
   *
   * @example
   * {
   *   '0.0-0.2': 'Completely fails criteria',
   *   '0.2-0.5': 'Partially meets criteria with significant gaps',
   *   '0.5-0.8': 'Mostly meets criteria with minor issues',
   *   '0.8-1.0': 'Fully meets criteria',
   * }
   */
  rubric?: Record<string, string>
  /** Pass/fail threshold (default: 0.7) */
  threshold?: number
  /** Temperature for judge calls (default: 0.0 for consistency) */
  temperature?: number
  /** Maximum tokens for judge response (default: 1024) */
  maxTokens?: number
}

/**
 * LLM-as-judge scorer.
 *
 * Sends the input/output pair to a judge LLM with evaluation criteria
 * and parses a structured score from the response.
 *
 * @example
 * ```ts
 * const codeQualityJudge = new LLMJudgeScorer({
 *   model: 'claude-sonnet-4-6',
 *   criteria: 'Evaluate TypeScript code quality: types, error handling, readability.',
 *   rubric: {
 *     '0.0-0.3': 'Major type errors or missing error handling',
 *     '0.3-0.7': 'Functional but has type issues or poor structure',
 *     '0.7-1.0': 'Clean, well-typed, proper error handling',
 *   },
 *   threshold: 0.7,
 * })
 *
 * const score = await codeQualityJudge.evaluate(prompt, generatedCode)
 * ```
 */
export class LLMJudgeScorer implements Scorer {
  readonly name: string
  constructor(config: LLMJudgeConfig)
  evaluate(input: string, output: string, reference?: string): Promise<Score>
}

// --- @dzipagent/evals/src/deterministic.ts ---

/**
 * Deterministic scorer types.
 * These do not call an LLM; they apply programmatic checks.
 */

export interface RegexScorerConfig {
  /** Pattern that output must match (1.0 if match, 0.0 if not) */
  pattern: RegExp
  /** Whether the pattern should match (true) or not match (false) (default: true) */
  shouldMatch?: boolean
  threshold?: number
}

export interface JsonSchemaScorerConfig {
  /** JSON Schema that the output must validate against */
  schema: Record<string, unknown>
  /** Whether to parse output as JSON first (default: true) */
  parseJson?: boolean
  threshold?: number
}

export interface KeywordScorerConfig {
  /** Keywords that must appear in output */
  requiredKeywords?: string[]
  /** Keywords that must NOT appear in output */
  forbiddenKeywords?: string[]
  /** Case-sensitive matching (default: false) */
  caseSensitive?: boolean
  threshold?: number
}

export interface LengthScorerConfig {
  /** Minimum output length in characters */
  minLength?: number
  /** Maximum output length in characters */
  maxLength?: number
  threshold?: number
}

export class RegexScorer implements Scorer {
  readonly name = 'regex'
  constructor(config: RegexScorerConfig)
  evaluate(input: string, output: string): Promise<Score>
}

export class JsonSchemaScorer implements Scorer {
  readonly name = 'json-schema'
  constructor(config: JsonSchemaScorerConfig)
  evaluate(input: string, output: string): Promise<Score>
}

export class KeywordScorer implements Scorer {
  readonly name = 'keyword'
  constructor(config: KeywordScorerConfig)
  evaluate(input: string, output: string): Promise<Score>
}

export class LengthScorer implements Scorer {
  readonly name = 'length'
  constructor(config: LengthScorerConfig)
  evaluate(input: string, output: string): Promise<Score>
}

// --- @dzipagent/evals/src/composite.ts ---

/**
 * Composite scorer that combines multiple scorers with weights.
 *
 * @example
 * ```ts
 * const composite = new CompositeScorer({
 *   scorers: [
 *     { scorer: codeQualityJudge, weight: 0.5 },
 *     { scorer: new KeywordScorer({ requiredKeywords: ['export'] }), weight: 0.2 },
 *     { scorer: new LengthScorer({ minLength: 100 }), weight: 0.3 },
 *   ],
 *   threshold: 0.7,
 * })
 *
 * const result = await composite.evaluate(input, output)
 * // result.value = weighted average of all scorer values
 * // result.metadata.breakdown = individual scores
 * ```
 */
export interface WeightedScorer {
  scorer: Scorer
  /** Weight for this scorer (0.0 to 1.0). Weights are normalized. */
  weight: number
}

export interface CompositeScorerConfig {
  scorers: WeightedScorer[]
  threshold?: number
}

export class CompositeScorer implements Scorer {
  readonly name = 'composite'
  constructor(config: CompositeScorerConfig)
  evaluate(input: string, output: string, reference?: string): Promise<Score>
}

// --- @dzipagent/evals/src/dataset.ts ---

/**
 * A single evaluation example.
 */
export interface EvalExample {
  /** Unique ID for this example */
  id: string
  /** Input prompt or context */
  input: string
  /** Expected/reference output (optional for judge-only evals) */
  reference?: string
  /** Tags for filtering/grouping */
  tags?: string[]
  /** Additional metadata */
  metadata?: Record<string, unknown>
}

/**
 * A dataset of evaluation examples.
 */
export interface EvalDataset {
  /** Dataset name */
  name: string
  /** Dataset version (for tracking regressions across dataset changes) */
  version: string
  /** The evaluation examples */
  examples: EvalExample[]
}

/**
 * Load an EvalDataset from a JSON or JSONL file.
 */
export function loadDataset(path: string): Promise<EvalDataset>

// --- @dzipagent/evals/src/runner.ts ---

/**
 * Result of evaluating a single example.
 */
export interface EvalExampleResult {
  exampleId: string
  /** The agent's actual output */
  output: string
  /** Individual scorer results */
  scores: Score[]
  /** Composite/aggregate score (if using CompositeScorer) */
  aggregateScore: number
  /** Whether all scores pass their thresholds */
  pass: boolean
  /** Duration of generation + evaluation in ms */
  durationMs: number
}

/**
 * Aggregate result of an evaluation run.
 */
export interface EvalRunResult {
  /** Dataset that was evaluated */
  datasetName: string
  datasetVersion: string
  /** ISO timestamp of the eval run */
  timestamp: string
  /** Per-example results */
  results: EvalExampleResult[]
  /** Aggregate statistics */
  aggregate: {
    /** Average score across all examples */
    meanScore: number
    /** Median score */
    medianScore: number
    /** Minimum score */
    minScore: number
    /** Maximum score */
    maxScore: number
    /** Standard deviation */
    stddev: number
    /** Pass rate (0.0 to 1.0) */
    passRate: number
    /** Total examples evaluated */
    totalExamples: number
    /** Number of examples that passed */
    passedExamples: number
  }
  /** Per-scorer aggregate stats */
  perScorer: Record<string, {
    meanScore: number
    passRate: number
  }>
}

/**
 * Configuration for the eval runner.
 */
export interface EvalRunnerConfig {
  /** Scorers to apply to each example */
  scorers: Scorer[]
  /**
   * Function that generates an output from an input.
   * This is the "system under test" (typically an agent invocation).
   */
  generate: (input: string) => Promise<string>
  /** Maximum concurrent evaluations (default: 5) */
  concurrency?: number
  /** Progress callback */
  onProgress?: (completed: number, total: number) => void
  /**
   * CI/CD threshold: if aggregate passRate is below this, the run "fails".
   * Used by CI integration to fail builds.
   * Default: no threshold (always succeeds).
   */
  passRateThreshold?: number
}

/**
 * Run evaluations on a dataset.
 *
 * @example
 * ```ts
 * const runner = new EvalRunner({
 *   scorers: [codeQualityJudge, keywordScorer],
 *   generate: async (input) => {
 *     const result = await agent.generate({ prompt: input })
 *     return result.content
 *   },
 *   passRateThreshold: 0.8,
 * })
 *
 * const result = await runner.run(dataset)
 * if (result.aggregate.passRate < 0.8) {
 *   process.exit(1) // Fail CI
 * }
 * ```
 */
export class EvalRunner {
  constructor(config: EvalRunnerConfig)
  run(dataset: EvalDataset): Promise<EvalRunResult>
}
```

---

### F6: Cost Attribution

**Priority:** P1 | **Effort:** 6h | **Package:** `@dzipagent/otel`

#### 2.6.1 Overview

Extend the existing `calculateCostCents` and `CostTracker` with multi-dimensional cost attribution. Track costs per agent, per pipeline phase, per tool, and per A2A call. Aggregate by tenant and time period for billing and budgeting.

#### 2.6.2 Interfaces

```typescript
// --- @dzipagent/otel/src/cost-attribution.ts ---

/**
 * A single cost event — recorded each time tokens are consumed.
 */
export interface CostEvent {
  /** ISO timestamp */
  timestamp: string
  /** Cost in cents */
  costCents: number
  /** Input tokens consumed */
  inputTokens: number
  /** Output tokens consumed */
  outputTokens: number
  /** Model that incurred the cost */
  model: string
  /** Provider (anthropic, openai, etc.) */
  provider: string

  // Attribution dimensions
  /** Agent that incurred the cost */
  agentId: string
  /** Run ID */
  runId: string
  /** Pipeline phase (if applicable) */
  phase?: string
  /** Tool name (if cost was incurred during tool execution) */
  toolName?: string
  /** Tenant ID (for multi-tenant) */
  tenantId?: string
}

/**
 * Cost aggregation query parameters.
 */
export interface CostQuery {
  /** Start of time range (ISO timestamp) */
  from?: string
  /** End of time range (ISO timestamp) */
  to?: string
  /** Group results by these dimensions */
  groupBy: Array<'agent' | 'model' | 'tenant' | 'phase' | 'tool' | 'hour' | 'day'>
  /** Filter by specific values */
  filter?: {
    agentId?: string
    model?: string
    tenantId?: string
    phase?: string
  }
}

/**
 * Result of a cost aggregation query.
 */
export interface CostAggregation {
  /** Grouping key (e.g., { agent: 'code-gen', model: 'claude-sonnet' }) */
  group: Record<string, string>
  /** Total cost in cents */
  totalCents: number
  /** Total input tokens */
  totalInputTokens: number
  /** Total output tokens */
  totalOutputTokens: number
  /** Number of LLM calls */
  callCount: number
}

/**
 * Cost alert definition.
 */
export interface CostAlert {
  /** Alert name */
  name: string
  /** Threshold in cents. Alert fires when cumulative cost exceeds this. */
  thresholdCents: number
  /** Time window for cumulative check (default: 'day') */
  window: 'hour' | 'day' | 'week' | 'month'
  /** Optional dimension filter (e.g., per-agent, per-tenant) */
  filter?: { agentId?: string; tenantId?: string }
  /**
   * Alert channel.
   * - 'event': emit a DzipEvent ('cost:alert_triggered')
   * - 'webhook': POST to a webhook URL
   */
  channel: 'event' | 'webhook'
  /** Webhook URL (required when channel is 'webhook') */
  webhookUrl?: string
}

/**
 * Cost attribution tracker.
 *
 * Listens to LLM completion events (via hooks or event bus),
 * records CostEvents, and provides aggregation queries.
 */
export interface CostAttributionTracker {
  /** Record a cost event */
  record(event: CostEvent): void

  /** Query aggregated costs */
  query(params: CostQuery): CostAggregation[]

  /** Get total cost for a specific run */
  getRunCost(runId: string): { totalCents: number; breakdown: CostAggregation[] }

  /** Get total cost for a specific agent across all runs */
  getAgentCost(agentId: string, timeRange?: { from: string; to: string }): number

  /** Register a cost alert */
  addAlert(alert: CostAlert): void

  /** Remove a cost alert by name */
  removeAlert(name: string): void

  /** Get all active alerts */
  getAlerts(): CostAlert[]

  /** Reset all recorded cost data (for testing) */
  reset(): void
}

/**
 * In-memory cost attribution tracker.
 * Suitable for development and single-instance deployments.
 * For production multi-instance, use a store-backed implementation.
 */
export function createInMemoryCostTracker(): CostAttributionTracker
```

#### 2.6.3 New DzipEvent Types

```typescript
// --- Additions to @dzipagent/core DzipEvent union ---

// These events are added to the DzipEvent type to support cost attribution.
// They are emitted by the OTel plugin, not by core.

| { type: 'cost:recorded'; agentId: string; runId: string; costCents: number; model: string }
| { type: 'cost:alert_triggered'; alertName: string; thresholdCents: number; actualCents: number; window: string }
```

---

### F7: Agent Call Graph Visualization

**Priority:** P2 | **Effort:** 4h | **Package:** `@dzipagent/otel`

#### 2.7.1 Overview

Generate visual representations of agent execution from trace data. Produces Mermaid sequence diagrams, DOT graphs, and optionally an interactive HTML view.

#### 2.7.2 Interfaces

```typescript
// --- @dzipagent/otel/src/call-graph.ts ---

/**
 * A node in the call graph.
 */
export interface CallGraphNode {
  id: string
  type: 'agent' | 'llm' | 'tool' | 'memory' | 'a2a'
  label: string
  durationMs: number
  costCents?: number
  status: 'ok' | 'error'
  children: CallGraphNode[]
  attributes: Record<string, string>
}

/**
 * Options for call graph generation.
 */
export interface CallGraphOptions {
  /**
   * Output format.
   * - 'mermaid': Mermaid sequence diagram syntax
   * - 'dot': Graphviz DOT format
   * - 'json': Raw CallGraphNode tree
   */
  format: 'mermaid' | 'dot' | 'json'

  /** Include timing annotations (default: true) */
  showDurations?: boolean

  /** Include cost annotations (default: false) */
  showCosts?: boolean

  /** Maximum depth to render (default: unlimited) */
  maxDepth?: number

  /** Filter to specific node types */
  includeTypes?: CallGraphNode['type'][]
}

/**
 * Generate a call graph from completed run events.
 *
 * @example
 * ```ts
 * const events = await eventLog.getEvents('run-123')
 * const graph = buildCallGraph(events)
 * const mermaid = renderCallGraph(graph, { format: 'mermaid' })
 * // Returns:
 * // sequenceDiagram
 * //   participant Agent as code-gen
 * //   participant LLM as claude-sonnet
 * //   participant Tool as file_write
 * //   Agent->>LLM: invoke (2.3s)
 * //   LLM-->>Agent: response
 * //   Agent->>Tool: file_write (0.1s)
 * //   Tool-->>Agent: ok
 * ```
 */
export function buildCallGraph(events: RunEvent[]): CallGraphNode

export function renderCallGraph(graph: CallGraphNode, options: CallGraphOptions): string
```

---

### F8: Anomaly Detection

**Priority:** P2 | **Effort:** 8h | **Package:** `@dzipagent/otel`

#### 2.8.1 Overview

Statistical anomaly detection on agent operational metrics. Uses z-score analysis over sliding windows to detect unusual patterns in latency, cost, error rates, and token usage. Fires alerts through the event bus.

#### 2.8.2 Interfaces

```typescript
// --- @dzipagent/otel/src/anomaly-detection.ts ---

/**
 * A metric sample for anomaly detection.
 */
export interface MetricSample {
  timestamp: number
  value: number
  labels: Record<string, string>
}

/**
 * Anomaly detection configuration for a single metric.
 */
export interface AnomalyRule {
  /** Rule name */
  name: string
  /** Metric name to monitor */
  metric: string
  /** Label filter (only samples matching these labels are considered) */
  labelFilter?: Record<string, string>
  /** Z-score threshold for alerting (default: 3.0 = 3 standard deviations) */
  zScoreThreshold?: number
  /** Sliding window size in samples (default: 100) */
  windowSize?: number
  /** Minimum samples before detection activates (default: 20) */
  minSamples?: number
  /** Cooldown period between alerts in ms (default: 300_000 = 5 minutes) */
  cooldownMs?: number
}

/**
 * An anomaly alert emitted when a metric deviates significantly.
 */
export interface AnomalyAlert {
  ruleName: string
  metric: string
  observedValue: number
  expectedMean: number
  stddev: number
  zScore: number
  timestamp: string
  labels: Record<string, string>
}

/**
 * Anomaly detector that monitors metric streams.
 */
export interface AnomalyDetector {
  /** Add a detection rule */
  addRule(rule: AnomalyRule): void

  /** Remove a rule by name */
  removeRule(name: string): void

  /** Feed a metric sample. Returns an alert if anomaly detected, null otherwise. */
  observe(sample: MetricSample): AnomalyAlert | null

  /** Get current statistics for a rule */
  getStats(ruleName: string): {
    mean: number
    stddev: number
    sampleCount: number
    lastValue: number
  } | null

  /** Reset all sliding windows */
  reset(): void
}

/**
 * Create an anomaly detector with default rules for DzipAgent metrics.
 *
 * Default rules monitor:
 * - LLM latency (z-score > 3.0)
 * - LLM cost per call (z-score > 3.0)
 * - Tool error rate (z-score > 2.5)
 * - Token usage per call (z-score > 3.0)
 */
export function createDefaultAnomalyDetector(): AnomalyDetector
```

#### 2.8.3 New DzipEvent Type

```typescript
// Addition to DzipEvent union:
| { type: 'anomaly:detected'; alert: AnomalyAlert }
```

---

### F9: Safety Monitoring

**Priority:** P1 | **Effort:** 8h | **Package:** `@dzipagent/otel`

#### 2.9.1 Overview

Runtime detection of safety-relevant patterns: prompt injection in inputs and outputs, memory poisoning (contradictory writes), and tool misuse (repeated failures, unusual invocation patterns). Builds on the existing `sanitizeMemoryContent` in `@dzipagent/memory` and `OutputPipeline` in `@dzipagent/core/src/security/`.

The safety monitor does NOT block operations (that is the responsibility of `OutputPipeline` and `sanitizeMemoryContent`). It observes, scores, and emits events for the audit trail and alerting systems.

#### 2.9.2 Interfaces

```typescript
// --- @dzipagent/otel/src/safety/safety-monitor.ts ---

/**
 * Severity levels for safety events.
 */
export type SafetySeverity = 'info' | 'warning' | 'critical'

/**
 * A safety event emitted when a potential threat is detected.
 */
export interface SafetyEvent {
  /** Unique event ID */
  id: string
  /** ISO timestamp */
  timestamp: string
  /** Category of safety concern */
  category: SafetyCategory
  /** Severity level */
  severity: SafetySeverity
  /** Human-readable description */
  description: string
  /** Agent that triggered the event */
  agentId: string
  /** Run ID */
  runId: string
  /** The content that triggered detection (may be truncated) */
  evidence: string
  /** Detection confidence (0.0 to 1.0) */
  confidence: number
  /** Specific threats identified */
  threats: string[]
}

export type SafetyCategory =
  | 'prompt_injection_input'
  | 'prompt_injection_output'
  | 'memory_poisoning'
  | 'tool_misuse'
  | 'exfiltration_attempt'
  | 'privilege_escalation'

/**
 * Safety monitor that observes agent operations for threats.
 *
 * Subscribes to DzipEventBus events and hooks into the
 * agent lifecycle to inspect inputs, outputs, memory writes,
 * and tool invocations.
 */
export interface SafetyMonitor {
  /**
   * Scan input text for prompt injection patterns.
   * Called before LLM invocation on user-provided content.
   */
  scanInput(content: string, context: { agentId: string; runId: string }): SafetyEvent | null

  /**
   * Scan output text for prompt injection or policy violations.
   * Called after LLM invocation on model-generated content.
   */
  scanOutput(content: string, context: { agentId: string; runId: string }): SafetyEvent | null

  /**
   * Check a memory write for poisoning indicators.
   *
   * Memory poisoning detection works by comparing the new content
   * against recent writes to the same namespace. If the new content
   * directly contradicts recent entries with high confidence,
   * a safety event is emitted.
   *
   * @param namespace - Memory namespace
   * @param content - Content being written
   * @param recentEntries - Recent entries in the same namespace (for contradiction check)
   */
  scanMemoryWrite(
    namespace: string,
    content: string,
    recentEntries: string[],
    context: { agentId: string; runId: string },
  ): SafetyEvent | null

  /**
   * Track tool invocations for misuse patterns.
   *
   * Detects:
   * - Repeated failures of the same tool (threshold-based)
   * - Unusual tool invocation frequency
   * - Tool calls with suspicious input patterns
   */
  trackToolInvocation(
    toolName: string,
    success: boolean,
    input: unknown,
    context: { agentId: string; runId: string },
  ): SafetyEvent | null

  /**
   * Get all safety events for a run.
   */
  getEventsForRun(runId: string): SafetyEvent[]

  /**
   * Get aggregate safety stats.
   */
  getStats(): {
    totalEvents: number
    bySeverity: Record<SafetySeverity, number>
    byCategory: Record<SafetyCategory, number>
  }

  /** Reset all tracked state (for testing) */
  reset(): void
}

/**
 * Create a safety monitor with default configuration.
 *
 * Reuses injection/exfiltration patterns from @dzipagent/memory's
 * sanitizeMemoryContent, extending them with output-specific patterns
 * and contradiction detection for memory poisoning.
 */
export function createSafetyMonitor(config?: SafetyMonitorConfig): SafetyMonitor
```

#### 2.9.3 New DzipEvent Types

```typescript
// Additions to DzipEvent union:
| { type: 'safety:threat_detected'; event: SafetyEvent }
| { type: 'safety:memory_poisoning'; namespace: string; agentId: string; description: string }
```

---

### F10: Compliance Audit Trail

**Priority:** P1 | **Effort:** 8h | **Package:** `@dzipagent/otel`

#### 2.10.1 Overview

An immutable, hash-chained log of all consequential agent actions. Each entry records who performed an action, what they did, when, and the result. The hash chain provides tamper detection: any modification to a historical entry breaks the chain.

#### 2.10.2 Interfaces

```typescript
// --- @dzipagent/otel/src/audit/audit-trail.ts ---

/**
 * A single audit trail entry.
 */
export interface AuditEntry {
  /** Auto-incrementing sequence number */
  seq: number
  /** ISO-8601 timestamp */
  timestamp: string
  /** SHA-256 hash of this entry's content (for chain verification) */
  hash: string
  /** Hash of the previous entry (empty string for first entry) */
  previousHash: string

  // WHO
  /** Agent that performed the action */
  agentId: string
  /** Run context */
  runId: string
  /** Tenant ID (for multi-tenant) */
  tenantId?: string
  /** Human user who triggered the action (if applicable) */
  userId?: string

  // WHAT
  /** Category of action */
  category: AuditCategory
  /** Specific action type */
  action: string
  /** Structured details of the action */
  details: Record<string, unknown>

  // RESULT
  /** Whether the action succeeded */
  success: boolean
  /** Error message if action failed */
  errorMessage?: string

  // CONTEXT
  /** Trace ID for correlation with OTel traces */
  traceId?: string
  /** Span ID for correlation */
  spanId?: string
}

/**
 * Persistence interface for audit entries.
 * Implementations: InMemoryAuditStore (dev), PostgresAuditStore (prod).
 */
export interface AuditStore {
  /** Append an entry. The store assigns seq and computes hashes. */
  append(entry: Omit<AuditEntry, 'seq' | 'hash' | 'previousHash' | 'timestamp'>): Promise<AuditEntry>

  /** Get entries by run ID, ordered by seq. */
  getByRun(runId: string): Promise<AuditEntry[]>

  /** Get entries by agent ID with pagination. */
  getByAgent(agentId: string, options?: { limit?: number; offset?: number }): Promise<AuditEntry[]>

  /** Get entries by category with time range. */
  getByCategory(
    category: AuditCategory,
    options?: { from?: string; to?: string; limit?: number },
  ): Promise<AuditEntry[]>

  /** Get all entries in sequence order (for chain verification). */
  getAll(options?: { fromSeq?: number; limit?: number }): Promise<AuditEntry[]>

  /**
   * Verify hash chain integrity.
   * Returns the first broken link (seq number) or null if chain is valid.
   */
  verifyChain(options?: { fromSeq?: number; toSeq?: number }): Promise<{
    valid: boolean
    brokenAtSeq?: number
    entriesChecked: number
  }>

  /** Prune entries older than retentionDays. Returns number of entries removed. */
  prune(retentionDays: number): Promise<number>

  /** Export entries in a portable format (JSONL). */
  export(options?: { from?: string; to?: string }): AsyncIterable<string>
}

/**
 * In-memory audit store for development and testing.
 */
export class InMemoryAuditStore implements AuditStore {
  append(entry: Omit<AuditEntry, 'seq' | 'hash' | 'previousHash' | 'timestamp'>): Promise<AuditEntry>
  getByRun(runId: string): Promise<AuditEntry[]>
  getByAgent(agentId: string, options?: { limit?: number; offset?: number }): Promise<AuditEntry[]>
  getByCategory(
    category: AuditCategory,
    options?: { from?: string; to?: string; limit?: number },
  ): Promise<AuditEntry[]>
  getAll(options?: { fromSeq?: number; limit?: number }): Promise<AuditEntry[]>
  verifyChain(options?: { fromSeq?: number; toSeq?: number }): Promise<{
    valid: boolean
    brokenAtSeq?: number
    entriesChecked: number
  }>
  prune(retentionDays: number): Promise<number>
  export(options?: { from?: string; to?: string }): AsyncIterable<string>
}

/**
 * The AuditTrail orchestrator.
 *
 * Subscribes to DzipEventBus and automatically creates audit entries
 * for configured event categories. Also provides a manual API for
 * recording custom audit events.
 */
export interface AuditTrail {
  /** Attach to an event bus for automatic auditing. Returns unsubscribe. */
  attach(eventBus: DzipEventBus): () => void

  /** Manually record an audit entry. */
  record(entry: Omit<AuditEntry, 'seq' | 'hash' | 'previousHash' | 'timestamp'>): Promise<AuditEntry>

  /** Verify chain integrity */
  verifyIntegrity(options?: { fromSeq?: number; toSeq?: number }): Promise<{
    valid: boolean
    brokenAtSeq?: number
    entriesChecked: number
  }>

  /** Query entries */
  query(params: {
    runId?: string
    agentId?: string
    category?: AuditCategory
    from?: string
    to?: string
    limit?: number
    offset?: number
  }): Promise<AuditEntry[]>

  /** Export entries for external audit systems */
  export(options?: { from?: string; to?: string }): AsyncIterable<string>

  /** Prune old entries per retention policy */
  prune(): Promise<number>
}

export function createAuditTrail(config: AuditTrailConfig): AuditTrail
```

#### 2.10.3 Hash Chain Computation

```typescript
/**
 * Hash chain algorithm:
 *
 * 1. Serialize the entry (excluding hash and previousHash) as deterministic JSON
 * 2. Concatenate: previousHash + serializedEntry
 * 3. SHA-256 hash the concatenation
 * 4. Store as hex string
 *
 * First entry uses previousHash = '' (empty string).
 *
 * Verification: Recompute hashes from entry 1 forward. If any
 * computed hash differs from the stored hash, the chain is broken.
 */

// Pseudocode:
// function computeHash(entry: Omit<AuditEntry, 'hash'>, previousHash: string): string {
//   const payload = JSON.stringify({
//     seq: entry.seq,
//     timestamp: entry.timestamp,
//     agentId: entry.agentId,
//     runId: entry.runId,
//     category: entry.category,
//     action: entry.action,
//     details: entry.details,
//     success: entry.success,
//   })
//   const input = previousHash + payload
//   return crypto.createHash('sha256').update(input).digest('hex')
// }
```

---

## 3. Data Models

### 3.1 ForgeSpan (OTel Span with DzipAgent semantics)

```typescript
/**
 * ForgeSpan is NOT a new type — it is a standard OTel Span
 * annotated with ForgeSpanAttr attributes.
 *
 * This type documents the expected shape when serialized to JSON
 * (e.g., in Jaeger UI or exported via OTLP).
 */
export interface ForgeSpanSerialized {
  traceId: string               // 32 hex chars
  spanId: string                // 16 hex chars
  parentSpanId?: string         // 16 hex chars (absent for root)
  operationName: string         // e.g., 'agent:code-gen', 'llm:claude-sonnet', 'tool:write_file'
  startTime: string             // ISO-8601
  endTime: string               // ISO-8601
  durationMs: number
  status: 'OK' | 'ERROR' | 'UNSET'
  attributes: {
    // Standard OTel
    'service.name': string
    'service.version': string

    // DzipAgent-specific (from ForgeSpanAttr)
    'forge.agent.id'?: string
    'forge.agent.name'?: string
    'forge.run.id'?: string
    'forge.pipeline.phase'?: string
    'forge.tenant.id'?: string
    'gen_ai.request.model'?: string
    'gen_ai.system'?: string
    'gen_ai.usage.input_tokens'?: number
    'gen_ai.usage.output_tokens'?: number
    'forge.cost.cents'?: number
    'forge.tool.name'?: string
    'forge.tool.duration_ms'?: number
    'forge.memory.namespace'?: string
    'forge.memory.operation'?: string
    'forge.error.code'?: string
  }
  events: Array<{
    name: string
    timestamp: string
    attributes?: Record<string, string | number | boolean>
  }>
  links: Array<{
    traceId: string
    spanId: string
    attributes?: Record<string, string>
  }>
}
```

### 3.2 ForgeMetric

```typescript
/**
 * Internal metric representation used by MetricsExporter.
 *
 * Extends the existing MetricEntry from MetricsCollector with
 * proper histogram bucket support.
 */
export interface ForgeMetric {
  name: string
  type: 'counter' | 'gauge' | 'histogram'
  help: string
  labels: Record<string, string>
  value: number

  // Histogram-specific
  buckets?: Array<{ le: number; count: number }>
  sum?: number
  count?: number
}
```

### 3.3 ForgeLog

```typescript
/**
 * The ForgeLogEntry type defined in F4 (section 2.4.2) is the
 * canonical log data model. Reproduced here for reference:
 */
export type { ForgeLogEntry } from './logger.js'
```

### 3.4 Audit Entry

The `AuditEntry` type defined in F10 (section 2.10.2) is the canonical audit data model.

### 3.5 Evaluation Result

The `EvalRunResult` and `EvalExampleResult` types defined in F5 (section 2.5.2) are the canonical evaluation data models.

---

## 4. Data Flow Diagrams

### 4.1 OTel Trace Creation and Export

```
Agent.generate() called
       |
       v
  DzipTracer.startAgentSpan()
       |
       +-- Creates OTel Span with forge.agent.id, forge.run.id
       +-- Stores ForgeTraceContext in AsyncLocalStorage
       |
       v
  [Agent execution loop]
       |
       +-- DzipTracer.startLLMSpan()
       |       +-- LLM invoke (LangChain)
       |       +-- Sets gen_ai.* attributes on span
       |       +-- Emits DzipEvent 'tool:called' / 'tool:result'
       |       v
       |   OTelBridge.onEvent()
       |       +-- Enriches current span with event data
       |       +-- Records metrics (counter, histogram)
       |       +-- Writes structured log entry
       |
       +-- DzipTracer.startToolSpan()
       |       +-- Tool execution
       |       +-- Sets forge.tool.* attributes
       |
       +-- DzipTracer.startMemorySpan()
       |       +-- Memory read/write
       |       +-- Sets forge.memory.* attributes
       |
       v
  Span ends (agent completes or fails)
       |
       v
  OTel BatchSpanProcessor
       |
       +-- Batches spans (default: 512 spans or 5s)
       v
  OTel Exporter (OTLP/gRPC or OTLP/HTTP)
       |
       v
  External Backend (Jaeger, Tempo, Langfuse, Arize Phoenix)
```

### 4.2 Distributed Trace Across Agent Boundaries

```
Service A                          Service B
---------                          ---------
[Supervisor Agent]                 [Code-Gen Agent]
     |                                  ^
     |  1. startAgentSpan()             |
     |  2. Plan sub-task                |
     |  3. TracePropagator.inject()     |
     |     into message carrier         |
     |                                  |
     +-- ForgeMessage ------------------>
         {                              |
           trace: {                     |
             traceparent: '00-abc...',  |
             tracestate: 'forge=...',   |
             baggage: 'tenant=t1'       |
           },                           |
           payload: { task: '...' }     |
         }                              |
                                        |
                      TracePropagator.extract()
                      from message carrier
                                        |
                      startAgentSpan({ parentContext })
                      [child span linked to parent]
                                        |
                      [Code generation spans]
                                        |
                      ForgeMessage (response) -->
                                             |
     <-- response with trace context --------+
     |
     v
  [Continue supervisor flow]
```

### 4.3 Metrics Collection and Export Pipeline

```
DzipEventBus
     |
     v (OTelBridge subscribes to all events)
OTelBridge.onEvent()
     |
     +-- Looks up EVENT_METRIC_MAP[event.type]
     |
     +-- For each mapping:
     |     +-- Extract labels from event
     |     +-- Call MetricsExporter.counter() or .histogram()
     |
     v
MetricsExporter
     |
     +-- In-memory metric storage (counters, histograms with buckets)
     |
     +-- toPrometheusText() called by /metrics endpoint
     |       |
     |       v
     |   Prometheus scrapes /api/health/metrics
     |       |
     |       v
     |   Grafana dashboard
     |
     +-- toJSON() called by existing /api/health/metrics (backward compat)
     |
     +-- OTel Metrics SDK export (optional, via OTLP)
             |
             v
         OTel Collector -> Prometheus remote write
```

### 4.4 Audit Trail Write and Verification

```
DzipEventBus event
     |
     v
AuditTrail.onEvent()
     |
     +-- Filter: is this event category auditable?
     |     (agent_lifecycle, tool_execution, memory_mutation, ...)
     |
     +-- Extract: who, what, result from event
     |
     +-- Enrich: add traceId/spanId from AsyncLocalStorage
     |
     v
AuditStore.append()
     |
     +-- Assign next seq number
     +-- Set timestamp
     +-- Get previousHash from last entry
     +-- Compute hash = SHA-256(previousHash + deterministicJSON(entry))
     +-- Persist entry
     |
     v
  Stored AuditEntry

Verification (periodic or on-demand):
  AuditStore.verifyChain()
     |
     +-- Load entries in seq order
     +-- For each entry:
     |     +-- Recompute hash from entry data + previousHash
     |     +-- Compare with stored hash
     |     +-- If mismatch: return { valid: false, brokenAtSeq: N }
     v
  { valid: true/false, brokenAtSeq?: N, entriesChecked: N }
```

---

## 5. File Structure

### 5.1 New Package: `@dzipagent/otel`

```
packages/forgeagent-otel/
  package.json
  tsconfig.json
  tsup.config.ts
  src/
    index.ts                          # Public API exports
    otel-plugin.ts                    # DzipPlugin implementation (entry point)
    tracer.ts                         # DzipTracer class
    trace-context-store.ts            # AsyncLocalStorage for ForgeTraceContext
    otel-bridge.ts                    # DzipEventBus -> OTel translation
    distributed-tracing.ts            # W3C Trace Context propagation
    prometheus.ts                     # MetricsExporter with Prometheus text format
    logger.ts                         # ForgeLogger with structured JSON output
    cost-attribution.ts               # CostAttributionTracker
    call-graph.ts                     # Mermaid/DOT visualization
    anomaly-detection.ts              # Z-score anomaly detector
    transports/
      console-transport.ts            # JSON to stdout/stderr
      file-transport.ts               # Rotating file transport
      otel-log-transport.ts           # Bridge to OTel Log SDK
    safety/
      safety-monitor.ts              # Runtime safety detection
      contradiction-detector.ts      # Memory poisoning via contradiction
      tool-misuse-tracker.ts         # Repeated failure / pattern detection
    audit/
      audit-trail.ts                 # AuditTrail orchestrator
      audit-store.ts                 # AuditStore interface + InMemoryAuditStore
      hash-chain.ts                  # SHA-256 hash chain computation
    __tests__/
      tracer.test.ts
      otel-bridge.test.ts
      prometheus.test.ts
      logger.test.ts
      cost-attribution.test.ts
      anomaly-detection.test.ts
      safety-monitor.test.ts
      audit-trail.test.ts
      hash-chain.test.ts
      call-graph.test.ts
```

### 5.2 New Package: `@dzipagent/evals`

```
packages/forgeagent-evals/
  package.json
  tsconfig.json
  tsup.config.ts
  src/
    index.ts                          # Public API exports
    scorer.ts                         # Scorer interface, Score type
    llm-judge.ts                      # LLMJudgeScorer
    deterministic.ts                  # Regex, JsonSchema, Keyword, Length scorers
    composite.ts                      # CompositeScorer
    dataset.ts                        # EvalDataset, loadDataset
    runner.ts                         # EvalRunner
    __tests__/
      llm-judge.test.ts
      deterministic.test.ts
      composite.test.ts
      runner.test.ts
```

### 5.3 Modifications to Existing Packages

```
@dzipagent/core:
  src/events/event-types.ts           # Add cost:recorded, cost:alert_triggered,
                                      # safety:threat_detected, safety:memory_poisoning,
                                      # anomaly:detected event types

@dzipagent/server:
  src/routes/health.ts                # Update /metrics to support Prometheus text format
  src/app.ts                          # Add metricsExporter to ForgeServerConfig
```

### 5.4 Package Dependencies

```
@dzipagent/otel:
  dependencies: (none — all are peer deps)
  peerDependencies:
    @dzipagent/core: workspace:*
    @opentelemetry/api: ^1.9.0
    @opentelemetry/sdk-node: ^0.57.0
    @opentelemetry/sdk-trace-base: ^1.29.0
    @opentelemetry/sdk-metrics: ^1.29.0
    @opentelemetry/exporter-trace-otlp-grpc: ^0.57.0
    @opentelemetry/exporter-trace-otlp-http: ^0.57.0
    @opentelemetry/exporter-metrics-otlp-http: ^0.57.0
    @opentelemetry/resources: ^1.29.0
    @opentelemetry/semantic-conventions: ^1.28.0
    @opentelemetry/context-async-hooks: ^1.29.0

@dzipagent/evals:
  dependencies: (none — all are peer deps)
  peerDependencies:
    @dzipagent/core: workspace:*
    zod: ^3.23.0
```

---

## 6. Testing Strategy

### 6.1 Trace Correctness Tests

| Test | Description | Approach |
|------|-------------|----------|
| Parent-child spans | Agent span contains LLM, tool, memory child spans | Use `InMemorySpanExporter` from `@opentelemetry/sdk-trace-base`, assert `parentSpanId` relationships |
| Span attributes | Each span helper sets correct semantic attributes | Start span, check `span.attributes` contains expected `ForgeSpanAttr` keys |
| Context propagation | AsyncLocalStorage carries context through async calls | Start agent span, read `forgeContextStore.getStore()` inside nested callbacks, assert traceId matches |
| Distributed trace | Parent context propagated to child agent | Inject context into carrier, extract in child, assert same `traceId`, different `spanId` |
| Span status | Failed operations set span status to ERROR | Start span, throw error, assert `span.status.code === SpanStatusCode.ERROR` |

### 6.2 Metrics Accuracy Tests

| Test | Description | Approach |
|------|-------------|----------|
| Counter increment | Event emission increments correct counter | Emit `agent:completed` event, assert `MetricsExporter.toJSON()` shows `dzip_agent_runs_total` incremented |
| Histogram recording | Latency events record histogram values | Emit `tool:result` with `durationMs: 150`, assert histogram sum and count updated |
| Prometheus format | Text output matches Prometheus exposition spec | Call `toPrometheusText()`, parse with regex, verify `# TYPE`, `# HELP`, label syntax |
| Label cardinality | Labels extracted correctly from events | Emit events with different `agentId` values, assert separate metric series |

### 6.3 Log Correlation Tests

| Test | Description | Approach |
|------|-------------|----------|
| Trace ID in logs | Log entries contain current trace context | Start span, log within span scope, assert `ForgeLogEntry.context.traceId` matches |
| Child logger fields | Child logger inherits parent fields | Create child with `{ component: 'test' }`, log, assert field present |
| Level filtering | Logs below threshold are suppressed | Set level to `warn`, call `logger.info()`, assert no output |
| Transport routing | Error logs go to stderr, others to stdout | Mock transports, log at each level, verify routing |

### 6.4 Audit Trail Integrity Tests

| Test | Description | Approach |
|------|-------------|----------|
| Hash chain validity | Chain verifies after normal appends | Append 100 entries, call `verifyChain()`, assert `valid: true` |
| Tamper detection | Modified entry breaks chain | Append entries, mutate one in-memory, verify, assert `valid: false` at correct seq |
| Sequential ordering | Entries maintain seq order | Append concurrently, assert `seq` values are monotonically increasing |
| Retention pruning | Old entries are removed correctly | Append entries with old timestamps, prune, assert removal count |
| Export format | JSONL export is valid | Export, parse each line as JSON, validate against AuditEntry schema |

### 6.5 Safety Monitor Tests

| Test | Description | Approach |
|------|-------------|----------|
| Input injection detection | Known injection patterns detected | Pass "ignore all previous instructions" through `scanInput()`, assert non-null SafetyEvent |
| Clean input passes | Normal text does not trigger | Pass normal text, assert null result |
| Tool misuse threshold | Repeated failures trigger alert | Call `trackToolInvocation()` with `success: false` N times, assert SafetyEvent after threshold |
| Memory poisoning | Contradictory writes detected | Provide recent entries stating "X is true", scan write stating "X is false", assert detection |

### 6.6 Cost Attribution Tests

| Test | Description | Approach |
|------|-------------|----------|
| Per-agent aggregation | Costs grouped correctly by agent | Record events for agents A and B, query grouped by agent, assert correct totals |
| Per-phase aggregation | Pipeline phase costs tracked | Record events with phase labels, query grouped by phase |
| Alert triggering | Cost threshold fires alert | Set alert at 100 cents, record 150 cents of events, assert alert fired |
| Time windowing | Cost queries respect time ranges | Record events at different times, query with `from`/`to`, assert filtered results |

### 6.7 Evaluation Framework Tests

| Test | Description | Approach |
|------|-------------|----------|
| Deterministic scorers | Regex, keyword, length, JSON schema all produce correct scores | Unit test each scorer with known inputs |
| Composite weighting | Weighted average computed correctly | Combine scorers with known weights and scores, verify formula |
| Runner execution | EvalRunner processes dataset and produces aggregate stats | Create mock `generate` function, run on small dataset, verify `EvalRunResult` |
| CI threshold | Runner respects `passRateThreshold` | Set threshold at 1.0, provide failing scorer, verify result indicates failure |

---

## 7. Migration Path

### 7.1 Phase 1: Non-breaking additions (Week 1)

1. Create `@dzipagent/otel` package with `DzipTracer`, `ForgeLogger`, `MetricsExporter`.
2. Create `@dzipagent/evals` package with scorer interfaces and deterministic scorers.
3. Add new event types to `DzipEvent` union in `@dzipagent/core` (additive, no breaking change).
4. The existing `MetricsCollector` and `createLangfuseHandler` remain unchanged.

### 7.2 Phase 2: Server integration (Week 2)

1. Add optional `metricsExporter` to `ForgeServerConfig`.
2. Update `/api/health/metrics` to serve Prometheus format when `metricsExporter` is available.
3. Existing JSON format remains the default (no breaking change for current consumers).

### 7.3 Phase 3: Plugin activation (Week 3)

1. Document the `createOTelPlugin()` as the recommended observability setup.
2. The plugin auto-wires event bus subscriptions, hooks, and middleware.
3. Zero-config default: if `@dzipagent/otel` is not installed, no observability overhead.

### 7.4 Deprecation Timeline

| Component | Status | Action |
|-----------|--------|--------|
| `MetricsCollector.toJSON()` | Supported | Remains for backward compat; `MetricsExporter.toJSON()` delegates to it |
| `globalMetrics` singleton | Soft-deprecated | New code should use `MetricsExporter` via plugin; `globalMetrics` remains functional |
| `createLangfuseHandler` | Supported | Remains independent of OTel; can coexist |
| `console.error` in event bus | Will be replaced | `ForgeLogger` replaces all `console.error` calls in instrumented code paths |

---

## 8. Dependencies

### 8.1 Runtime Dependencies (peer)

| Package | Version | Used By | Justification |
|---------|---------|---------|---------------|
| `@opentelemetry/api` | ^1.9.0 | DzipTracer | Stable API surface for OTel instrumentation |
| `@opentelemetry/sdk-node` | ^0.57.0 | DzipTracer | Node.js SDK for OTel setup |
| `@opentelemetry/sdk-trace-base` | ^1.29.0 | DzipTracer | Span processing and export |
| `@opentelemetry/sdk-metrics` | ^1.29.0 | MetricsExporter | OTel Metrics SDK (optional, for OTLP metric export) |
| `@opentelemetry/exporter-trace-otlp-grpc` | ^0.57.0 | DzipTracer | OTLP/gRPC trace export |
| `@opentelemetry/exporter-trace-otlp-http` | ^0.57.0 | DzipTracer | OTLP/HTTP trace export |
| `@opentelemetry/resources` | ^1.29.0 | DzipTracer | Service resource attributes |
| `@opentelemetry/semantic-conventions` | ^1.28.0 | DzipTracer | Standard attribute names |
| `@opentelemetry/context-async-hooks` | ^1.29.0 | DzipTracer | AsyncLocalStorage-based context manager |

All OTel packages are **peer dependencies** to avoid version conflicts and keep `@dzipagent/otel` lightweight for consumers who only use a subset of features.

### 8.2 Dev/Test Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@opentelemetry/sdk-trace-base` (InMemorySpanExporter) | ^1.29.0 | Capture spans in tests without external backend |

### 8.3 No New Dependencies for `@dzipagent/core`

The core package gains zero new dependencies. New `DzipEvent` types are additive to the existing union type. The `AsyncLocalStorage` import comes from `node:async_hooks` (Node.js built-in), but it lives in `@dzipagent/otel`, not core.
