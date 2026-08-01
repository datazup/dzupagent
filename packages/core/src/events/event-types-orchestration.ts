import type { AdapterRuntimeDzupEvent } from "./event-types-shared.js";

/**
 * Serialized position of the *issuing orchestrator* within the orchestration
 * tree, carried on `delegation:started` so an out-of-process observer can
 * reconstruct the tree from the event stream alone.
 *
 * ## Why this is a nested object and not three sibling fields
 *
 * `parentRunId` is an overloaded name denoting two distinct concepts that must
 * never be conflated:
 *
 * 1. {@link DelegationEventHierarchy.parentRunId} (this one) — the ORCHESTRATOR
 *    parent: the run of the supervisor that spawned the supervisor *issuing*
 *    this delegation as a sub-orchestrator. Absent for a root supervisor.
 * 2. The `parentRunId` field sitting directly on the `delegation:*` events — the
 *    DELEGATION parent: the run issuing this individual delegation to a
 *    specialist.
 *
 * For a root supervisor these are unrelated: (2) is typically set while (1) is
 * not. Nesting (1) under `hierarchy` makes the two unambiguous at every read
 * site — `event.hierarchy.parentRunId` can never be mistaken for
 * `event.parentRunId`, which three loose sibling fields would not guarantee.
 * That property matters more, not less, across the process boundary, where the
 * consumer is code this package does not control.
 *
 * Mirrors the in-process `DelegationHierarchy` contract in
 * `@dzupagent/agent`'s `orchestration/delegation/types.ts`. Every field is
 * optional and purely additive: a delegation issued with no hierarchy carries
 * no `hierarchy` key at all.
 */
export interface DelegationEventHierarchy {
  /** Orchestrator-hierarchy parent run ID, when the issuer is a sub-orchestrator. */
  parentRunId?: string;
  /** Branch identifier when the issuer runs inside a parallel/conditional tree. */
  branchId?: string;
  /**
   * Depth of the *issuing orchestrator* in the orchestration tree. Root = 0.
   *
   * This is the issuer's own depth, NOT the depth of the delegated work. A
   * delegation issued by a supervisor at depth N is attributed depth N and is
   * never incremented on the way to the event: the delegation is an action *of*
   * that supervisor, and its target is a specialist agent (a leaf), not another
   * orchestrator level.
   */
  depth?: number;
}

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
      /**
       * Run issuing this individual delegation — the DELEGATION parent.
       *
       * NOT the orchestrator-hierarchy parent. See {@link hierarchy} below and
       * `DelegationEventHierarchy` for the disambiguation.
       */
      parentRunId: string;
      targetAgentId: string;
      delegationId: string;
      /**
       * Orchestration-tree position of the issuing supervisor.
       *
       * Absent entirely for root supervisors, so a pre-hierarchy consumer sees a
       * byte-identical payload. Carried only on `delegation:started`: the four
       * terminal `delegation:*` events always follow a `started` event bearing
       * the same `delegationId`, so observers correlate on that key rather than
       * receiving four redundant copies of the same immutable tree position.
       */
      hierarchy?: DelegationEventHierarchy;
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
  // --- Contract-Net Protocol ---
  // Typed lifecycle events for the contract-net negotiation protocol
  // (Call-For-Proposals → bidding → award → execution). Emitted by
  // `ContractNetManager` in @dzupagent/agent. These replace the earlier
  // `protocol:message_sent` conflation (see DZUPAGENT-AGENT-INFO-02) so
  // otel/metrics can observe contract-net phases without decoding an opaque
  // `messageType` string. `cfpId` correlates every event of one negotiation.
  | {
      /** Phase 1: a Call-For-Proposals was broadcast to the specialists. */
      type: "contractnet:announced";
      cfpId: string;
      task: string;
    }
  | {
      /** Phase 2: a single specialist's bid was parsed and recorded. */
      type: "contractnet:bid_received";
      cfpId: string;
      agentId: string;
    }
  | {
      /** Phase 4: the contract was awarded to the winning bidder. */
      type: "contractnet:awarded";
      cfpId: string;
      winnerId: string;
    }
  | {
      /** Phase 5: the winning specialist finished the task successfully. */
      type: "contractnet:completed";
      cfpId: string;
      agentId: string;
      durationMs: number;
    }
  | {
      /**
       * The negotiation failed. `phase` distinguishes a bidding-stage failure
       * (no bids received, even after retry — `reason` set, no `agentId`) from
       * an execution-stage failure (winner threw — `agentId` + `error` set).
       */
      type: "contractnet:failed";
      cfpId: string;
      phase: "bidding" | "executing";
      agentId?: string;
      reason?: string;
      error?: string;
    }
  // --- Team Runtime ---
  // Typed lifecycle events for `TeamRuntime` in @dzupagent/agent. These mirror
  // a SUBSET of the richer `TeamRuntimeEvent` union that the runtime hands to
  // its `onEvent` callback: `onEvent` is the host's per-instance observer,
  // whereas these are the process-wide domain events that otel/metrics can
  // observe (a `MetricMapFragment` keys off `DzupEvent['type']`, so an event
  // that never reaches the bus can never drive a metric).
  //
  // Only bounded-cardinality fields are modelled here. `runId` is carried for
  // correlation but must NOT be used as a metric label — it is unbounded, the
  // same reason contract-net keeps the free-form `task` off its labels.
  // Free-form strings from `TeamRuntimeEvent` (error messages, namespaces) are
  // deliberately omitted rather than forwarded.
  | {
      /** A team run finished successfully. */
      type: "team:completed";
      teamId: string;
      runId: string;
      coordinatorPattern: string;
      durationMs: number;
    }
  | {
      /** A team run terminated through the failure path. */
      type: "team:failed";
      teamId: string;
      runId: string;
      coordinatorPattern: string;
    }
  | {
      /** Sanitized proof result for TeamRuntime's initial task handoff. */
      type: "team:context_handoff_budget_evaluated";
      teamId: string;
      runId: string;
      coordinatorPattern: string;
      contentTokenLimit: number;
      reservedTokens: number;
      outputReservedTokens?: number;
      summaryReservedTokens?: number;
      toolReservedTokens?: number;
      envelopeTokens?: number;
      measuredTokens: number;
      measurementMethod: "exact" | "encoding-fallback" | "heuristic";
      satisfied: boolean;
      adoptionSafe: boolean;
      truncated: boolean;
      markerIncluded: boolean;
      profileSchemaVersion?: "1";
      profileId?: string;
      profileRevision?: string;
      provider?: string;
      model?: string;
      tokenizerId?: string;
      tokenizerRevision?: string;
      tokenizerEncoding?: string;
    }
  | {
      /**
       * A governance / evaluation acceptance gate was reached.
       *
       * `outcome: 'skipped'` means the policy declared a threshold but no
       * scorer service was injected, so the run passed ungated. A non-zero
       * rate of skipped verdicts is a misconfiguration to alert on, which is
       * precisely why this reaches the bus rather than only `onEvent`.
       */
      type: "team:verdict_evaluated";
      teamId: string;
      runId: string;
      gate: "governance" | "evaluation";
      outcome: "passed" | "rejected" | "skipped";
      /** Absent on `skipped` — no scorer ran, so there is no score. */
      score?: number;
      /**
       * Why a `skipped` verdict was skipped; absent on passed/rejected.
       *
       * `unwired` — the threshold was declared but no scorer was injected (a
       * static wiring mistake). `scorer_failed` — a scorer was wired and could
       * not produce a verdict (a live outage, during which every run passes a
       * gate someone is relying on). Alert on them separately.
       */
      reason?: "unwired" | "scorer_failed";
    }
  | {
      /**
       * A declared post-run memory consolidation pass did not complete —
       * either no memory service was wired (`unwired`) or a wired one threw
       * (`failed`). Run outcomes are unaffected; consolidation is non-fatal.
       */
      type: "team:consolidation_skipped";
      teamId: string;
      runId: string;
      reason: "unwired" | "failed";
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
