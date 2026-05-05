/**
 * RF-12 — LLM-call audit log.
 *
 * Provides a compliance-grade record of every model invocation an agent
 * makes during a run. Each call (successful or failed) is captured as an
 * immutable {@link LlmCallAuditEntry} and pushed to a pluggable
 * {@link LlmCallAuditSink}.
 *
 * Audit recording is fire-and-forget — slow or failing sinks must never
 * block or fail a run. Callers wire a sink via
 * `DzupAgentConfig.auditStore` and the run engine emits one entry per
 * model invocation, after both success and failure paths.
 *
 * Designed for ISO/IEC 42001 / SOC 2 traceability: keep entries durable
 * and append-only when persisting downstream. The default
 * {@link InMemoryAuditStore} is intended for tests and development only.
 */

/** A single LLM invocation record. */
export interface LlmCallAuditEntry {
  /** Owning agent identifier (matches `DzupAgentConfig.id`). */
  agentId: string
  /** Run correlation id, when the invocation occurred inside a run. */
  runId?: string
  /** Resolved model identifier (e.g. provider/model string). */
  model: string
  /** Prompt tokens charged to this invocation (0 when unknown). */
  inputTokens: number
  /** Completion tokens emitted by this invocation (0 when unknown). */
  outputTokens: number
  /** Wall-clock duration of the invocation in milliseconds. */
  durationMs: number
  /** Epoch milliseconds when the entry was recorded. */
  timestamp: number
  /** True when the invocation returned without throwing. */
  success: boolean
  /** Error message captured when `success` is false. */
  error?: string
}

/**
 * Pluggable sink for LLM-call audit entries. Implementations may be sync
 * or async; the run engine calls `record` fire-and-forget so a slow sink
 * never stalls a run.
 */
export interface LlmCallAuditSink {
  record(entry: LlmCallAuditEntry): void | Promise<void>
}

/**
 * Default in-memory sink. Useful for tests and development; not intended
 * for production compliance retention.
 */
export class InMemoryAuditStore implements LlmCallAuditSink {
  readonly entries: LlmCallAuditEntry[] = []

  record(entry: LlmCallAuditEntry): void {
    this.entries.push(entry)
  }
}
