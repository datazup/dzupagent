import type { ForgeErrorCode } from '../errors/error-codes.js'

/**
 * Budget usage snapshot — emitted with budget warnings.
 */
export interface BudgetUsage {
  tokensUsed: number
  tokensLimit: number
  costCents: number
  costLimitCents: number
  iterations: number
  iterationsLimit: number
  percent: number
}

/**
 * Per-tool execution statistics emitted with `agent:stop_reason`.
 */
export interface ToolStatSummary {
  name: string
  calls: number
  errors: number
  totalMs: number
  avgMs: number
}

/**
 * Discriminated union of all events emitted through DzupEventBus.
 *
 * Each event has a `type` discriminator and type-specific payload fields.
 * Use `DzupEvent['type']` to enumerate all event types.
 */
export type DzupEvent =
  // --- Agent lifecycle ---
  | { type: 'agent:started'; agentId: string; runId: string }
  | { type: 'agent:completed'; agentId: string; runId: string; durationMs: number }
  | { type: 'agent:failed'; agentId: string; runId: string; errorCode: ForgeErrorCode; message: string }
  | { type: 'agent:stream_delta'; agentId: string; runId: string; content: string }
  | { type: 'agent:stream_done'; agentId: string; runId: string; finalContent: string }
  | { type: 'recovery:cancelled'; agentId: string; runId: string; attempts: number; durationMs: number; reason: string }
  // --- Tool lifecycle ---
  | { type: 'tool:called'; toolName: string; input: unknown; executionRunId?: string }
  | { type: 'tool:result'; toolName: string; durationMs: number; executionRunId?: string }
  | { type: 'tool:error'; toolName: string; errorCode: ForgeErrorCode; message: string; executionRunId?: string }
  // --- Memory ---
  | { type: 'memory:written'; namespace: string; key: string }
  | { type: 'memory:searched'; namespace: string; query: string; resultCount: number }
  | { type: 'memory:error'; namespace: string; message: string }
  | { type: 'memory:retrieval_source_failed'; source: string; error: string; durationMs: number; query: string }
  | { type: 'memory:retrieval_source_succeeded'; source: string; resultCount: number; durationMs: number }
  // --- Budget ---
  | { type: 'budget:warning'; level: 'warn' | 'critical'; usage: BudgetUsage }
  | { type: 'budget:exceeded'; reason: string; usage: BudgetUsage }
  // --- Pipeline ---
  | { type: 'pipeline:phase_changed'; phase: string; previousPhase: string }
  | { type: 'pipeline:validation_failed'; phase: string; errors: string[] }
  // --- Approval ---
  | { type: 'approval:requested'; runId: string; plan: unknown; contactId?: string; channel?: string; request?: unknown }
  | { type: 'approval:granted'; runId: string; approvedBy?: string }
  | { type: 'approval:rejected'; runId: string; reason?: string }
  // --- Human Contact ---
  | { type: 'human_contact:requested'; runId: string; contactId: string; contactType: string; channel: string }
  | { type: 'human_contact:responded'; runId: string; contactId: string; response: unknown }
  | { type: 'human_contact:timed_out'; runId: string; contactId: string; fallback?: unknown }
  // --- Adapter Interactions (mid-execution questions/permissions) ---
  | { type: 'adapter:interaction_required'; interactionId: string; providerId: string; question: string; kind: string; correlationId?: string }
  | { type: 'adapter:interaction_resolved'; interactionId: string; providerId: string; question: string; answer: string; resolvedBy: string; correlationId?: string }
  // --- MCP ---
  | { type: 'mcp:connected'; serverName: string; toolCount: number }
  | { type: 'mcp:disconnected'; serverName: string }
  | { type: 'mcp:server_added'; serverId: string; transport: string }
  | { type: 'mcp:server_updated'; serverId: string; fields: string[] }
  | { type: 'mcp:server_removed'; serverId: string }
  | { type: 'mcp:server_enabled'; serverId: string }
  | { type: 'mcp:server_disabled'; serverId: string }
  | { type: 'mcp:test_passed'; serverId: string; toolCount: number }
  | { type: 'mcp:test_failed'; serverId: string; error: string }
  // --- Provider ---
  | { type: 'provider:failed'; tier: string; provider: string; message: string }
  | { type: 'provider:circuit_opened'; provider: string }
  | { type: 'provider:circuit_closed'; provider: string }
  // --- Adapter Registry ---
  | { type: 'adapter_registry:provider_registered'; providerId: string; name: string }
  | { type: 'adapter_registry:provider_deregistered'; providerId: string; reason: string }
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
  | { type: 'protocol:message_sent'; protocol: string; to: string; messageType: string }
  | { type: 'protocol:message_received'; protocol: string; from: string; messageType: string }
  | { type: 'protocol:error'; protocol: string; error: string }
  | { type: 'protocol:connected'; protocol: string; endpoint: string }
  | { type: 'protocol:disconnected'; protocol: string; endpoint: string }
  | { type: 'protocol:state_changed'; protocol: string; previousState: string; newState: string }
  // --- Pipeline Runtime ---
  | { type: 'pipeline:run_started'; pipelineId: string; runId: string }
  | { type: 'pipeline:node_started'; pipelineId: string; runId: string; nodeId: string; nodeType: string }
  | { type: 'pipeline:node_completed'; pipelineId: string; runId: string; nodeId: string; durationMs: number }
  | { type: 'pipeline:node_failed'; pipelineId: string; runId: string; nodeId: string; error: string }
  | { type: 'pipeline:node_skipped'; pipelineId: string; runId: string; nodeId: string; reason: string }
  | { type: 'pipeline:suspended'; pipelineId: string; runId: string; nodeId: string }
  | { type: 'pipeline:resumed'; pipelineId: string; runId: string; nodeId: string }
  | { type: 'pipeline:loop_iteration'; pipelineId: string; runId: string; nodeId: string; iteration: number }
  | { type: 'pipeline:checkpoint_saved'; pipelineId: string; runId: string; version: number }
  | { type: 'pipeline:run_completed'; pipelineId: string; runId: string; durationMs: number }
  | { type: 'pipeline:run_failed'; pipelineId: string; runId: string; error: string }
  | { type: 'pipeline:node_retry'; pipelineId: string; runId: string; nodeId: string; attempt: number; maxAttempts: number; error: string; backoffMs: number }
  | { type: 'pipeline:run_cancelled'; pipelineId: string; runId: string; reason?: string }
  // --- Security ---
  | { type: 'policy:evaluated'; policySetId: string; action: string; effect: string; durationUs: number }
  | { type: 'policy:denied'; policySetId: string; action: string; principalId: string; reason: string }
  | { type: 'policy:set_updated'; policySetId: string; version: number }
  | { type: 'safety:violation'; category: string; severity: string; agentId?: string; message: string }
  | { type: 'safety:blocked'; category: string; agentId?: string; action: string }
  | { type: 'safety:kill_requested'; agentId: string; reason: string }
  | { type: 'memory:threat_detected'; threatType: string; namespace: string; key?: string }
  | { type: 'memory:quarantined'; namespace: string; key: string; reason: string }
  // --- Vector Store ---
  | { type: 'vector:search_completed'; provider: string; collection: string; latencyMs: number; resultCount: number }
  | { type: 'vector:upsert_completed'; provider: string; collection: string; count: number; latencyMs: number }
  | { type: 'vector:embedding_completed'; provider: string; latencyMs: number; tokenCount?: number; costCents?: number }
  | { type: 'vector:error'; provider: string; collection: string; operation: string; message: string }
  // --- Telemetry ---
  | { type: 'tool:latency'; toolName: string; durationMs: number; error?: string }
  | { type: 'agent:stop_reason'; agentId: string; reason: string; iterations: number; toolStats: ToolStatSummary[] }
  | { type: 'agent:stuck_detected'; agentId: string; reason: string; recovery: string; timestamp: number; repeatedTool?: string; escalationLevel?: number }
  | { type: 'agent:context_fallback'; agentId: string; reason: string; before: number; after: number }
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
  // --- Delegation ---
  | { type: 'delegation:started'; parentRunId: string; targetAgentId: string; delegationId: string }
  | { type: 'delegation:completed'; parentRunId: string; targetAgentId: string; delegationId: string; durationMs: number; success: boolean }
  | { type: 'delegation:failed'; parentRunId: string; targetAgentId: string; delegationId: string; error: string }
  | { type: 'delegation:timeout'; parentRunId: string; targetAgentId: string; delegationId: string; timeoutMs: number }
  | { type: 'delegation:cancelled'; parentRunId: string; targetAgentId: string; delegationId: string }
  // --- Supervisor ---
  | { type: 'supervisor:delegating'; specialistId: string; task: string }
  | { type: 'supervisor:delegation_complete'; specialistId: string; task: string; success: boolean }
  | { type: 'supervisor:plan_created'; goal: string; assignments: Array<{ task: string; specialistId: string }>; source?: 'llm' | 'keyword' }
  | { type: 'supervisor:llm_decompose_fallback'; goal: string; error: string }
  | { type: 'supervisor:circuit_breaker_filtered'; skipped: string[] }
  | { type: 'supervisor:merge_complete'; mergeStatus: string; successCount: number; errorCount: number }
  | { type: 'supervisor:routing_decision'; agentId: string; strategy: string; reason: string }
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
  // --- Agent progress ---
  | { type: 'agent:progress'; agentId: string; phase: string; percentage: number; message: string; timestamp: number }
  // --- Recovery extended ---
  | { type: 'recovery:attempt_started'; agentId: string; runId: string; attempt: number; maxAttempts: number; strategy: string; timestamp: number }
  | { type: 'recovery:succeeded'; agentId: string; runId: string; attempt: number; strategy: string; durationMs: number }
  | { type: 'recovery:exhausted'; agentId: string; runId: string; attempts: number; strategies: string[]; durationMs: number; lastError?: string }
  // --- Execution ledger ---
  | { type: 'ledger:execution_recorded'; providerId: string }
  | { type: 'ledger:prompt_recorded'; executionRunId: string }
  | { type: 'ledger:tool_recorded'; toolName: string }
  | { type: 'ledger:cost_recorded'; costCents: number }
  | { type: 'ledger:artifact_recorded'; artifactType: string }
  | { type: 'ledger:budget_warning'; workflowRunId: string; usedCents: number; limitCents: number }
  | { type: 'ledger:budget_exceeded'; workflowRunId: string; usedCents: number; limitCents: number }
  // --- Persona registry ---
  | { type: 'persona:created' }
  | { type: 'persona:version_created' }
  | { type: 'persona:version_activated' }
  | { type: 'persona:version_deprecated' }
  | { type: 'persona:version_archived' }
  | { type: 'persona:compiled' }
  | { type: 'persona:matched' }
  // --- Scheduler ---
  | { type: 'scheduler:started'; pollIntervalMs: number }
  | { type: 'scheduler:stopped' }
  | { type: 'scheduler:triggered'; scheduleId: string }
  | { type: 'scheduler:trigger_failed'; scheduleId: string }
  | { type: 'scheduler:schedule_created'; scheduleType: string }
  | { type: 'scheduler:schedule_enabled' }
  | { type: 'scheduler:schedule_disabled' }
  // --- Skill lifecycle ---
  | { type: 'skill:created' }
  | { type: 'skill:updated' }
  | { type: 'skill:refactored' }
  | { type: 'skill:review_requested' }
  | { type: 'skill:review_completed' }
  | { type: 'skill:activated' }
  | { type: 'skill:deprecated' }
  | { type: 'skill:archived' }
  | { type: 'skill:used' }
  | { type: 'skill:suggestion_created' }
  // --- Workflow domain ---
  | { type: 'workflow:brief_created' }
  | { type: 'workflow:spec_created' }
  | { type: 'workflow:spec_revised' }
  | { type: 'workflow:template_created'; mode: string }
  | { type: 'workflow:run_started' }
  | { type: 'workflow:run_status_changed'; newStatus: string }
  | { type: 'workflow:phase_entered' }
  | { type: 'workflow:run_completed'; durationMs: number }
  | { type: 'workflow:run_failed' }
  | { type: 'workflow:task_created' }
  | { type: 'workflow:task_assigned' }
  | { type: 'workflow:task_status_changed'; newStatus: string }
  | { type: 'workflow:task_completed'; durationMs: number }
  | { type: 'workflow:execution_started'; providerId: string }
  | { type: 'workflow:execution_completed'; durationMs: number }
  | { type: 'workflow:execution_failed' }
  | { type: 'workflow:prompt_recorded'; promptType: string }
  | { type: 'workflow:cost_recorded'; budgetBucket: string; costCents: number }
  | { type: 'workflow:cost_budget_warning' }
  | { type: 'workflow:cost_budget_exceeded' }
  | { type: 'workflow:artifact_saved'; artifactType: string }
  | { type: 'workflow:suggestion_created'; category: string }
  | { type: 'workflow:schedule_triggered'; scheduleId: string }
  // --- Run lifecycle (RunHandle) ---
  | { type: 'run:paused'; runId: string; agentId: string }
  | { type: 'run:resumed'; runId: string; agentId: string; resumeToken?: string; input?: unknown }
  | { type: 'run:cancelled'; runId: string; agentId: string; reason?: string }
  | { type: 'run:halted:token-exhausted'; agentId: string; runId?: string; iterations: number; reason: 'token_exhausted' }
  // --- Run outcome scoring (closed-loop self-improvement) ---
  | {
      type: 'run:scored'
      runId: string
      agentId?: string
      /** Weighted aggregate score in the range [0, 1]. */
      score: number
      /** Whether the run is considered a pass under the configured threshold. */
      passed: boolean
      /** Per-scorer breakdown — name, raw score, pass flag, and reasoning. */
      scorerBreakdown: Array<{
        scorerName: string
        score: number
        pass: boolean
        reasoning: string
      }>
      /** Event counts driving the score. */
      metrics: {
        totalEvents: number
        toolCalls: number
        toolErrors: number
        errors: number
        durationMs?: number
      }
      /** Epoch-ms when scoring completed. */
      scoredAt: number
    }
  // --- Mailbox ---
  | { type: 'mail:received'; message: { id: string; from: string; to: string; subject: string; body: Record<string, unknown>; createdAt: number } }
  // --- API Key lifecycle ---
  | { type: 'api-key:created'; id: string; ownerId: string; tier: string }
  | { type: 'api-key:revoked'; id: string; ownerId: string }
  | { type: 'api-key:validated'; id: string; ownerId: string; tier: string }
  // --- Flow Compiler (Wave 11 ADR §4) ---
  | { type: 'flow:compile_started'; compileId: string; inputKind: 'object' | 'json-string' }
  | { type: 'flow:compile_parsed'; compileId: string; astNodeType: string | null; errorCount: number }
  | { type: 'flow:compile_shape_validated'; compileId: string; errorCount: number }
  | { type: 'flow:compile_semantic_resolved'; compileId: string; resolvedCount: number; personaCount: number; errorCount: number }
  | { type: 'flow:compile_lowered'; compileId: string; target: 'skill-chain' | 'workflow-builder' | 'pipeline'; nodeCount: number; edgeCount: number; warningCount: number }
  | { type: 'flow:compile_completed'; compileId: string; target: 'skill-chain' | 'workflow-builder' | 'pipeline'; durationMs: number }
  | {
      type: 'flow:compile_result'
      compileId: string
      target: 'skill-chain' | 'workflow-builder' | 'pipeline'
      artifact: unknown
      warnings: Array<{ stage: 4; code: string; message: string; nodePath?: string }>
      reasons: Array<{
        code:
          | 'SEQUENTIAL_ONLY'
          | 'BRANCH_PRESENT'
          | 'PARALLEL_PRESENT'
          | 'SUSPEND_PRESENT'
          | 'FOR_EACH_PRESENT'
        message: string
      }>
    }
  | { type: 'flow:compile_failed'; compileId: string; stage: 1 | 2 | 3 | 4; errorCount: number; durationMs: number }

/** Extract a specific event by its type discriminator */
export type DzupEventOf<T extends DzupEvent['type']> = Extract<DzupEvent, { type: T }>
