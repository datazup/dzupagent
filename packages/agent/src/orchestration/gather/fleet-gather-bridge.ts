/**
 * Fleet → gather bridge — adapts FleetSupervisor results onto the
 * OrchestrationMergeStrategy contract and applies compiled `fleet.gather`
 * steps through the gather strategy vocabulary.
 *
 * Pure functions, no I/O: the compiled `fleet.gather` payload is just data,
 * so this module deliberately declares the step shape structurally instead of
 * importing from @dzupagent/flow-compiler (layer boundaries forbid that
 * dependency direction).
 */
import type { RepoAgentResult, TaskState } from "@dzupagent/agent-types/fleet";
import type {
  AgentResult,
  MergedResult,
} from "../orchestration-merge-strategy-types.js";
import {
  GATHER_STRATEGY_NAMES,
  createGatherStrategy,
  isGatherStrategyName,
  type GatherStrategyOptions,
} from "./gather-strategies.js";
import {
  LLM_GATHER_STRATEGY_NAMES,
  createLlmGatherStrategy,
  isLlmGatherStrategyName,
  type JudgeGatherOptions,
  type SynthesisGatherOptions,
} from "./llm-gather-strategies.js";

export interface FleetGatherAdapterOptions<T = unknown> {
  /**
   * Synthesizes an output for a result whose `outcome` is undefined.
   * RepoAgent.dispatch currently never populates `outcome` — only `events` —
   * so this hook is the caller's seam for deriving an output from the worker
   * event stream. Only consulted when `outcome` is undefined; returning
   * undefined leaves the output unset.
   */
  deriveOutput?: (result: RepoAgentResult) => T | undefined;
  /**
   * Overrides the default `worker '<workerId>' <state>` error message for
   * non-successful results.
   */
  deriveError?: (result: RepoAgentResult) => string;
}

/**
 * Maps a fleet TaskState onto the merge contract's AgentResult status.
 *
 * Only `completed` is a success. `surrendered` maps to `error`, NOT
 * `timeout`: surrender is a non-success give-back of the task (the worker
 * chose to hand it back), not a time-budget expiry — mapping it to `timeout`
 * would mislead downstream retry/timeout semantics that treat timeouts as
 * transient budget exhaustion. All other non-terminal states (`queued`,
 * `claimed`, `in-progress`, `blocked`) reaching a gather step mean the task
 * never finished, which is likewise an error from the gather's perspective.
 */
function toStatus(state: TaskState): AgentResult["status"] {
  return state === "completed" ? "success" : "error";
}

/**
 * Adapts fleet `RepoAgentResult[]` (e.g. `FleetRunResult.taskOutcomes`) to
 * the `AgentResult<T>[]` shape consumed by OrchestrationMergeStrategy /
 * gather strategies. Preserves input order; pure, no I/O.
 *
 * Output resolution: `result.outcome` when defined, else
 * `options.deriveOutput(result)` when provided (see
 * {@link FleetGatherAdapterOptions.deriveOutput} for why the hook exists),
 * else undefined.
 */
export function toAgentResults<T = unknown>(
  taskOutcomes: RepoAgentResult[],
  options: FleetGatherAdapterOptions<T> = {},
): AgentResult<T>[] {
  return taskOutcomes.map((result) => {
    const status = toStatus(result.state);
    const output =
      result.outcome !== undefined
        ? (result.outcome as T)
        : options.deriveOutput?.(result);
    const agentResult: AgentResult<T> = {
      agentId: result.workerId,
      status,
    };
    if (output !== undefined) agentResult.output = output;
    if (status !== "success") {
      agentResult.error =
        options.deriveError?.(result) ??
        `worker '${result.workerId}' ${result.state}`;
    }
    return agentResult;
  });
}

/**
 * Applies a compiled `fleet.gather` step to adapted agent results.
 * The step's strategy defaults to `all`; unknown strategy names throw with
 * the valid vocabulary listed.
 */
export function applyGatherStep<T = unknown>(
  step: { strategy?: string },
  results: AgentResult<T>[],
  options: GatherStrategyOptions<T> = {},
): MergedResult<T> {
  const name = step.strategy ?? "all";
  if (!isGatherStrategyName(name)) {
    throw new Error(
      `Unknown gather strategy "${name}" — expected one of: ${GATHER_STRATEGY_NAMES.join(
        ", ",
      )}`,
    );
  }
  return createGatherStrategy<T>(name, options).merge(results);
}

/**
 * Applies a compiled `fleet.gather` step that names an LLM-backed strategy
 * (`synthesis` | `judge`) to adapted agent results. Async because these
 * strategies invoke a model. Unknown/omitted strategy names throw with the
 * valid LLM vocabulary listed — deterministic strategies go through
 * {@link applyGatherStep} instead.
 */
export async function applyLlmGatherStep<T = unknown>(
  step: { strategy?: string },
  results: AgentResult<T>[],
  options: SynthesisGatherOptions<T> & JudgeGatherOptions<T>,
): Promise<MergedResult<T>> {
  const name = step.strategy;
  if (name === undefined || !isLlmGatherStrategyName(name)) {
    throw new Error(
      `Unknown LLM gather strategy "${String(
        name,
      )}" — expected one of: ${LLM_GATHER_STRATEGY_NAMES.join(", ")}`,
    );
  }
  return createLlmGatherStrategy<T>(name, options).merge(results);
}
