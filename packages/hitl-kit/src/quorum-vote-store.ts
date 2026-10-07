/**
 * Quorum vote persistence — stores the per-approver votes that
 * {@link evaluateQuorum} tallies, keyed like {@link ApprovalStateStore} by
 * `(runId, approvalId)`.
 *
 * {@link InMemoryQuorumVoteStore} is the single-process default. Durable
 * adapters must pass the shared contract suite in
 * `src/__tests__/quorum-vote-store-contract.ts`.
 */

import {
  evaluateQuorum,
  UnknownApproverError,
  type ApproverVote,
  type QuorumPolicy,
  type QuorumTally,
} from "./approval-quorum.js";

/**
 * Backing store for quorum votes.
 *
 * Implementations MUST:
 *   - Keep only the first vote per approver for a key (a database adapter
 *     enforces this with a unique `(runId, approvalId, approverId)` constraint
 *     so concurrent writers cannot both win).
 *   - Return votes in recording order, as copies that callers may mutate.
 *   - Reject a malformed vote with {@link InvalidQuorumVoteError} without
 *     storing it.
 */
export interface QuorumVoteStore {
  /**
   * Persist a vote. Returns `true` when stored, `false` when the approver has
   * already voted for this key (the stored vote is left unchanged).
   */
  recordVote(
    runId: string,
    approvalId: string,
    vote: ApproverVote
  ): Promise<boolean>;

  /** Stored votes in recording order; `[]` for an unknown key. */
  listVotes(runId: string, approvalId: string): Promise<ApproverVote[]>;

  /** Drop every vote for the key. No-op for an unknown key. */
  clearVotes(runId: string, approvalId: string): Promise<void>;
}

/** Thrown when a vote has a blank approver id or an unknown decision. */
export class InvalidQuorumVoteError extends Error {
  constructor(message: string) {
    super(`Invalid quorum vote: ${message}`);
    this.name = "InvalidQuorumVoteError";
  }
}

function validateVote(vote: ApproverVote): void {
  if (typeof vote.approverId !== "string" || vote.approverId.trim() === "") {
    throw new InvalidQuorumVoteError("approverId must not be blank");
  }
  if (vote.decision !== "granted" && vote.decision !== "rejected") {
    throw new InvalidQuorumVoteError(
      `unknown decision ${String(vote.decision)}`
    );
  }
}

function copyVote(vote: ApproverVote): ApproverVote {
  const copy: ApproverVote = {
    approverId: vote.approverId,
    decision: vote.decision,
  };
  if (vote.reason !== undefined) copy.reason = vote.reason;
  if (vote.response !== undefined) copy.response = structuredClone(vote.response);
  return copy;
}

/** Single-process store backed by nested Maps (no key-separator collisions). */
export class InMemoryQuorumVoteStore implements QuorumVoteStore {
  private readonly runs = new Map<string, Map<string, ApproverVote[]>>();

  async recordVote(
    runId: string,
    approvalId: string,
    vote: ApproverVote
  ): Promise<boolean> {
    validateVote(vote);
    let approvals = this.runs.get(runId);
    if (!approvals) {
      approvals = new Map();
      this.runs.set(runId, approvals);
    }
    let votes = approvals.get(approvalId);
    if (!votes) {
      votes = [];
      approvals.set(approvalId, votes);
    }
    if (votes.some((v) => v.approverId === vote.approverId)) {
      return false;
    }
    votes.push(copyVote(vote));
    return true;
  }

  async listVotes(runId: string, approvalId: string): Promise<ApproverVote[]> {
    const votes = this.runs.get(runId)?.get(approvalId) ?? [];
    return votes.map(copyVote);
  }

  async clearVotes(runId: string, approvalId: string): Promise<void> {
    const approvals = this.runs.get(runId);
    if (!approvals) return;
    approvals.delete(approvalId);
    if (approvals.size === 0) this.runs.delete(runId);
  }
}

/**
 * Record `vote` against `policy` and return the resulting tally. Validates
 * the policy and the voter's membership before touching the store. Once the
 * tally is terminal the decision is final: further votes are not stored and
 * the terminal tally is returned unchanged.
 */
export async function recordQuorumVote(
  store: QuorumVoteStore,
  policy: QuorumPolicy,
  runId: string,
  approvalId: string,
  vote: ApproverVote
): Promise<QuorumTally> {
  const current = evaluateQuorum(
    policy,
    await store.listVotes(runId, approvalId)
  );
  if (!policy.approvers.includes(vote.approverId)) {
    throw new UnknownApproverError(vote.approverId);
  }
  if (current.status !== "pending") {
    return current;
  }
  await store.recordVote(runId, approvalId, vote);
  return evaluateQuorum(policy, await store.listVotes(runId, approvalId));
}
