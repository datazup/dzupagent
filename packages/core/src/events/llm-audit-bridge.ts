import type { DzupEventBus } from './event-bus.js'
import type { LlmInvocationRecord } from './event-types.js'
import { defaultLogger, type FrameworkLogger } from '../utils/logger.js'

/**
 * Best-effort sink for LLM-invocation audit records.
 *
 * Adapter-layer code (e.g. {@link AdapterStreamRunner}) calls a sink for every
 * terminal LLM call so downstream consumers can persist a durable audit trail
 * without parsing event logs. Sink callbacks MUST be synchronous and MUST NOT
 * throw — implementations should defer any I/O to a separate task.
 */
export type LlmAuditSink = (record: LlmInvocationRecord) => void

/**
 * Build an {@link LlmAuditSink} that emits each record as an
 * `llm:invocation_recorded` event on the supplied bus. The returned sink is
 * safe to inject into adapters: emission errors are caught and logged so a
 * misbehaving handler can never break the LLM call path.
 *
 * @example
 * ```ts
 * const bus = createEventBus()
 * const sink = attachLlmAuditEventBridge(bus)
 * new OpenAIAdapter({ apiKey, auditSink: sink })
 * ```
 */
export function attachLlmAuditEventBridge(
  bus: DzupEventBus,
  logger: FrameworkLogger = defaultLogger,
): LlmAuditSink {
  return (record) => {
    try {
      bus.emit({ type: 'llm:invocation_recorded', ...record })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error(`[llm-audit-bridge] failed to emit invocation record: ${msg}`)
    }
  }
}
