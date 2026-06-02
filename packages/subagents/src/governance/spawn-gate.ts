import type { SubagentSpec } from "../contracts/background-task.js";

/** Decision returned by a {@link SpawnPolicy} check. */
export type SpawnPolicyDecision =
  | { allow: true; requiresApproval: boolean }
  | { allow: false; reason: string };

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
}

/** Default policy: allow everything, never require approval. Hosts override. */
export const allowAllSpawnPolicy: SpawnPolicy = {
  check: () => ({ allow: true, requiresApproval: false }),
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
    approvalId: string
  ): Promise<
    | { outcome: "allowed" }
    | { outcome: "needs_approval" }
    | { outcome: "denied"; reason: string }
  > {
    const decision = await this.policy.check(spec, parentRunId);
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
}
