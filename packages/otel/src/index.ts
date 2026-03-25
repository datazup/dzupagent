/**
 * @forgeagent/otel — OpenTelemetry integration for ForgeAgent.
 *
 * Provides distributed tracing, metrics, and context propagation
 * for ForgeAgent operations. All OTel dependencies are optional
 * peer dependencies — when not installed, noop implementations
 * are used transparently.
 */

// --- Span Attributes ---
export { ForgeSpanAttr } from './span-attributes.js'
export type { ForgeSpanAttrKey } from './span-attributes.js'

// --- OTel Types (minimal interfaces) ---
export type {
  OTelSpan,
  OTelTracer,
  OTelSpanOptions,
  OTelContext,
} from './otel-types.js'
export { SpanStatusCode, SpanKind } from './otel-types.js'

// --- Noop Implementations ---
export { NoopSpan, NoopTracer } from './noop.js'

// --- Trace Context (AsyncLocalStorage) ---
export {
  forgeContextStore,
  withForgeContext,
  currentForgeContext,
} from './trace-context-store.js'
export type { ForgeTraceContext } from './trace-context-store.js'

// --- ForgeTracer ---
export { ForgeTracer } from './tracer.js'
export type { ForgeTracerConfig, ForgeTraceSnapshot } from './tracer.js'

// --- Event-to-Metric Mapping ---
export { EVENT_METRIC_MAP, getAllMetricNames } from './event-metric-map.js'
export type { MetricMapping } from './event-metric-map.js'

// --- OTel Bridge ---
export { OTelBridge, InMemoryMetricSink } from './otel-bridge.js'
export type { OTelBridgeConfig, MetricSink } from './otel-bridge.js'

// --- Cost Attribution ---
export { CostAttributor } from './cost-attribution.js'
export type {
  CostEntry,
  CostReport,
  CostAlertThreshold,
  CostAttributorConfig,
} from './cost-attribution.js'

// --- Safety Monitor ---
export { SafetyMonitor } from './safety-monitor.js'
export type {
  SafetyCategory,
  SafetySeverity,
  SafetyEvent,
  SafetyPatternRule,
  SafetyMonitorConfig,
} from './safety-monitor.js'

// --- Audit Trail ---
export { AuditTrail, InMemoryAuditStore } from './audit-trail.js'
export type {
  AuditCategory,
  AuditEntry,
  AuditStore,
  AuditTrailConfig,
} from './audit-trail.js'

// --- OTel Plugin Factory (ECO-022) ---
export { createOTelPlugin } from './otel-plugin.js'
export type { OTelPluginConfig } from './otel-plugin.js'

// --- Version ---
export const FORGEAGENT_OTEL_VERSION = '0.1.0'
