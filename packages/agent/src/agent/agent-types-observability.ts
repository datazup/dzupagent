/**
 * Observability and diagnostics slices of {@link DzupAgentConfig}.
 *
 * Covers audit sinks, fallback telemetry, prompt-time tool stats, and tokenizer
 * configuration. Extracted from the original `agent-types.ts` barrel.
 */
import type { Tokenizer } from '@dzupagent/core/llm'
import type { LlmCallAuditSink } from '../observability/llm-call-audit.js'

/** Structured fallback diagnostic event payload. */
export interface FallbackDetailEvent {
  reason: string
  detail: string
  namespace: string
  /** Provider label (e.g. 'arrow', 'standard', 'summary'). Optional for backwards compatibility. */
  provider?: string
  tokensBefore?: number
  tokensAfter?: number
}

/**
 * Redaction mode for prompt/response payloads written to `auditStore`.
 *
 * - `off`: no redaction.
 * - `secrets`: redact high-risk secrets/tokens only.
 * - `secrets-and-pii`: redact secrets and PII markers.
 */
export type AuditRedactionMode = 'off' | 'secrets' | 'secrets-and-pii'

/** Configuration for LLM-call audit payload redaction/retention. */
export interface AuditRedactionPolicy {
  /**
   * Redaction mode applied to prompt/response/error payloads before writing
   * to the audit sink and before emitting `audit:sink_failure`.
   *
   * Default: `secrets-and-pii`.
   */
  mode?: AuditRedactionMode

  /**
   * Whether to include full `prompt` / `response` strings in audit entries.
   * Snippets remain enabled when available.
   *
   * Default: `true`.
   */
  includeFullPayloads?: boolean
}

/** Observability and tokenizer configuration slice. */
export interface ObservabilityConfigSlice {
  /**
   * Optional audit sink for LLM-call traceability (RF-12).
   *
   * When set, every model invocation made by the run engine — successful
   * or failed — is recorded as an {@link LlmCallAuditSink} entry capturing
   * model id, token usage, duration, success flag, and error (when
   * failed). Entries are recorded fire-and-forget so a slow or failing
   * sink never stalls a run.
   */
  auditStore?: LlmCallAuditSink

  /**
   * Optional redaction/retention policy for payloads captured by `auditStore`.
   * Defaults to redacting secrets + PII while still keeping full payload fields.
   */
  auditRedaction?: AuditRedactionPolicy

  /**
   * Telemetry callback invoked when memory falls back or compression truncates.
   * Receives a reason identifier plus before/after token counts.
   */
  onFallback?: (reason: string, before: number, after: number) => void

  /**
   * Structured diagnostic callback with richer context than onFallback.
   * Receives reason code, human-readable detail, provider label, namespace,
   * and optional token estimates. Never receives raw scope keys/values or
   * memory record content.
   */
  onFallbackDetail?: (event: FallbackDetailEvent) => void

  /**
   * Optional tool stats tracker for injecting preferred-tool hints
   * into the system prompt before the first LLM invocation.
   * Uses structural typing so callers can pass a ToolStatsTracker from core.
   */
  toolStatsTracker?: { formatAsPromptHint: (limit?: number, intent?: string) => string }

  /**
   * Optional real tokenizer for accurate token counting (MC-08).
   *
   * When set, the agent uses this tokenizer for conversation token estimation
   * (compression triggers, budget warnings) instead of the char/4 heuristic.
   *
   * When unset, the agent resolves a tokenizer from `defaultTokenizerRegistry`
   * keyed off the resolved model id, with a graceful fallback to the heuristic
   * tokenizer when no pattern matches or when an optional tokenizer backend
   * (`@anthropic-ai/tokenizer`, `js-tiktoken`) is not installed.
   */
  tokenizer?: Tokenizer
}
