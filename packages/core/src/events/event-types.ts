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
 * Discriminated union of all events emitted through ForgeEventBus.
 *
 * Each event has a `type` discriminator and type-specific payload fields.
 * Use `ForgeEvent['type']` to enumerate all event types.
 */
export type ForgeEvent =
  // --- Agent lifecycle ---
  | { type: 'agent:started'; agentId: string; runId: string }
  | { type: 'agent:completed'; agentId: string; runId: string; durationMs: number }
  | { type: 'agent:failed'; agentId: string; runId: string; errorCode: ForgeErrorCode; message: string }
  | { type: 'agent:stream_delta'; agentId: string; runId: string; content: string }
  | { type: 'agent:stream_done'; agentId: string; runId: string; finalContent: string }
  // --- Tool lifecycle ---
  | { type: 'tool:called'; toolName: string; input: unknown }
  | { type: 'tool:result'; toolName: string; durationMs: number }
  | { type: 'tool:error'; toolName: string; errorCode: ForgeErrorCode; message: string }
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
  | { type: 'approval:requested'; runId: string; plan: unknown }
  | { type: 'approval:granted'; runId: string; approvedBy?: string }
  | { type: 'approval:rejected'; runId: string; reason?: string }
  // --- MCP ---
  | { type: 'mcp:connected'; serverName: string; toolCount: number }
  | { type: 'mcp:disconnected'; serverName: string }
  // --- Provider ---
  | { type: 'provider:failed'; tier: string; provider: string; message: string }
  | { type: 'provider:circuit_opened'; provider: string }
  | { type: 'provider:circuit_closed'; provider: string }
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
  // --- Hooks / plugins ---
  | { type: 'hook:error'; hookName: string; message: string }
  | { type: 'plugin:registered'; pluginName: string }
  // --- Quality metrics feedback loop ---
  | { type: 'correction:iteration'; nodeId: string; iteration: number; passed: boolean; qualityScore: number; durationMs: number }
  | { type: 'quality:degraded'; metric: string; value: number; threshold: number; recommendation: string; details: Record<string, unknown> }
  | { type: 'quality:adjusted'; adjustment: string; reason: string; previousValue: unknown; newValue: unknown; reversible: boolean }

/** Extract a specific event by its type discriminator */
export type ForgeEventOf<T extends ForgeEvent['type']> = Extract<ForgeEvent, { type: T }>
