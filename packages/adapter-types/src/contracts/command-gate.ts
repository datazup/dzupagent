/**
 * MPCO P4 — command-gate result projection & aggregation (spec §2.5, §4.3).
 *
 * Command gates (typecheck/lint/test) are the runtime result of the `validate`
 * node and are AUTHORITATIVE: a failed/timed-out gate overrides any LLM
 * agreement. `allowFailure` may downgrade `decisionImpact` to 'advisory' but
 * MUST NOT rewrite `status` to 'passed'.
 */

export type CommandGateStatus =
  | "passed"
  | "failed"
  | "blocked"
  | "timeout"
  | "skipped"
  | "rejected"
  | "partial"
  | "recovered";

/**
 * The 3-value impact union — SAME members everywhere in MPCO (type, scripts
 * projection, and the canonical-AST executor after P4 reconciliation). There is
 * deliberately NO 'none' member: the safe floor is 'advisory'.
 */
export type DecisionImpact =
  | "blocks_acceptance"
  | "blocks_auto_accept"
  | "advisory";

export interface CommandGateResult {
  command: string;
  cwd: string;
  exitCode: number;
  status: CommandGateStatus;
  required: boolean;
  decisionImpact: DecisionImpact;
  failureClass?: string;
  startedAt: string;
  completedAt: string;
  stdoutDigest: string;
  stderrDigest: string;
  outputUri?: string;
  redactionStatus: string;
}

const IMPACT_RANK: Record<DecisionImpact, number> = {
  advisory: 0,
  blocks_auto_accept: 1,
  blocks_acceptance: 2,
};

/** Worst (highest-rank) impact across results; empty => 'advisory'. */
export function aggregateGateImpact(
  results: CommandGateResult[],
): DecisionImpact {
  let worst: DecisionImpact = "advisory";
  for (const r of results) {
    if (IMPACT_RANK[r.decisionImpact] > IMPACT_RANK[worst]) {
      worst = r.decisionImpact;
    }
  }
  return worst;
}

/**
 * `allowFailure` downgrades a blocking impact to 'advisory'. It NEVER touches
 * `status` — a failed command stays 'failed'. Returns a new object (pure).
 */
export function applyAllowFailure(
  result: CommandGateResult,
  allowFailure: boolean,
): CommandGateResult {
  if (!allowFailure) return result;
  return { ...result, decisionImpact: "advisory" };
}
