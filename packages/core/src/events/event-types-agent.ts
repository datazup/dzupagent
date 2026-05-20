import type { ForgeErrorCode } from '../errors/error-codes.js'
import type { PermissionTier } from '../tools/permission-tier.js'
import type { ToolStatSummary } from './event-types-shared.js'

/**
 * Agent-, tool-, and LLM-invocation lifecycle events plus associated
 * memory, budget, and telemetry surfaces emitted from the agent loop.
 */
export type AgentDomainEvent =
  // --- Agent lifecycle ---
  | { type: 'agent:started'; agentId: string; runId: string }
  | {
      type: 'agent:completed'
      agentId: string
      runId: string
      durationMs: number
      /**
       * Optional token usage summary. Adapter-layer producers populate this
       * when available; consumers should treat it as best-effort metadata.
       */
      usage?: {
        inputTokens?: number
        outputTokens?: number
        cachedInputTokens?: number
        costCents?: number
        /** Optional model name for downstream attribution. */
        model?: string
      }
    }
  | { type: 'agent:failed'; agentId: string; runId: string; errorCode: ForgeErrorCode; message: string }
  | { type: 'agent:rate_limited'; agentId: string; reason: string }
  /**
   * Emitted once at agent construction after applying the configured
   * permission tier to the resolved tool list (MC-AGT-05).
   *
   * `effectiveTier` is the resolved tier (caller-provided or the
   * `'read-only'` default). `filteredTools` enumerates the names of tools
   * that were dropped — i.e. tools whose `requiredTier` is more permissive
   * than `effectiveTier`. The model never sees these tools.
   */
  | {
      type: 'agent:tools-filtered'
      agentId: string
      effectiveTier: PermissionTier
      totalTools: number
      allowedTools: number
      filteredTools: string[]
    }
  | { type: 'agent:stream_delta'; agentId: string; runId: string; content: string; tenantId?: string }
  | { type: 'agent:stream_done'; agentId: string; runId: string; finalContent: string; tenantId?: string }
  | { type: 'recovery:cancelled'; agentId: string; runId: string; attempts: number; durationMs: number; reason: string }
  // --- Tool lifecycle (canonical contract — RF-AGENT-05) ---
  // Each tool invocation produces a `tool:called` followed by exactly one
  // terminal event (`tool:result` or `tool:error`). Terminal events carry
  // a `status` discriminator so consumers can branch on outcome without
  // sniffing the message text. The `inputMetadataKeys` field on
  // `tool:called` records ONLY the top-level keys of the validated tool
  // input — never the values — to avoid leaking secrets into telemetry.
  | {
      type: 'tool:called'
      toolName: string
      /** @deprecated Raw input values are not emitted by default. Use inputMetadataKeys. */
      input?: unknown
      executionRunId?: string
      /** Owning agent (when provided by the caller). */
      agentId?: string
      /** Durable run identifier (alias for executionRunId at the canonical layer). */
      runId?: string
      /** Stable id correlating `tool:called` with its terminal event. */
      toolCallId?: string
      /** Top-level keys of the validated tool input — values are never logged. */
      inputMetadataKeys?: string[]
      /** Owning tenant; consumed by event-gateway tenant filtering (DZUPAGENT-SEC-M-01). */
      tenantId?: string
    }
  | {
      type: 'tool:result'
      toolName: string
      durationMs: number
      executionRunId?: string
      agentId?: string
      runId?: string
      toolCallId?: string
      inputMetadataKeys?: string[]
      /** Outcome discriminator. `'success'` is the canonical happy path. */
      status?: 'success'
      /** Owning tenant; consumed by event-gateway tenant filtering (DZUPAGENT-SEC-M-01). */
      tenantId?: string
    }
  | {
      type: 'tool:cancel_requested'
      toolName: string
      executionRunId?: string
      agentId?: string
      runId?: string
      toolCallId?: string
      inputMetadataKeys?: string[]
      status?: 'cancel_requested'
      reason: 'timeout' | 'run_cancelled'
      timeoutMs?: number
    }
  | {
      type: 'tool:error'
      toolName: string
      errorCode: ForgeErrorCode
      message: string
      executionRunId?: string
      agentId?: string
      runId?: string
      toolCallId?: string
      inputMetadataKeys?: string[]
      durationMs?: number
      /** Outcome discriminator. */
      status?: 'error' | 'timeout' | 'denied' | 'cancelled' | 'cancel_requested'
      /** Alias for `message` to match the canonical contract field name. */
      errorMessage?: string
      /** Owning tenant; consumed by event-gateway tenant filtering (DZUPAGENT-SEC-M-01). */
      tenantId?: string
    }
  | {
      type: 'tool:output:invalid'
      toolName: string
      toolCallId?: string
      agentId?: string
      runId?: string
      error: string
    }
  // --- Telemetry derived from the agent/tool loop ---
  | { type: 'tool:latency'; toolName: string; durationMs: number; error?: string }
  | { type: 'agent:stop_reason'; agentId: string; reason: string; iterations: number; toolStats: ToolStatSummary[] }
  | { type: 'agent:stuck_detected'; agentId: string; reason: string; recovery: string; timestamp: number; repeatedTool?: string; escalationLevel?: number }
  | {
      type: 'agent:context_fallback'
      agentId: string
      reason: string
      before: number
      after: number
      /** Optional provider label (e.g. 'arrow', 'standard', 'summary'). Never includes raw scope or memory content. */
      provider?: string
      /** Optional logical namespace for the failed memory load. Never includes scope keys/values. */
      namespace?: string
      /** Optional human-readable detail (typically `error.message`). Never includes scope or memory content. */
      detail?: string
    }
  | {
      type: 'agent:structured_schema_prepared'
      agentId: string
      schemaName: string
      schemaHash: string
      provider: string
      topLevelType: string | null
      propertyCount: number
      requiredCount: number
    }
  | {
      type: 'agent:structured_native_rejected'
      agentId: string
      schemaName: string
      schemaHash: string
      provider: string
      model: string
      message: string
    }
  | {
      type: 'agent:structured_fallback_used'
      agentId: string
      schemaName: string
      schemaHash: string
      provider: string
      model: string
      from: 'native_provider'
      to: 'text_json'
    }
  | {
      type: 'agent:structured_validation_failed'
      agentId: string
      schemaName: string
      schemaHash: string
      provider: string
      model: string
      message: string
    }
  // --- Agent progress ---
  | {
      type: 'agent:progress'
      agentId: string
      phase: string
      percentage: number
      message: string
      timestamp: number
      /** Optional structured progress metadata for machine consumers. */
      details?: Record<string, unknown>
    }
