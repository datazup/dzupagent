/**
 * Provider-neutral tracing ports used by orchestration runtimes.
 *
 * This module deliberately exposes types only. Concrete OpenTelemetry SDK
 * adapters remain host-owned, and importing this subpath cannot initialize a
 * tracer, exporter, collector, or provider.
 */

/** Canonical attributes emitted by the orchestration tool and agent loops. */
export interface OrchestratorSpanAttrs {
  "agent_loop.run_id"?: string
  "agent_loop.turn_count"?: number
  "agent_loop.pattern"?: string

  "tool_executor.risk_tier"?: string
  "tool_executor.idempotency_hit"?: boolean
  "tool_executor.tool_name"?: string

  "validation.tool_call_id"?: string
  "validation.status"?: string

  "llm.model"?: string

  "approval.action_id"?: string
}

/** Provider-neutral span status; adapters translate it to their SDK enum. */
export interface SpanStatus {
  code: "unset" | "ok" | "error"
  message?: string
}

/** Minimal span surface required by orchestration runtimes. */
export interface SpanPort {
  setAttribute(key: string, value: string | number | boolean): void
  recordException?(error: unknown): void
  setStatus?(status: SpanStatus): void
  end(): void
}

/** Minimal tracer surface required by orchestration runtimes. */
export interface TracerPort {
  startSpan(name: string, attrs?: OrchestratorSpanAttrs): SpanPort
}
