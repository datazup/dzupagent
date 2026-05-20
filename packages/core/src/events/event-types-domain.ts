/**
 * Higher-level domain events: persona registry, scheduler, skill lifecycle,
 * workflow domain, run lifecycle (RunHandle), run-outcome scoring,
 * checkpoint/restore, mailbox, API key lifecycle, and flow compiler events.
 */
export type DomainLifecycleEvent =
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
  | { type: 'run:halted:token-exhausted'; agentId: string; runId?: string; iterations: number; reason: 'token_exhausted'; tenantId?: string }
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
  // --- Checkpoint / Restore (DSL flow nodes surfaced through agent tool results) ---
  | {
      type: 'checkpoint:created'
      runId: string
      nodeId: string
      label: string
      /** ISO-8601 timestamp the checkpoint was captured at. */
      checkpointAt: string
    }
  | {
      type: 'checkpoint:restored'
      runId: string
      checkpointLabel: string
      restored: boolean
      /** Optional reason — populated when `restored:false` (e.g. `checkpoint_not_found`). */
      reason?: string
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
      evidence?: {
        schema: 'dzupagent.flowCompileEvidence/v1'
        sourceKind: 'flow-object' | 'flow-json-string' | 'flow-document' | 'dzupflow-dsl'
        sourceHash: string
        compileId: string
        canonicalNodeIds: string[]
        canonicalNodePaths: Record<string, { type: string; id?: string }>
        loweredTarget: 'skill-chain' | 'workflow-builder' | 'pipeline'
        correlationIds: {
          compileId: string
          eventCorrelationId: string
          runId?: string
        }
      }
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
