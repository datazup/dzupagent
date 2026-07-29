/**
 * A deterministic, model-free implementation of the TeamRuntime verdict
 * scorer seams (`TeamGovernanceService` / `TeamEvaluationService`).
 *
 * ## Why this exists
 *
 * `governance.minScore`, `governance.requireUnanimous` and
 * `evaluation.minPassScore` are real acceptance gates, but TeamRuntime cannot
 * score a run itself — that judgement is criteria-specific, so the runtime
 * delegates it to a host-injected service. Until a host injects one, every
 * declared threshold accepts every run (the runtime now reports this as a
 * `team_verdict_evaluated` event with `outcome: 'skipped'`).
 *
 * That left the gates unenforceable in-repo and untestable without an API key.
 * This service closes that gap by scoring from facts the runtime already
 * observed — participant success — instead of from a model's opinion.
 *
 * ## Scoring
 *
 * `score` is the fraction of participants that succeeded, and `unanimous` is
 * true only when every participant succeeded. A run with no participant
 * results scores 0: an empty run has demonstrated nothing, and scoring it 1.0
 * would let a team that never ran clear a `minScore: 1.0` bar — exactly the
 * silent-pass failure this whole seam is meant to eliminate.
 *
 * ## Scope
 *
 * This is a reference and test double, not a production judge. It measures
 * whether participants *completed*, which is a liveness signal, not whether
 * their output was *correct*, which is what `scoringCriteria` describes and
 * only a real judge can assess. Ship an LLM-backed service for that; use this
 * to test gate wiring, to demonstrate the seam, and as a template to copy.
 */

import type {
  TeamEvaluationService,
  TeamGovernanceService,
  TeamVerdict,
  TeamVerdictInput,
} from "@dzupagent/agent/orchestration";

/** A service satisfying both verdict seams, so one instance can wire both gates. */
export type DeterministicVerdictService = TeamGovernanceService &
  TeamEvaluationService;

export interface DeterministicVerdictOptions {
  /**
   * Fixed score to return, bypassing participant-success scoring.
   *
   * For tests that need to drive a gate to a specific side of its threshold
   * without having to construct a run whose success ratio happens to land
   * there. Must be in [0, 1].
   */
  score?: number;
  /**
   * Fixed unanimity verdict, bypassing the all-succeeded computation.
   *
   * Only consulted by the governance gate when `requireUnanimous` is set.
   */
  unanimous?: boolean;
}

/**
 * Create a verdict service that scores a run by its participant success ratio.
 *
 * Wire the same instance into both seams to gate on both groups:
 *
 * ```ts
 * const verdict = createDeterministicVerdictService();
 * new TeamRuntime({ definition, governance: verdict, evaluation: verdict });
 * ```
 *
 * Pass `score` / `unanimous` to pin the verdict for a specific test case.
 */
export function createDeterministicVerdictService(
  options: DeterministicVerdictOptions = {}
): DeterministicVerdictService {
  const { score: fixedScore, unanimous: fixedUnanimous } = options;

  if (fixedScore !== undefined) {
    if (
      typeof fixedScore !== "number" ||
      Number.isNaN(fixedScore) ||
      fixedScore < 0 ||
      fixedScore > 1
    ) {
      throw new Error(
        "createDeterministicVerdictService: 'score' must be a number in [0, 1]"
      );
    }
  }

  const verdictFor = (input: TeamVerdictInput): TeamVerdict => {
    const results = input.result.agentResults ?? [];
    const succeeded = results.filter((r) => r.success).length;

    // An empty run scores 0 — see the module docs: 0/0 must not read as
    // "perfect", or a team that ran nothing clears every bar.
    const computedScore = results.length === 0 ? 0 : succeeded / results.length;
    const computedUnanimous =
      results.length > 0 && succeeded === results.length;

    return {
      score: fixedScore ?? computedScore,
      unanimous: fixedUnanimous ?? computedUnanimous,
    };
  };

  return {
    evaluate: (input) => Promise.resolve(verdictFor(input)),
    score: (input) => Promise.resolve(verdictFor(input)),
  };
}
