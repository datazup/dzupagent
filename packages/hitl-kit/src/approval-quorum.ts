/**
 * Multi-approver quorum evaluation — pure, store-agnostic.
 *
 * {@link ApprovalGate} and {@link ApprovalStateStore} are single-approver by
 * construction: one `(runId, approvalId)` key resolves to one outcome. This
 * module answers the question a multi-approver gate needs on top of that:
 * given a policy and the votes received so far, is the request granted,
 * rejected, or still pending?
 *
 * Strategies:
 *
 *   - `all`      — every approver must grant; one rejection rejects.
 *   - `any`      — one grant suffices; rejected only when every approver rejects.
 *   - `majority` — `floor(n / 2) + 1` grants. An even split is not a
 *     majority, so a tie fails closed.
 *
 * The first vote recorded for an approver wins; later votes from the same
 * approver are ignored (mirrors the store's first-decision-wins rule).
 * No clock, no I/O.
 */

export type QuorumStrategy = "all" | "any" | "majority";

export interface QuorumPolicy {
  strategy: QuorumStrategy;
  /** Distinct, non-blank approver ids. Order is preserved in tallies. */
  approvers: readonly string[];
}

export interface ApproverVote {
  approverId: string;
  decision: "granted" | "rejected";
  reason?: string;
  response?: unknown;
}

export interface QuorumTally {
  status: "pending" | "granted" | "rejected";
  /** Number of grants needed to reach quorum. */
  required: number;
  /** Approver ids, in policy order. */
  granted: string[];
  rejected: string[];
  outstanding: string[];
}

/** Thrown when a quorum policy is malformed. */
export class InvalidQuorumPolicyError extends Error {
  constructor(message: string) {
    super(`Invalid quorum policy: ${message}`);
    this.name = "InvalidQuorumPolicyError";
  }
}

/** Thrown when a vote comes from an id not listed in the policy. */
export class UnknownApproverError extends Error {
  constructor(approverId: string) {
    super(`Approver ${approverId} is not part of the quorum policy`);
    this.name = "UnknownApproverError";
  }
}

function validatePolicy(policy: QuorumPolicy): void {
  if (
    policy.strategy !== "all" &&
    policy.strategy !== "any" &&
    policy.strategy !== "majority"
  ) {
    throw new InvalidQuorumPolicyError(
      `unknown strategy ${String(policy.strategy)}`
    );
  }
  if (policy.approvers.length === 0) {
    throw new InvalidQuorumPolicyError("approvers must not be empty");
  }
  const seen = new Set<string>();
  for (const id of policy.approvers) {
    if (id.trim() === "") {
      throw new InvalidQuorumPolicyError("approver ids must not be blank");
    }
    if (seen.has(id)) {
      throw new InvalidQuorumPolicyError(`duplicate approver ${id}`);
    }
    seen.add(id);
  }
}

/** Number of grants needed for `policy` to reach quorum. */
export function requiredApprovals(policy: QuorumPolicy): number {
  validatePolicy(policy);
  const n = policy.approvers.length;
  switch (policy.strategy) {
    case "all":
      return n;
    case "any":
      return 1;
    case "majority":
      return Math.floor(n / 2) + 1;
  }
}

/**
 * Tally `votes` against `policy`. Granted once grants reach
 * {@link requiredApprovals}; rejected once enough rejections make that
 * unreachable; pending otherwise.
 */
export function evaluateQuorum(
  policy: QuorumPolicy,
  votes: readonly ApproverVote[]
): QuorumTally {
  const required = requiredApprovals(policy);
  const members = new Set(policy.approvers);
  const decisions = new Map<string, ApproverVote["decision"]>();
  for (const vote of votes) {
    if (!members.has(vote.approverId)) {
      throw new UnknownApproverError(vote.approverId);
    }
    if (!decisions.has(vote.approverId)) {
      decisions.set(vote.approverId, vote.decision);
    }
  }

  const granted: string[] = [];
  const rejected: string[] = [];
  const outstanding: string[] = [];
  for (const id of policy.approvers) {
    const decision = decisions.get(id);
    if (decision === "granted") granted.push(id);
    else if (decision === "rejected") rejected.push(id);
    else outstanding.push(id);
  }

  let status: QuorumTally["status"] = "pending";
  if (granted.length >= required) status = "granted";
  else if (rejected.length > policy.approvers.length - required) {
    status = "rejected";
  }
  return { status, required, granted, rejected, outstanding };
}
