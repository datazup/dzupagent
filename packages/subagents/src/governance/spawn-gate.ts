import type { SubagentSpec } from "../contracts/background-task.js";

/** Decision returned by a {@link SpawnPolicy} check. */
export type SpawnPolicyDecision =
  | { allow: true; requiresApproval: boolean }
  | { allow: false; reason: string };

export type SpawnBatchMode = "template" | "script";

export interface SpawnBatchRequest {
  batchId: string;
  parentRunId: string;
  mode: SpawnBatchMode;
  template: SubagentSpec;
  itemKeys: string[];
}

export interface ApprovedSpawnBatch {
  batchId: string;
  mode: SpawnBatchMode;
  template: SubagentSpec;
  itemKeys: string[];
}

export type SpawnPolicyContext =
  | {
      kind: "batch";
      batchId: string;
      batchSize: number;
      itemKeys: string[];
      mode: SpawnBatchMode;
    }
  | {
      kind: "batch_item";
      batchId: string;
      batchSize: number;
      itemKey?: string;
      mode: SpawnBatchMode;
      batchApproved: true;
    };

export interface SpawnEvaluationContext {
  batch: ApprovedSpawnBatch;
  itemKey?: string;
}

/**
 * The policy seam. A host supplies a policy that inspects the spec (agentId,
 * outboundScope, memoryScope) and the parent run, returning whether the spawn is
 * allowed and whether it must pass a human approval gate first. This is where the
 * governance moat lives — kept injectable so hosts plug in their own policy
 * engine without this package importing it.
 */
export interface SpawnPolicy {
  check(
    spec: SubagentSpec,
    parentRunId: string
  ): Promise<SpawnPolicyDecision> | SpawnPolicyDecision;
  checkWithContext?(
    spec: SubagentSpec,
    parentRunId: string,
    context: SpawnPolicyContext
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
    private readonly approvalGate?: SpawnApprovalGate
  ) {}

  async evaluate(
    spec: SubagentSpec,
    parentRunId: string,
    approvalId: string,
    context?: SpawnEvaluationContext
  ): Promise<
    | { outcome: "allowed" }
    | { outcome: "needs_approval" }
    | { outcome: "denied"; reason: string }
  > {
    void approvalId;

    if (context !== undefined) {
      const scopeDecision = validateBatchScope(spec, context.batch.template);
      if (!scopeDecision.allow) {
        return { outcome: "denied", reason: scopeDecision.reason };
      }
    }

    const decision = await this.checkPolicy(
      spec,
      parentRunId,
      context !== undefined
        ? {
            kind: "batch_item",
            batchId: context.batch.batchId,
            batchSize: context.batch.itemKeys.length,
            ...(context.itemKey !== undefined ? { itemKey: context.itemKey } : {}),
            mode: context.batch.mode,
            batchApproved: true,
          }
        : undefined
    );
    if (!decision.allow) {
      return { outcome: "denied", reason: decision.reason };
    }
    if (context !== undefined) {
      return { outcome: "allowed" };
    }
    if (decision.requiresApproval) {
      return { outcome: "needs_approval" };
    }
    return { outcome: "allowed" };
  }

  async evaluateBatch(
    request: SpawnBatchRequest
  ): Promise<
    | { outcome: "allowed" }
    | { outcome: "needs_approval" }
    | { outcome: "denied"; reason: string }
  > {
    const decision = await this.checkPolicy(request.template, request.parentRunId, {
      kind: "batch",
      batchId: request.batchId,
      batchSize: request.itemKeys.length,
      itemKeys: request.itemKeys,
      mode: request.mode,
    });
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
    approvalId: string
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

  private async checkPolicy(
    spec: SubagentSpec,
    parentRunId: string,
    context?: SpawnPolicyContext
  ): Promise<SpawnPolicyDecision> {
    if (context !== undefined && this.policy.checkWithContext !== undefined) {
      return this.policy.checkWithContext(spec, parentRunId, context);
    }
    return this.policy.check(spec, parentRunId);
  }
}

function validateBatchScope(
  spec: SubagentSpec,
  template: SubagentSpec
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
  approved: string[] | undefined
): boolean {
  if (requested === undefined || requested.length === 0) return true;
  if (approved === undefined) return false;
  const allowed = new Set(approved);
  return requested.every((scope) => allowed.has(scope));
}

function isMemoryScopeNarrowed(
  requested: SubagentSpec["memoryScope"],
  approved: SubagentSpec["memoryScope"]
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
