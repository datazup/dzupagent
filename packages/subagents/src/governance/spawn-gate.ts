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
  };
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
