import type { AdapterRuntimeDzupEvent } from "./event-types-shared.js";

/**
 * Pipeline, approval, human-contact, adapter-interaction, MCP, provider,
 * adapter-registry, supervisor, and delegation events emitted from
 * orchestration layers.
 */
export type OrchestrationDomainEvent =
  // --- Flow DSL emit nodes ---
  | {
      type: "flow:emit";
      runId: string;
      tenantId: string;
      event: string;
      payload: Record<string, unknown>;
    }
  // --- Pipeline (legacy phase changes) ---
  | { type: "pipeline:phase_changed"; phase: string; previousPhase: string }
  | { type: "pipeline:validation_failed"; phase: string; errors: string[] }
  // --- Approval ---
  | {
      type: "approval:requested";
      runId: string;
      plan: unknown;
      contactId?: string;
      channel?: string;
      request?: unknown;
      tenantId?: string;
    }
  | { type: "approval:granted"; runId: string; approvedBy?: string }
  | { type: "approval:rejected"; runId: string; reason?: string }
  | {
      type: "approval:timed_out";
      runId: string;
      contactId?: string;
      timeoutMs: number;
    }
  | {
      type: "approval:cancelled";
      runId: string;
      contactId?: string;
      reason?: string;
    }
  | {
      type: "approval:webhook_failed";
      runId: string;
      webhookUrl: string;
      attempts: number;
      error: string;
    }
  // --- Human Contact ---
  | {
      type: "human_contact:requested";
      runId: string;
      contactId: string;
      contactType: string;
      channel: string;
    }
  | {
      type: "human_contact:responded";
      runId: string;
      contactId: string;
      response: unknown;
    }
  | {
      type: "human_contact:timed_out";
      runId: string;
      contactId: string;
      fallback?: unknown;
    }
  // --- Adapter Interactions (mid-execution questions/permissions) ---
  | AdapterRuntimeDzupEvent
  | {
      type: "adapter:interaction_required";
      interactionId: string;
      providerId: string;
      question: string;
      kind: string;
      correlationId?: string;
    }
  | {
      type: "adapter:interaction_resolved";
      interactionId: string;
      providerId: string;
      question: string;
      answer: string;
      resolvedBy: string;
      correlationId?: string;
    }
  // --- MCP ---
  | { type: "mcp:connected"; serverName: string; toolCount: number }
  | { type: "mcp:disconnected"; serverName: string }
  | { type: "mcp:server_added"; serverId: string; transport: string }
  | { type: "mcp:server_updated"; serverId: string; fields: string[] }
  | { type: "mcp:server_removed"; serverId: string }
  | { type: "mcp:server_enabled"; serverId: string }
  | { type: "mcp:server_disabled"; serverId: string }
  | { type: "mcp:test_passed"; serverId: string; toolCount: number }
  | { type: "mcp:test_failed"; serverId: string; error: string }
  // --- Provider ---
  | { type: "provider:failed"; tier: string; provider: string; message: string }
  | { type: "provider:circuit_opened"; provider: string }
  | { type: "provider:circuit_closed"; provider: string }
  | {
      type: "provider:run_attempt";
      agentId: string;
      attempt: number;
      maxAttempts: number;
      provider: string;
      model: string;
      phase: "invoke" | "stream";
      runId?: string;
      tenantId?: string;
    }
  | {
      type: "provider:run_failure";
      agentId: string;
      attempt: number;
      provider: string;
      model: string;
      phase: "invoke" | "stream";
      reason: string;
      retrying: boolean;
      runId?: string;
      tenantId?: string;
    }
  | {
      type: "provider:run_selected";
      agentId: string;
      attempt: number;
      provider: string;
      model: string;
      phase: "invoke" | "stream";
      runId?: string;
      tenantId?: string;
    }
  // --- Adapter Registry ---
  | {
      type: "adapter_registry:provider_registered";
      providerId: string;
      name: string;
    }
  | {
      type: "adapter_registry:provider_deregistered";
      providerId: string;
      reason: string;
    }
  // --- Pipeline Runtime ---
  | { type: "pipeline:run_started"; pipelineId: string; runId: string }
  | {
      type: "pipeline:node_started";
      pipelineId: string;
      runId: string;
      nodeId: string;
      nodeType: string;
    }
  | {
      type: "pipeline:node_completed";
      pipelineId: string;
      runId: string;
      nodeId: string;
      durationMs: number;
    }
  | {
      type: "pipeline:node_failed";
      pipelineId: string;
      runId: string;
      nodeId: string;
      error: string;
    }
  | {
      type: "pipeline:node_skipped";
      pipelineId: string;
      runId: string;
      nodeId: string;
      reason: string;
    }
  | {
      type: "pipeline:suspended";
      pipelineId: string;
      runId: string;
      nodeId: string;
    }
  | {
      type: "pipeline:resumed";
      pipelineId: string;
      runId: string;
      nodeId: string;
    }
  | {
      type: "pipeline:loop_iteration";
      pipelineId: string;
      runId: string;
      nodeId: string;
      iteration: number;
    }
  | {
      type: "pipeline:checkpoint_saved";
      pipelineId: string;
      runId: string;
      version: number;
    }
  | {
      type: "pipeline:run_completed";
      pipelineId: string;
      runId: string;
      durationMs: number;
    }
  | {
      type: "pipeline:run_failed";
      pipelineId: string;
      runId: string;
      error: string;
    }
  | {
      type: "pipeline:node_retry";
      pipelineId: string;
      runId: string;
      nodeId: string;
      attempt: number;
      maxAttempts: number;
      error: string;
      backoffMs: number;
    }
  | {
      type: "pipeline:run_cancelled";
      pipelineId: string;
      runId: string;
      reason?: string;
    }
  // --- Delegation ---
  | {
      type: "delegation:started";
      parentRunId: string;
      targetAgentId: string;
      delegationId: string;
    }
  | {
      type: "delegation:completed";
      parentRunId: string;
      targetAgentId: string;
      delegationId: string;
      durationMs: number;
      success: boolean;
    }
  | {
      type: "delegation:failed";
      parentRunId: string;
      targetAgentId: string;
      delegationId: string;
      error: string;
    }
  | {
      type: "delegation:timeout";
      parentRunId: string;
      targetAgentId: string;
      delegationId: string;
      timeoutMs: number;
    }
  | {
      type: "delegation:cancelled";
      parentRunId: string;
      targetAgentId: string;
      delegationId: string;
    }
  // --- Supervisor ---
  | { type: "supervisor:delegating"; specialistId: string; task: string }
  | {
      type: "supervisor:delegation_complete";
      specialistId: string;
      task: string;
      success: boolean;
    }
  | {
      type: "supervisor:plan_created";
      goal: string;
      assignments: Array<{ task: string; specialistId: string }>;
      source?: "llm" | "keyword";
    }
  | { type: "supervisor:llm_decompose_fallback"; goal: string; error: string }
  | { type: "supervisor:circuit_breaker_filtered"; skipped: string[] }
  | {
      type: "supervisor:duplicate_specialist_assignment_ids";
      mode: "warn";
      duplicateSpecialists: Array<{
        specialistId: string;
        assignmentIndexes: number[];
        missingAssignmentIdIndexes: number[];
      }>;
      message: string;
    }
  | {
      type: "supervisor:merge_complete";
      mergeStatus: string;
      successCount: number;
      errorCount: number;
    }
  | {
      type: "supervisor:routing_decision";
      /** Legacy single-agent selection field. Prefer selectedSpecialists for new consumers. */
      agentId?: string;
      strategy: string;
      reason: string;
      fallbackReason?: string;
      selectedSpecialists?: string[];
      selectedCandidates?: string[];
      filteredSpecialists?: string[];
      candidateSpecialists?: string[];
      task?: string;
      taskId?: string;
      managerId?: string;
      source?: "direct-supervisor" | "delegating-supervisor";
      /** Stable decision ID for replay/audit (W7). Format: `<strategy>-<taskId>-<timestamp>`. */
      routingDecisionId?: string;
      /** Per-candidate rejection reasons for post-mortem trace (W6). */
      rejectionReasons?: Record<string, string>;
    };
