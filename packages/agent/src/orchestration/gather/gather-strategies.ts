/**
 * Fleet gather strategies — deterministic combination of parallel fleet results.
 *
 * This is the DSL-facing vocabulary behind the `fleet.gather` node
 * (`strategy: all | first | concat | best`). Strategies implement the existing
 * OrchestrationMergeStrategy contract so the fleet runtime and supervisor share
 * one result shape; `all` and `first` reuse the equivalent merge strategies.
 *
 * LLM-backed gather (synthesis / judge) is model-driven and therefore
 * asynchronous — it lives in the sibling `llm-gather-strategies.ts` module,
 * which implements the async `AsyncOrchestrationMergeStrategy` contract over a
 * provider-agnostic `GatherModel` port. The two vocabularies are kept separate
 * so the deterministic strategies here stay synchronous and dependency-free.
 */
import type {
  AgentResult,
  MergedResult,
  OrchestrationMergeStrategy,
} from "../orchestration-merge-strategy-types.js";
import { AllRequiredMergeStrategy } from "../merge/all-required.js";
import { FirstWinsMergeStrategy } from "../merge/first-wins.js";
import { omitUndefined } from "../../utils/exact-optional.js";

export const GATHER_STRATEGY_NAMES = [
  "all",
  "first",
  "concat",
  "best",
] as const;

export type GatherStrategyName = (typeof GATHER_STRATEGY_NAMES)[number];

export function isGatherStrategyName(name: string): name is GatherStrategyName {
  return (GATHER_STRATEGY_NAMES as readonly string[]).includes(name);
}

/** Scores a successful result for the `best` strategy. */
export type GatherScoreFn<T = unknown> = (result: AgentResult<T>) => number;

export interface GatherStrategyOptions<T = unknown> {
  /**
   * `best` only: ranks successful results; the highest finite score wins and
   * ties break toward earlier dispatch order. Defaults to reading a finite
   * numeric `score` field off the output object; non-scorable outputs rank
   * lowest (so a run with no scorable output still gathers its first success).
   */
  scoreBy?: GatherScoreFn<T>;
}

function countByStatus<T>(results: AgentResult<T>[]): {
  successCount: number;
  timeoutCount: number;
  errorCount: number;
} {
  return {
    successCount: results.filter((r) => r.status === "success").length,
    timeoutCount: results.filter((r) => r.status === "timeout").length,
    errorCount: results.filter((r) => r.status === "error").length,
  };
}

function noSuccessResult<T>(
  results: AgentResult<T>[],
  counts: { successCount: number; timeoutCount: number; errorCount: number },
): MergedResult<T> {
  return {
    status:
      counts.timeoutCount === results.length ? "all_timeout" : "all_failed",
    agentResults: results,
    ...counts,
  };
}

/**
 * Concat: flattens successful outputs in dispatch order — array outputs are
 * spread, scalar outputs appended. Tolerates failures: `success` when every
 * agent succeeded, `partial` when at least one did.
 */
export class ConcatGatherStrategy<
  T = unknown,
> implements OrchestrationMergeStrategy<T> {
  merge(results: AgentResult<T>[]): MergedResult<T> {
    const counts = countByStatus(results);
    if (counts.successCount === 0) return noSuccessResult(results, counts);

    const flattened: unknown[] = [];
    for (const result of results) {
      if (result.status !== "success") continue;
      if (Array.isArray(result.output)) flattened.push(...result.output);
      else flattened.push(result.output);
    }

    // See AllRequiredMergeStrategy for the rationale: callers parameterise
    // `T` to the array type they expect, so a single direct cast preserves
    // type safety.
    return {
      status: counts.successCount === results.length ? "success" : "partial",
      output: flattened as T,
      agentResults: results,
      ...counts,
    };
  }
}

const defaultScore: GatherScoreFn = (result) => {
  const output = result.output as { score?: unknown } | null | undefined;
  const score =
    typeof output === "object" && output !== null ? output.score : undefined;
  return typeof score === "number" && Number.isFinite(score)
    ? score
    : Number.NEGATIVE_INFINITY;
};

/**
 * Best: picks the single highest-scoring successful output. Non-finite scores
 * rank lowest; ties break toward earlier dispatch order, so the pick is
 * deterministic for a given result order.
 */
export class BestGatherStrategy<
  T = unknown,
> implements OrchestrationMergeStrategy<T> {
  private readonly scoreBy: GatherScoreFn<T>;

  constructor(options: GatherStrategyOptions<T> = {}) {
    this.scoreBy = options.scoreBy ?? (defaultScore as GatherScoreFn<T>);
  }

  merge(results: AgentResult<T>[]): MergedResult<T> {
    const counts = countByStatus(results);
    if (counts.successCount === 0) return noSuccessResult(results, counts);

    let best: AgentResult<T> | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const result of results) {
      if (result.status !== "success") continue;
      const raw = this.scoreBy(result);
      const score = Number.isFinite(raw) ? raw : Number.NEGATIVE_INFINITY;
      if (best === undefined || score > bestScore) {
        best = result;
        bestScore = score;
      }
    }

    // counts.successCount > 0 guarantees `best` is set.
    return omitUndefined({
      status: "success",
      output: (best as AgentResult<T>).output,
      agentResults: results,
      ...counts,
    });
  }
}

/**
 * Resolves a `fleet.gather` strategy name to its implementation.
 * `all` and `first` are the existing merge strategies under their DSL names.
 */
export function createGatherStrategy<T = unknown>(
  name: GatherStrategyName,
  options: GatherStrategyOptions<T> = {},
): OrchestrationMergeStrategy<T> {
  switch (name) {
    case "all":
      return new AllRequiredMergeStrategy<T>();
    case "first":
      return new FirstWinsMergeStrategy<T>();
    case "concat":
      return new ConcatGatherStrategy<T>();
    case "best":
      return new BestGatherStrategy<T>(options);
    default: {
      const exhaustive: never = name;
      throw new Error(
        `Unknown gather strategy "${String(
          exhaustive,
        )}" — expected one of: ${GATHER_STRATEGY_NAMES.join(", ")}`,
      );
    }
  }
}
