import type { RunStatus } from '../persistence/store-interfaces.js'

/**
 * Adapter-layer observability events: run lifecycle (one event per
 * intermediate or terminal {@link RunStatus}), session registry,
 * structured-output, and UCL enrichment.
 */
export type AdapterDomainEvent =
  // --- Adapter run lifecycle (adapter-layer observability) ---
  // Provider is `string` here so core does not depend on adapter-specific provider id types.
  | { type: 'adapter:run_pending'; runId: string; providerId?: string; status: RunStatus }
  | { type: 'adapter:run_queued'; runId: string; providerId?: string; status: RunStatus }
  | { type: 'adapter:run_running'; runId: string; providerId?: string; status: RunStatus }
  | { type: 'adapter:run_executing'; runId: string; providerId?: string; status: RunStatus }
  | { type: 'adapter:run_awaiting_approval'; runId: string; providerId?: string; status: RunStatus }
  | { type: 'adapter:run_approved'; runId: string; providerId?: string; status: RunStatus }
  | { type: 'adapter:run_paused'; runId: string; providerId?: string; status: RunStatus }
  | { type: 'adapter:run_suspended'; runId: string; providerId?: string; status: RunStatus }
  | { type: 'adapter:run_completed'; runId: string; providerId?: string; status: RunStatus }
  | { type: 'adapter:run_halted'; runId: string; providerId?: string; status: RunStatus }
  | { type: 'adapter:run_failed'; runId: string; providerId?: string; status: RunStatus }
  | { type: 'adapter:run_cancelled'; runId: string; providerId?: string; status: RunStatus }
  | { type: 'adapter:run_rejected'; runId: string; providerId?: string; status: RunStatus }
  // --- Session registry (adapter-layer) ---
  | { type: 'session:workflow_created'; workflowId: string }
  | { type: 'session:workflow_deleted'; workflowId: string }
  | { type: 'session:provider_linked'; workflowId: string; providerId: string; sessionId: string }
  | { type: 'session:provider_switched'; workflowId: string; from: string | undefined; to: string }
  | { type: 'session:multi_turn_completed'; workflowId: string; providerId: string | undefined; durationMs: number }
  | { type: 'session:pruned'; count: number }
  // --- Structured output (adapter-layer observability) ---
  | { type: 'structured_output:parsed'; schemaName: string; schemaHash?: string; providerId: string; attempts: number }
  | { type: 'structured_output:parse_failed'; schemaName: string; schemaHash?: string; providerId: string; attempt: number; error: string }
  | { type: 'structured_output:all_failed'; schemaName: string; schemaHash?: string; error: string }
  // --- UCL enrichment (adapter-layer observability) ---
  // Provider id is `string` here so core does not depend on the
  // adapter-specific `AdapterProviderId` literal union.
  | {
      type: 'adapter:memory_recalled'
      providerId: string
      timestamp: number
      entries: ReadonlyArray<{
        level: 'global' | 'workspace' | 'project' | 'agent'
        name: string
        tokenEstimate: number
      }>
      totalTokens: number
      durationMs: number
      correlationId?: string
    }
  | {
      type: 'adapter:skills_compiled'
      providerId: string
      timestamp: number
      skills: ReadonlyArray<{
        skillId: string
        degraded: string[]
        dropped: string[]
      }>
      durationMs: number
      correlationId?: string
    }
  | {
      type: 'adapter:cache_stats'
      providerId: string
      sessionId: string
      /** Tokens served from cache (billed at reduced rate) */
      cacheReadTokens: number
      /** Tokens written to cache (billed at premium rate) */
      cacheWriteTokens: number
      /** Total input tokens for this run (including cached) */
      totalInputTokens: number
      /** Fraction of input tokens that were cache hits (0–1) */
      cacheHitRatio: number
      timestamp: number
      correlationId?: string
    }
