/**
 * @dzupagent/core/utils — Logger, backoff, hashing, telemetry, observability,
 * concurrency primitives, output format adapters, guardrails, version.
 *
 * @example
 * ```ts
 * import {
 *   defaultLogger,
 *   calculateBackoff,
 *   Semaphore,
 *   StuckDetector,
 * } from '@dzupagent/core/utils'
 * ```
 */

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------
export { MetricsCollector, globalMetrics } from './observability/metrics-collector.js'
export type { MetricType } from './observability/metrics-collector.js'
export { HealthAggregator } from './observability/health-aggregator.js'
export type {
  HealthStatus,
  HealthCheck,
  HealthReport,
  HealthCheckFn,
} from './observability/health-aggregator.js'

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------
export { Semaphore } from './concurrency/semaphore.js'
export { ConcurrencyPool } from './concurrency/pool.js'
export type { PoolConfig, PoolStats } from './concurrency/pool.js'

// ---------------------------------------------------------------------------
// Output format adapters
// ---------------------------------------------------------------------------
export type {
  OutputFormat,
  FormatAdapter,
  FormatValidationResult,
} from './output/format-adapter.js'
export { FORMAT_ADAPTERS, validateFormat, detectFormat } from './output/format-adapter.js'

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------
export {
  injectTraceContext,
  extractTraceContext,
  formatTraceparent,
  parseTraceparent,
} from './telemetry/trace-propagation.js'
export type { TraceContext } from './telemetry/trace-propagation.js'

// ---------------------------------------------------------------------------
// Generic utils
// ---------------------------------------------------------------------------
export { defaultLogger, noopLogger } from './utils/logger.js'
export type { FrameworkLogger } from './utils/logger.js'
export { createSecureLogger, logger as secureLogger } from './logging/secure-logger.js'
export type {
  SecureLogger,
  SecureLogEntry,
  SecureLoggerOptions,
} from './logging/secure-logger.js'
export { calculateBackoff } from './utils/backoff.js'
export type { BackoffConfig } from './utils/backoff.js'
export { hashToolInput } from './utils/hash.js'
export { omitUndefined } from './utils/exact-optional.js'
export type { OmitUndefined } from './utils/exact-optional.js'
export { getString, getNumber, getObject, toJsonString } from './utils/event-record.js'

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------
export { StuckDetector } from './guardrails/stuck-detector.js'
export type { StuckStatus, StuckDetectorConfig } from './guardrails/stuck-detector.js'

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------
export const dzupagent_CORE_VERSION = '0.2.0'
