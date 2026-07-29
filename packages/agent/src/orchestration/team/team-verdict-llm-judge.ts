/**
 * An LLM-backed implementation of the TeamRuntime verdict scorer seams
 * (`TeamGovernanceService` / `TeamEvaluationService`).
 *
 * ## Why this exists
 *
 * `createDeterministicVerdictService` in `@dzupagent/testing` scores a run by
 * its participant success ratio. That is a LIVENESS signal — did the
 * participants finish — not a CORRECTNESS one. But `evaluation.scoringCriteria`
 * and `governance.judgeModel` describe judging the quality of the output, which
 * only a model can assess. This closes that gap: the deterministic service
 * proves the gate is wired, this one actually enforces a quality bar.
 *
 * ## Failure policy is the whole design problem
 *
 * A judge is an unreliable dependency: the model call can time out, rate-limit,
 * or return unparseable text. What the gate does then is a policy decision with
 * no safe default, so it is explicit and required (`onJudgeFailure`):
 *
 * - `'skip'`   — treat the run as ungated (does not reject). Availability over
 *                strictness: a transient API blip must not fail good runs.
 * - `'reject'` — treat judge failure as a failed gate. Strictness over
 *                availability, for a pipeline where an unjudged artifact must
 *                never pass.
 *
 * Note that `@dzupagent/evals`' `LLMJudgeScorer` scores a failed call as 0.0.
 * That is right for an eval report (a missing score is a bad score) and WRONG
 * for a gate: it silently converts an infrastructure outage into a unanimous
 * rejection of every run. This service therefore never fabricates a 0 — it
 * routes failure through `onJudgeFailure` instead.
 *
 * `'skip'` deliberately reuses the runtime's existing skipped-verdict path, so
 * a judge that is down shows up in the same `team_verdict_evaluated`
 * (`outcome: 'skipped'`) signal and `dzip_team_verdict_total` metric as a gate
 * that was never wired. Both mean "this run was not actually judged".
 */

import type {
  TeamEvaluationService,
  TeamGovernanceService,
  TeamVerdict,
  TeamVerdictInput,
} from "./team-runtime-verdict.js";

/** A service satisfying both verdict seams, so one instance can wire both gates. */
export type LlmJudgeVerdictService = TeamGovernanceService &
  TeamEvaluationService;

/**
 * Invokes a model with a prompt and returns its raw text.
 *
 * Deliberately a bare callback rather than a `BaseChatModel`: it keeps this
 * module free of any provider dependency and lets a host route the judge
 * through whatever registry, budget, or cache it already has.
 */
export type JudgeInvoker = (prompt: string) => Promise<string>;

/** What the gate should do when the judge itself fails. */
export type JudgeFailurePolicy = "skip" | "reject";

export interface LlmJudgeVerdictOptions {
  /** Model invoker used to obtain the judge's verdict. */
  judge: JudgeInvoker;
  /**
   * What to do when the judge call throws or returns something unparseable.
   * Required — see the module docs; there is no safe default.
   */
  onJudgeFailure: JudgeFailurePolicy;
  /**
   * Fallback criteria used when the policy declares none. Ignored whenever
   * `evaluation.scoringCriteria` is present on the run's policies.
   */
  defaultCriteria?: string[];
}

/**
 * Raised when the judge could not produce a verdict and `onJudgeFailure` is
 * `'reject'`.
 *
 * A distinct error type (rather than a fabricated 0.0 score) so a host can tell
 * "the judge says this run is bad" apart from "the judge is broken" — the two
 * demand completely different responses.
 */
export class TeamJudgeUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super(
      `TeamRuntime: verdict judge failed to produce a score ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`
    );
    this.name = "TeamJudgeUnavailableError";
  }
}

/**
 * Create a verdict service that asks a model to score the run.
 *
 * ```ts
 * const verdict = createLlmJudgeVerdictService({
 *   judge: (prompt) => model.invoke(prompt).then((m) => String(m.content)),
 *   onJudgeFailure: "skip",
 * });
 * new TeamRuntime({ definition, policies, evaluation: verdict });
 * ```
 */
export function createLlmJudgeVerdictService(
  options: LlmJudgeVerdictOptions
): LlmJudgeVerdictService {
  const { judge, onJudgeFailure, defaultCriteria } = options;

  if (onJudgeFailure !== "skip" && onJudgeFailure !== "reject") {
    throw new Error(
      "createLlmJudgeVerdictService: 'onJudgeFailure' must be 'skip' or 'reject'"
    );
  }

  const verdictFor = async (input: TeamVerdictInput): Promise<TeamVerdict> => {
    let raw: string;
    try {
      raw = await judge(buildJudgePrompt(input, defaultCriteria));
    } catch (err: unknown) {
      return onFailure(err, onJudgeFailure);
    }

    const parsed = parseVerdict(raw);
    if (!parsed) {
      return onFailure(
        new Error(`judge returned an unparseable verdict: ${truncate(raw)}`),
        onJudgeFailure
      );
    }
    return parsed;
  };

  return {
    evaluate: verdictFor,
    score: verdictFor,
  };
}

/**
 * Apply the configured failure policy.
 *
 * `'skip'` returns a score of 1 with `unanimous: true` — deliberately a
 * PASS-THROUGH, not a judgement. It is the only encoding of "do not gate this
 * run" available through the `TeamVerdict` contract, and it matches what the
 * runtime already does for an unwired scorer. Returning 0 instead would reject
 * every run during an outage.
 */
function onFailure(cause: unknown, policy: JudgeFailurePolicy): TeamVerdict {
  if (policy === "reject") throw new TeamJudgeUnavailableError(cause);
  return { score: 1, unanimous: true };
}

/** Build the judge prompt from the run's task, output, and declared criteria. */
function buildJudgePrompt(
  input: TeamVerdictInput,
  defaultCriteria: string[] | undefined
): string {
  const criteria =
    input.policies.evaluation?.scoringCriteria ?? defaultCriteria ?? [];
  const criteriaBlock = criteria.length
    ? criteria.map((c) => `- ${c}`).join("\n")
    : "- Overall quality and correctness of the output for the given task.";

  return [
    "You are judging the output of a multi-agent team run.",
    "Score it from 0.0 (unacceptable) to 1.0 (fully meets the criteria).",
    "",
    "Criteria:",
    criteriaBlock,
    "",
    `Task: ${input.task}`,
    "",
    `Output: ${input.result.content || "(no output produced)"}`,
    "",
    'Respond with JSON only: { "score": number, "unanimous": boolean }',
    '"unanimous" means every criterion is met, not merely the average.',
  ].join("\n");
}

/**
 * Parse a judge response into a verdict, or `null` when it cannot be trusted.
 *
 * Returns `null` rather than a default score: an unreadable judgement is a
 * judge failure and must go through the failure policy, not quietly become a
 * number the gate then enforces.
 */
function parseVerdict(raw: string): TeamVerdict | null {
  const json = extractJsonObject(raw);
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const score = obj["score"];
  if (typeof score !== "number" || Number.isNaN(score)) return null;

  return {
    // Clamp rather than reject: a model returning 1.2 has still expressed
    // "excellent", and the threshold comparison needs a bounded number.
    score: Math.max(0, Math.min(1, score)),
    unanimous: obj["unanimous"] === true,
  };
}

/**
 * Extract the first balanced JSON object from a response.
 *
 * Judges routinely wrap JSON in prose or a fenced code block, so a bare
 * `JSON.parse` of the whole response fails on otherwise-valid verdicts.
 */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

function truncate(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
}
