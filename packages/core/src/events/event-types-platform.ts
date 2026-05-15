/**
 * Identity, registry, protocol, security/policy/safety, vector store,
 * hooks/plugins, quality, degraded operation, recovery, and ledger events
 * emitted from cross-cutting platform layers.
 */
export type PlatformDomainEvent =
  // --- Identity ---
  | { type: 'identity:resolved'; agentId: string; uri: string }
  | { type: 'identity:failed'; agentId: string; error: string }
  | { type: 'identity:credential_expired'; agentId: string; credentialType: string }
  | { type: 'identity:trust_updated'; agentId: string; previousScore: number; newScore: number }
  | { type: 'identity:delegation_issued'; delegator: string; delegatee: string; tokenId: string }
  // --- Registry ---
  | { type: 'registry:agent_registered'; agentId: string; name: string }
  | { type: 'registry:agent_deregistered'; agentId: string; reason: string }
  | { type: 'registry:agent_updated'; agentId: string; fields: string[] }
  | { type: 'registry:health_changed'; agentId: string; previousStatus: string; newStatus: string }
  | { type: 'registry:capability_added'; agentId: string; capability: string }
  // --- Protocol ---
  | { type: 'protocol:message_sent'; protocol: string; to: string; messageType: string; payload?: Record<string, unknown> }
  | { type: 'protocol:message_received'; protocol: string; from: string; messageType: string }
  | { type: 'protocol:error'; protocol: string; error: string }
  | { type: 'protocol:connected'; protocol: string; endpoint: string }
  | { type: 'protocol:disconnected'; protocol: string; endpoint: string }
  | { type: 'protocol:state_changed'; protocol: string; previousState: string; newState: string }
  // --- Security ---
  | { type: 'policy:evaluated'; policySetId: string; action: string; effect: string; durationUs: number }
  | { type: 'policy:denied'; policySetId: string; action: string; principalId: string; reason: string }
  | { type: 'policy:set_updated'; policySetId: string; version: number }
  | {
      type: 'policy:conformance_violation'
      providerId: string
      field: string
      reason: string
      severity: 'error' | 'warning'
      conformanceMode: 'strict' | 'warn-only'
      fallbackBehavior: 'continue_primary_attempt' | 'continue_fallback_attempt' | 'blocked_attempt'
      correlationId?: string
    }
  | {
      type: 'policy:legacy_option_deprecated'
      providerId: string
      optionKey: '__activePolicy' | '__policyConformanceMode'
      replacement: 'policyContext'
      correlationId?: string
    }
  | { type: 'safety:violation'; category: string; severity: string; agentId?: string; message: string }
  | { type: 'safety:blocked'; category: string; agentId?: string; action: string }
  | { type: 'safety:kill_requested'; agentId: string; reason: string }
  /**
   * Emitted when a tool result is blocked because the safety scanner found
   * a critical violation (e.g. prompt injection, secret leak). The blocked
   * result is replaced with a safe placeholder before reaching the LLM.
   */
  | {
      type: 'safety:tool_result_blocked'
      agentId?: string
      runId?: string
      toolName: string
      toolCallId?: string
      category: string
      severity: string
      action: string
      message: string
    }
  /**
   * Emitted when a tool result triggers a non-blocking safety warning.
   * The original tool result is preserved and forwarded to the LLM.
   */
  | {
      type: 'safety:tool_result_warning'
      agentId?: string
      runId?: string
      toolName: string
      toolCallId?: string
      category: string
      severity: string
      action: string
      message: string
    }
  // --- Vector Store ---
  | { type: 'vector:search_completed'; provider: string; collection: string; latencyMs: number; resultCount: number }
  | { type: 'vector:upsert_completed'; provider: string; collection: string; count: number; latencyMs: number }
  | { type: 'vector:embedding_completed'; provider: string; latencyMs: number; tokenCount?: number; costCents?: number }
  | { type: 'vector:error'; provider: string; collection: string; operation: string; message: string }
  // --- Hooks / plugins ---
  | { type: 'hook:error'; hookName: string; message: string }
  | { type: 'plugin:registered'; pluginName: string }
  // --- Quality metrics feedback loop ---
  | { type: 'correction:iteration'; nodeId: string; iteration: number; passed: boolean; qualityScore: number; durationMs: number }
  | { type: 'quality:degraded'; metric: string; value: number; threshold: number; recommendation: string; details: Record<string, unknown> }
  | { type: 'quality:adjusted'; adjustment: string; reason: string; previousValue: unknown; newValue: unknown; reversible: boolean }
  // --- Degraded operation ---
  | { type: 'system:degraded'; subsystem: string; reason: string; timestamp: number; recoverable: boolean }
  | { type: 'system:consolidation_started' }
  | { type: 'system:consolidation_completed'; durationMs: number; recordsProcessed: number; pruned: number; merged: number }
  | { type: 'system:consolidation_failed'; error: string; durationMs: number }
  | { type: 'cache:degraded'; operation: string; recoverable: boolean }
  | { type: 'memory:index_failed'; namespace: string; recoverable: boolean }
  | { type: 'context:transfer_partial'; recoverable: boolean }
  | { type: 'context:compress_failed'; error: string; phase: string }
  // --- Recovery extended ---
  | { type: 'recovery:attempt_started'; agentId: string; runId: string; attempt: number; maxAttempts: number; strategy: string; timestamp: number }
  | { type: 'recovery:succeeded'; agentId: string; runId: string; attempt: number; strategy: string; durationMs: number }
  | { type: 'recovery:exhausted'; agentId: string; runId: string; attempts: number; strategies: string[]; durationMs: number; lastError?: string }
  | {
      type: 'recovery:escalation_requested'
      requestId: string
      failedProviderId: string
      error: string
      /**
       * Summary of prior recovery attempts. Adapter-layer types are kept
       * as plain `Record<string, unknown>` so core does not depend on
       * adapter-specific provider id types.
       */
      attempts: ReadonlyArray<Record<string, unknown>>
      suggestions: string[]
      timestamp: number
    }
  // --- Execution ledger ---
  | { type: 'ledger:execution_recorded'; providerId: string }
  | { type: 'ledger:prompt_recorded'; executionRunId: string }
  | { type: 'ledger:tool_recorded'; toolName: string }
  | { type: 'ledger:cost_recorded'; costCents: number }
  | { type: 'ledger:artifact_recorded'; artifactType: string }
  | { type: 'ledger:budget_warning'; workflowRunId: string; usedCents: number; limitCents: number }
  | { type: 'ledger:budget_exceeded'; workflowRunId: string; usedCents: number; limitCents: number }
