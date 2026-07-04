import type { SubagentSpec } from "../contracts/background-task.js";

/** Decision returned by a {@link SpawnPolicy} check. */
export type SpawnPolicyDecision =
  | { allow: true; requiresApproval: boolean }
  | { allow: false; reason: string };

/**
 * Full context of a spawn request, available to context-aware policies via
 * {@link SpawnPolicy.checkWithContext} (dynamic-subagents Spec 03 §2).
 * Structural controls that must not depend on policy opt-in (the depth bound)
 * are enforced by the runtime BEFORE any policy method is called.
 */
export interface SpawnContext {
  parentRunId: string;
  /** 0 = spawned by the top-level run. */
  depth: number;
  /** Task whose execution requested this spawn, when spawned from inside a task. */
  originTaskId?: string;
  /** Present when the spawn originates from a fan-out batch. */
  batch?: {
    batchId: string;
    /** Declared items in the batch. */
    batchSize: number;
    mode: "template" | "script";
    /** Whether a batch-level gate decision already passed (Phase B hardening). */
    approved: boolean;
    /**
     * The template spec the batch was approved against (Phase B hardening). When
     * present, {@link SpawnGate.evaluate} enforces {@link validateBatchScope}
     * BEFORE the per-item policy call: a per-item spec may only NARROW the
     * approved template (never widen `agentId`, `outboundScope`, or
     * `memoryScope`). This prevents a batch coordinator from smuggling a
     * broader-scoped spawn past a batch-level approval.
     */
    template?: SubagentSpec;
  };
}

/** Fan-out batch mode (mirrors {@link SpawnContext} `batch.mode`). */
export type SpawnBatchMode = "template" | "script";

/**
 * Batch-level gate request (Phase B hardening). A fan-out coordinator submits
 * the batch template + declared item keys to {@link SpawnGate.evaluateBatch}
 * ONCE before dispatching any item, obtaining a single approval decision keyed
 * by `batchId` — the per-item spawns then run under that approval and are
 * scope-checked against `template` via {@link validateBatchScope}.
 */
export interface SpawnBatchRequest {
  batchId: string;
  parentRunId: string;
  mode: SpawnBatchMode;
  template: SubagentSpec;
  itemKeys: string[];
}

/** A batch that has passed the batch-level gate; threaded to per-item spawns. */
export interface ApprovedSpawnBatch {
  batchId: string;
  mode: SpawnBatchMode;
  template: SubagentSpec;
  itemKeys: string[];
}

/**
 * The policy seam. A host supplies a policy that inspects the spec (agentId,
 * outboundScope, memoryScope) and the parent run, returning whether the spawn is
 * allowed and whether it must pass a human approval gate first. This is where the
 * governance moat lives — kept injectable so hosts plug in their own policy
 * engine without this package importing it.
 *
 * Dispatch rule (see {@link SpawnGate.evaluate}): when a policy defines
 * `checkWithContext`, the gate calls it with the full {@link SpawnContext};
 * otherwise it calls `check(spec, ctx.parentRunId)` — legacy policies always
 * receive a plain string, never an object. (A union-typed second parameter was
 * rejected: it is compile-compatible via method bivariance but runtime-unsafe —
 * an old policy doing `parentRunId.startsWith(...)` would throw on the object
 * form.)
 */
export interface SpawnPolicy {
  check(
    spec: SubagentSpec,
    parentRunId: string,
  ): Promise<SpawnPolicyDecision> | SpawnPolicyDecision;
  /** Additive opt-in for context-aware (batch/depth-aware) policies. */
  checkWithContext?(
    spec: SubagentSpec,
    ctx: SpawnContext,
  ): Promise<SpawnPolicyDecision> | SpawnPolicyDecision;
}

/**
 * Permissive policy: allow everything, never require approval. Opt-in only —
 * suitable for trusted in-process orchestration and tests.
 *
 * @deprecated Test-only. Never wire this into host-facing or production code —
 * it grants an unbounded, tenant-unscoped spawn surface that an LLM tool loop
 * could exploit to fan out unbounded work (AGENT-L-10). Supply an explicit
 * {@link SpawnPolicy} that grants narrowly; production wiring should default to
 * deny and grant explicitly.
 */
export const allowAllSpawnPolicy: SpawnPolicy = {
  check: () => ({ allow: true, requiresApproval: false }),
};

/**
 * Deny-by-default policy (AGENT-L-10). The safe default for any host-facing
 * wiring: a spawn is rejected unless the host supplies a policy that explicitly
 * permits it. Prevents the subagent runtime from shipping an allow-all spawn
 * surface that an LLM tool loop could exploit to fan out unbounded work.
 */
export const denyAllSpawnPolicy: SpawnPolicy = {
  check: () => ({
    allow: false,
    reason: "spawn_denied_by_default_policy",
  }),
};

/**
 * Minimal HITL seam, structurally compatible with `ApprovalGate` from
 * `@dzupagent/hitl-kit` (`waitForApproval` resolves on grant, throws
 * `ApprovalRejectedError` on reject). Kept as a local interface so tests need no
 * real gate and so a host can wire any approval backend.
 */
export interface SpawnApprovalGate {
  waitForApproval(runId: string, approvalId: string): Promise<unknown>;
}

export type ApprovalOutcome =
  | { approved: true }
  | { approved: false; reason: string };

/**
 * Runs the spawn governance flow: policy check, then (if required) a blocking
 * HITL approval. Returns a structured decision the runtime turns into task state
 * + governance/runtime events. Never throws for an expected denial/rejection.
 */
export class SpawnGate {
  constructor(
    private readonly policy: SpawnPolicy,
    private readonly approvalGate?: SpawnApprovalGate,
  ) {}

  async evaluate(
    spec: SubagentSpec,
    parentRunIdOrContext: string | SpawnContext,
    approvalId: string,
  ): Promise<
    | { outcome: "allowed" }
    | { outcome: "needs_approval" }
    | { outcome: "denied"; reason: string }
  > {
    const ctx: SpawnContext =
      typeof parentRunIdOrContext === "string"
        ? { parentRunId: parentRunIdOrContext, depth: 0 }
        : parentRunIdOrContext;
    // Batch scope-narrowing invariant (Phase B hardening): a per-item spawn that
    // carries an approved batch template may only narrow it. Enforced BEFORE the
    // per-item policy call so a widened spec cannot reach the policy at all.
    if (ctx.batch?.template !== undefined) {
      const scope = validateBatchScope(spec, ctx.batch.template);
      if (!scope.allow) {
        return { outcome: "denied", reason: scope.reason };
      }
    }
    // Dispatch rule (Spec 03 §2): context-aware policies get the full context;
    // legacy policies keep receiving a plain string (never the context object).
    const decision = this.policy.checkWithContext
      ? await this.policy.checkWithContext(spec, ctx)
      : await this.policy.check(spec, ctx.parentRunId);
    if (!decision.allow) {
      return { outcome: "denied", reason: decision.reason };
    }
    if (decision.requiresApproval) {
      return { outcome: "needs_approval" };
    }
    return { outcome: "allowed" };
  }

  /**
   * Batch-level gate (Phase B hardening). Evaluates a fan-out batch ONCE, keyed
   * by `batchId`, before any item is dispatched. The batch template is checked
   * through the SAME policy seam as a single spawn (context-aware policies see a
   * `batch`-flavoured {@link SpawnContext}); a `needs_approval` decision is a
   * single batch-level approval, not one-per-item. The per-item spawns then run
   * under this decision and are scope-narrowed against the template by
   * {@link evaluate} (via {@link validateBatchScope}).
   */
  async evaluateBatch(
    request: SpawnBatchRequest,
  ): Promise<
    | { outcome: "allowed" }
    | { outcome: "needs_approval" }
    | { outcome: "denied"; reason: string }
  > {
    const ctx: SpawnContext = {
      parentRunId: request.parentRunId,
      depth: 0,
      batch: {
        batchId: request.batchId,
        batchSize: request.itemKeys.length,
        mode: request.mode,
        approved: false,
        template: request.template,
      },
    };
    // Batch-level check: evaluate the TEMPLATE (not a per-item spec), so
    // validateBatchScope is a no-op here (template compared against itself).
    const decision = this.policy.checkWithContext
      ? await this.policy.checkWithContext(request.template, ctx)
      : await this.policy.check(request.template, ctx.parentRunId);
    if (!decision.allow) {
      return { outcome: "denied", reason: decision.reason };
    }
    if (decision.requiresApproval) {
      return { outcome: "needs_approval" };
    }
    return { outcome: "allowed" };
  }

  /** Block on the HITL gate. Returns the resolved outcome. */
  async awaitApproval(
    parentRunId: string,
    approvalId: string,
  ): Promise<ApprovalOutcome> {
    if (!this.approvalGate) {
      // No gate wired but policy demanded approval — fail closed.
      return {
        approved: false,
        reason: "approval_required_but_no_gate_configured",
      };
    }
    try {
      await this.approvalGate.waitForApproval(parentRunId, approvalId);
      return { approved: true };
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "approval_rejected";
      return { approved: false, reason };
    }
  }
}

/**
 * Batch scope-narrowing invariant (Phase B hardening). A per-item fan-out spawn
 * may only NARROW the batch template it was approved against — never widen it.
 * A widening attempt is denied BEFORE any per-item policy call. Three ranked
 * checks (returns the first violation):
 *
 * 1. `agentId` — MUST match the template exactly (dispatching a different agent
 *    is a full escape from the approved surface).
 * 2. `outboundScope` — MUST be a subset of the template's scopes.
 * 3. `memoryScope` — MUST NOT widen (rank `global < workspace < project < agent`,
 *    where a higher rank is narrower).
 */
export function validateBatchScope(
  spec: SubagentSpec,
  template: SubagentSpec,
): { allow: true } | { allow: false; reason: string } {
  if (spec.agentId !== template.agentId) {
    return { allow: false, reason: "batch_scope_widened: agentId" };
  }
  if (!isOutboundScopeSubset(spec.outboundScope, template.outboundScope)) {
    return { allow: false, reason: "batch_scope_widened: outboundScope" };
  }
  if (!isMemoryScopeNarrowed(spec.memoryScope, template.memoryScope)) {
    return { allow: false, reason: "batch_scope_widened: memoryScope" };
  }
  return { allow: true };
}

function isOutboundScopeSubset(
  requested: string[] | undefined,
  approved: string[] | undefined,
): boolean {
  if (requested === undefined || requested.length === 0) return true;
  if (approved === undefined) return false;
  const allowed = new Set(approved);
  return requested.every((scope) => allowed.has(scope));
}

function isMemoryScopeNarrowed(
  requested: SubagentSpec["memoryScope"],
  approved: SubagentSpec["memoryScope"],
): boolean {
  if (requested === undefined || approved === undefined) return true;
  const ranks: Record<NonNullable<SubagentSpec["memoryScope"]>, number> = {
    global: 0,
    workspace: 1,
    project: 2,
    agent: 3,
  };
  return ranks[requested] >= ranks[approved];
}
