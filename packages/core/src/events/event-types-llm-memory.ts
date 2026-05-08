import type { BudgetUsage, LlmInvocationRecord } from './event-types-shared.js'

/**
 * LLM invocation, memory, and budget events emitted by the runtime.
 */
export type LlmMemoryDomainEvent =
  // --- LLM invocation (compliance/audit) ---
  | {
      type: 'llm:invoked'
      agentId: string
      runId?: string
      model: string
      inputTokens: number
      outputTokens: number
      /** Cache-read tokens (Anthropic: cached_input_tokens). Billed at ~10% of input price. */
      cacheReadTokens?: number
      /** Cache-write tokens (Anthropic: cache_creation_input_tokens). Billed at ~125% of input price. */
      cacheWriteTokens?: number
      costCents: number
      timestamp: number
    }
  /**
   * Structured audit-trail record emitted on every LLM invocation routed
   * through the framework adapter layer. Subscribed to by SOC2/compliance
   * sinks (durable audit log) and the learning-candidate review pipeline.
   *
   * Emission contract:
   *   - one event per terminal LLM call (success or adapter/network failure)
   *   - never blocks the LLM call; emission failures are swallowed
   *   - `usage` and `costCents` are present only when the adapter reports them
   *   - `runId`/`tenantId` are present only inside a run context
   */
  | ({ type: 'llm:invocation_recorded' } & LlmInvocationRecord)
  // --- Memory ---
  | {
      type: 'memory:written'
      namespace: string
      key: string
      agentId?: string
      runId?: string
      scopeKeys?: string[]
    }
  | { type: 'memory:pii_redacted'; agentId: string }
  | { type: 'memory:searched'; namespace: string; query: string; resultCount: number }
  | {
      type: 'memory:error'
      namespace: string
      message: string
      key?: string
      agentId?: string
      runId?: string
      scopeKeys?: string[]
    }
  | { type: 'memory:retrieval_source_failed'; source: string; error: string; durationMs: number; query: string }
  | { type: 'memory:retrieval_source_succeeded'; source: string; resultCount: number; durationMs: number }
  | { type: 'memory:threat_detected'; threatType: string; namespace: string; key?: string }
  | { type: 'memory:quarantined'; namespace: string; key: string; reason: string }
  // --- Budget ---
  | { type: 'budget:warning'; level: 'warn' | 'critical'; usage: BudgetUsage }
  | { type: 'budget:exceeded'; reason: string; usage: BudgetUsage }
