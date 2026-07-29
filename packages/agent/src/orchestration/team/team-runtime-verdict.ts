/**
 * Post-run quality-gate helpers for `TeamRuntime` — governance and evaluation.
 *
 * These policy groups (`governance.minScore` / `governance.requireUnanimous`
 * and `evaluation.minPassScore`) express *acceptance thresholds* on a team
 * run's outcome. TeamRuntime cannot itself decide whether an outcome "scores
 * 0.8" — that judgement is model/criteria specific. So, exactly like the
 * memory-consolidation seam (`consolidateIfEnabled`), the runtime delegates
 * the scoring to a host-injected verdict service and only owns the *gating
 * logic*: read the policy, invoke the injected scorer, compare against the
 * declared threshold, emit a lifecycle event, and reject the run when the
 * threshold is not met.
 *
 * When no verdict service is wired the fields do not gate: they are
 * shape-checked at construction and the run passes through. This keeps the
 * thresholds declarable on a `TeamDefinition` that will later be promoted into
 * an environment that supplies a scorer.
 *
 * That pass-through is NOT silent. A declared-but-unwired gate emits a
 * `team_verdict_evaluated` event with `outcome: 'skipped'`, because otherwise
 * "the bar was met" and "the bar was never checked" look identical from the
 * outside — and the second is a misconfiguration that should be alertable. The
 * run outcome is unchanged either way; only the reporting is.
 *
 * For a wireable in-repo implementation see `createDeterministicVerdictService`
 * in `@dzupagent/testing`, which scores from observable run facts and needs no
 * model or API key.
 */

import type { TeamPolicies } from "./team-policy.js";
import type { TeamRunResult } from "./team-workspace.js";
import type { TeamRuntimeEventEmitter } from "./team-runtime-events.js";

/** Numeric verdict returned by a governance / evaluation scorer. */
export interface TeamVerdict {
  /** Score in [0, 1]. */
  score: number;
  /**
   * Whether the scoring was unanimous. Only consulted by the governance gate
   * when `governance.requireUnanimous` is set; ignored otherwise.
   */
  unanimous?: boolean;
  /**
   * Set by a scorer that could NOT actually judge the run and is declining to
   * gate it, rather than reporting a real verdict.
   *
   * A scorer with a `skip` failure policy has to return something, and the only
   * non-gating value `score` can take is a passing one. That makes an outage
   * indistinguishable from a genuine unanimous pass — the exact silent-success
   * failure this contract exists to prevent elsewhere. Setting this flag lets
   * the gate report `outcome: 'skipped'` with `reason: 'scorer_failed'` instead
   * of counting a fabricated pass.
   *
   * The run outcome is unchanged: `notScored` still does not gate. Only the
   * reporting differs — which is the whole point, since a judge that is down
   * during a release is worth knowing about.
   */
  notScored?: boolean;
}

/**
 * Host-injected scorer for the `governance` policy group (council pattern).
 *
 * Invoked after a council run completes when `governance.minScore` or
 * `governance.requireUnanimous` is declared. Receives the run result and the
 * effective policies (so the implementation can read `governance.judgeModel`).
 */
export interface TeamGovernanceService {
  evaluate(input: TeamVerdictInput): Promise<TeamVerdict>;
}

/**
 * Host-injected scorer for the `evaluation` policy group (any pattern).
 *
 * Invoked after a run completes when `evaluation.minPassScore` is declared.
 * Receives the run result plus the effective policies (so the implementation
 * can read `evaluation.scorerModel` / `evaluation.scoringCriteria`).
 */
export interface TeamEvaluationService {
  score(input: TeamVerdictInput): Promise<TeamVerdict>;
}

/** Input handed to a governance / evaluation scorer. */
export interface TeamVerdictInput {
  teamId: string;
  runId: string;
  task: string;
  result: TeamRunResult;
  policies: TeamPolicies;
}

/** Raised when a run fails a governance / evaluation acceptance threshold. */
export class TeamVerdictRejectedError extends Error {
  constructor(readonly gate: "governance" | "evaluation", message: string) {
    super(message);
    this.name = "TeamVerdictRejectedError";
  }
}

export interface VerdictGateContext {
  teamId: string;
  runId: string;
  task: string;
  result: TeamRunResult;
  policies: TeamPolicies;
  governance: TeamGovernanceService | undefined;
  evaluation: TeamEvaluationService | undefined;
  emitEvent: TeamRuntimeEventEmitter;
}

/**
 * Apply governance then evaluation acceptance gates to a completed run.
 *
 * Governance runs first (council-scoped quality bar), evaluation second
 * (pattern-agnostic final scoring). A gate only fires when BOTH the relevant
 * policy threshold is declared AND a scorer service is injected; otherwise it
 * is a no-op. On a failing gate this throws `TeamVerdictRejectedError`, which
 * the executor routes through the normal failure path (team_failed event).
 */
export async function applyVerdictGates(
  ctx: VerdictGateContext
): Promise<void> {
  await applyGovernanceGate(ctx);
  await applyEvaluationGate(ctx);
}

async function applyGovernanceGate(ctx: VerdictGateContext): Promise<void> {
  const governance = ctx.policies.governance;
  if (!governance) return;

  const gates =
    governance.minScore !== undefined || governance.requireUnanimous === true;
  if (!gates) return;
  if (!ctx.governance) {
    // The policy declared an acceptance threshold but no scorer is wired, so
    // the gate cannot be applied and the run passes ungated. Announce that
    // rather than returning silently: a caller who wrote `minScore: 0.9` and
    // sees clean runs would otherwise have no way to tell the bar was never
    // checked. The run outcome is deliberately unchanged (see the `skipped`
    // docs on TeamRuntimeEvent) — this is an observability signal, not a new
    // failure mode.
    emitSkipped(ctx, "governance", "unwired");
    return;
  }

  const verdict = await ctx.governance.evaluate(verdictInput(ctx));

  // A scorer that declined to judge does not gate, but must not be counted as a
  // pass either — see `notScored` on TeamVerdict.
  if (verdict.notScored === true) {
    emitSkipped(ctx, "governance", "scorer_failed");
    return;
  }

  if (
    governance.minScore !== undefined &&
    verdict.score < governance.minScore
  ) {
    emitVerdict(ctx, "governance", "rejected", verdict.score);
    throw new TeamVerdictRejectedError(
      "governance",
      `TeamRuntime[${ctx.teamId}]: run rejected by governance.minScore ` +
        `(score ${verdict.score} < ${governance.minScore})`
    );
  }
  if (governance.requireUnanimous === true && verdict.unanimous !== true) {
    emitVerdict(ctx, "governance", "rejected", verdict.score);
    throw new TeamVerdictRejectedError(
      "governance",
      `TeamRuntime[${ctx.teamId}]: run rejected by governance.requireUnanimous ` +
        `(judgement was not unanimous)`
    );
  }
  emitVerdict(ctx, "governance", "passed", verdict.score);
}

async function applyEvaluationGate(ctx: VerdictGateContext): Promise<void> {
  const evaluation = ctx.policies.evaluation;
  if (!evaluation) return;
  if (evaluation.minPassScore === undefined) return;
  if (!ctx.evaluation) {
    // Same reasoning as the governance gate above: a declared-but-unwired
    // threshold is reported, not silently ignored.
    emitSkipped(ctx, "evaluation", "unwired");
    return;
  }

  const verdict = await ctx.evaluation.score(verdictInput(ctx));

  if (verdict.notScored === true) {
    emitSkipped(ctx, "evaluation", "scorer_failed");
    return;
  }

  if (verdict.score < evaluation.minPassScore) {
    emitVerdict(ctx, "evaluation", "rejected", verdict.score);
    throw new TeamVerdictRejectedError(
      "evaluation",
      `TeamRuntime[${ctx.teamId}]: run rejected by evaluation.minPassScore ` +
        `(score ${verdict.score} < ${evaluation.minPassScore})`
    );
  }
  emitVerdict(ctx, "evaluation", "passed", verdict.score);
}

function verdictInput(ctx: VerdictGateContext): TeamVerdictInput {
  return {
    teamId: ctx.teamId,
    runId: ctx.runId,
    task: ctx.task,
    result: ctx.result,
    policies: ctx.policies,
  };
}

function emitVerdict(
  ctx: VerdictGateContext,
  gate: "governance" | "evaluation",
  outcome: "passed" | "rejected",
  score: number
): void {
  ctx.emitEvent({
    type: "team_verdict_evaluated",
    teamId: ctx.teamId,
    runId: ctx.runId,
    gate,
    outcome,
    score,
    at: new Date(),
  });
}

/**
 * Report a gate that was declared in policy but could not be applied.
 *
 * Kept separate from {@link emitVerdict} rather than folded in behind an
 * optional `score` so the required-`score` signature there still holds: a
 * passed/rejected verdict must always carry the number it was decided on, and
 * a skipped one has no number to carry.
 *
 * `reason` is required here even though it is optional on the event, so that
 * every skip this module emits is attributable. The field stays optional on the
 * event type only for backward compatibility with consumers built against the
 * single-cause version.
 */
function emitSkipped(
  ctx: VerdictGateContext,
  gate: "governance" | "evaluation",
  reason: "unwired" | "scorer_failed"
): void {
  ctx.emitEvent({
    type: "team_verdict_evaluated",
    teamId: ctx.teamId,
    runId: ctx.runId,
    gate,
    outcome: "skipped",
    reason,
    at: new Date(),
  });
}
