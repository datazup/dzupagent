/**
 * LLM-backed fleet gather strategies — model-driven combination / selection of
 * parallel fleet results.
 *
 * The deterministic gather vocabulary (`all | first | concat | best`) lives in
 * `gather-strategies.ts` and implements the synchronous
 * `OrchestrationMergeStrategy` contract. This module adds the *model-driven*
 * gather strategies the structural module deliberately deferred:
 *
 *   - `synthesis` — hands every successful output to a model and returns the
 *     model's single synthesized answer (combine / summarize / changelog).
 *   - `judge` — hands every successful output to a model and returns the output
 *     the model selects (best-of, verdict-style selection).
 *
 * Because they invoke a model, these strategies are *asynchronous*
 * ({@link AsyncOrchestrationMergeStrategy}). They depend only on a minimal
 * `GatherModel` port — `(prompt) => Promise<string>` — so they add no provider
 * dependency and are trivially mockable in tests. A `DzupAgent` is adapted to
 * that port through {@link agentAsGatherModel} (which reuses the agent's own
 * `generate` abstraction — the same one `AgentOrchestrator.debate` uses).
 */
import { HumanMessage } from "@langchain/core/messages";
import type {
  AgentResult,
  MergedResult,
} from "../orchestration-merge-strategy-types.js";

/**
 * Minimal model port used by LLM gather strategies: takes a rendered prompt,
 * returns the model's text response. Kept intentionally provider-agnostic so
 * strategies stay free of langchain / SDK types and are easy to mock.
 */
export type GatherModel = (prompt: string) => Promise<string>;

/** Async counterpart of `OrchestrationMergeStrategy` for model-driven merges. */
export interface AsyncOrchestrationMergeStrategy<T = unknown> {
  merge(results: AgentResult<T>[]): Promise<MergedResult<T>>;
}

export const LLM_GATHER_STRATEGY_NAMES = ["synthesis", "judge"] as const;

export type LlmGatherStrategyName = (typeof LLM_GATHER_STRATEGY_NAMES)[number];

export function isLlmGatherStrategyName(
  name: string,
): name is LlmGatherStrategyName {
  return (LLM_GATHER_STRATEGY_NAMES as readonly string[]).includes(name);
}

/** Renders a single successful result's output into prompt text. */
export type GatherRenderFn<T = unknown> = (result: AgentResult<T>) => string;

export interface LlmGatherStrategyOptions<T = unknown> {
  /** The model port used to synthesize / judge. Required. */
  model: GatherModel;
  /**
   * Renders each successful output for inclusion in the prompt. Defaults to
   * JSON-stringifying non-string outputs and passing strings through.
   */
  renderOutput?: GatherRenderFn<T>;
}

export interface SynthesisGatherOptions<
  T = unknown,
> extends LlmGatherStrategyOptions<T> {
  /** Extra instruction appended to the synthesis prompt (e.g. output format). */
  instruction?: string;
}

export interface JudgeGatherOptions<
  T = unknown,
> extends LlmGatherStrategyOptions<T> {
  /** Selection criteria the judge should apply. */
  criteria?: string;
}

function defaultRender<T>(result: AgentResult<T>): string {
  const output = result.output;
  if (typeof output === "string") return output;
  if (output === undefined) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
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

/** `success` when every agent succeeded, else `partial`. */
function mixedStatus<T>(
  results: AgentResult<T>[],
  successCount: number,
): "success" | "partial" {
  return successCount === results.length ? "success" : "partial";
}

/**
 * Synthesis: hands every successful output to the model and returns the model's
 * single combined answer. Failures are tolerated — status is `success` when
 * every agent succeeded, `partial` when at least one did. The model is never
 * invoked when nothing succeeded.
 */
export class SynthesisGatherStrategy<
  T = unknown,
> implements AsyncOrchestrationMergeStrategy<T> {
  private readonly model: GatherModel;
  private readonly render: GatherRenderFn<T>;
  private readonly instruction: string | undefined;

  constructor(options: SynthesisGatherOptions<T>) {
    this.model = options.model;
    this.render = options.renderOutput ?? defaultRender;
    this.instruction = options.instruction;
  }

  async merge(results: AgentResult<T>[]): Promise<MergedResult<T>> {
    const counts = countByStatus(results);
    if (counts.successCount === 0) return noSuccessResult(results, counts);

    const successes = results.filter((r) => r.status === "success");
    const prompt = this.buildPrompt(successes);
    const synthesized = await this.model(prompt);

    return {
      status: mixedStatus(results, counts.successCount),
      output: synthesized as T,
      agentResults: results,
      ...counts,
    };
  }

  private buildPrompt(successes: AgentResult<T>[]): string {
    const contributions = successes
      .map(
        (r, i) =>
          `## Contribution ${i + 1} (from ${r.agentId})\n${this.render(r)}`,
      )
      .join("\n\n");
    const lines = [
      "Synthesize the following contributions into a single, coherent result.",
      this.instruction ?? "",
      "",
      contributions,
      "",
      "Return only the synthesized result.",
    ].filter((line) => line.length > 0 || line === "");
    return lines.join("\n");
  }
}

/**
 * Judge: hands every successful output to the model, which selects the best one.
 * The verdict text is parsed for a `Proposal N` reference (1-based); a valid,
 * in-range index selects that output, otherwise the first success is returned.
 * A single success short-circuits without invoking the model, and the model is
 * never invoked when nothing succeeded.
 */
export class JudgeGatherStrategy<
  T = unknown,
> implements AsyncOrchestrationMergeStrategy<T> {
  private readonly model: GatherModel;
  private readonly render: GatherRenderFn<T>;
  private readonly criteria: string | undefined;

  constructor(options: JudgeGatherOptions<T>) {
    this.model = options.model;
    this.render = options.renderOutput ?? defaultRender;
    this.criteria = options.criteria;
  }

  async merge(results: AgentResult<T>[]): Promise<MergedResult<T>> {
    const counts = countByStatus(results);
    if (counts.successCount === 0) return noSuccessResult(results, counts);

    const successes = results.filter((r) => r.status === "success");
    const status = mixedStatus(results, counts.successCount);

    // A single candidate needs no judgement.
    if (successes.length === 1) {
      return {
        status,
        output: successes[0]!.output as T,
        agentResults: results,
        ...counts,
      };
    }

    const verdict = await this.model(this.buildPrompt(successes));
    const picked = this.parseVerdict(verdict, successes.length);
    const chosen = successes[picked] ?? successes[0]!;

    return {
      status,
      output: chosen.output as T,
      agentResults: results,
      ...counts,
    };
  }

  private buildPrompt(successes: AgentResult<T>[]): string {
    const proposals = successes
      .map(
        (r, i) => `## Proposal ${i + 1} (from ${r.agentId})\n${this.render(r)}`,
      )
      .join("\n\n");
    const lines = [
      "Evaluate the following proposals and select the single best one.",
      this.criteria ? `Selection criteria: ${this.criteria}` : "",
      "",
      proposals,
      "",
      `State your choice explicitly as "Proposal N" (1 to ${successes.length}).`,
    ].filter((line, i) => line.length > 0 || i > 0);
    return lines.join("\n");
  }

  /**
   * Extracts a 0-based index from a verdict like "Proposal 2". Returns 0 when
   * no valid, in-range proposal number is found (fallback to first success).
   */
  private parseVerdict(verdict: string, count: number): number {
    const match = verdict.match(/proposal\s+(\d+)/i);
    if (!match) return 0;
    const oneBased = Number.parseInt(match[1]!, 10);
    if (!Number.isInteger(oneBased) || oneBased < 1 || oneBased > count) {
      return 0;
    }
    return oneBased - 1;
  }
}

/**
 * Resolves an LLM-backed gather strategy name to its implementation.
 * Requires a `model` in `options`; unknown names throw with the valid vocabulary.
 */
export function createLlmGatherStrategy<T = unknown>(
  name: LlmGatherStrategyName,
  options: SynthesisGatherOptions<T> & JudgeGatherOptions<T>,
): AsyncOrchestrationMergeStrategy<T> {
  switch (name) {
    case "synthesis":
      return new SynthesisGatherStrategy<T>(options);
    case "judge":
      return new JudgeGatherStrategy<T>(options);
    default: {
      const exhaustive: never = name;
      throw new Error(
        `Unknown LLM gather strategy "${String(
          exhaustive,
        )}" — expected one of: ${LLM_GATHER_STRATEGY_NAMES.join(", ")}`,
      );
    }
  }
}

/**
 * Minimal `DzupAgent`-shaped surface `agentAsGatherModel` needs: just
 * `generate(messages)` returning `{ content }`. `DzupAgent` satisfies this
 * structurally, so callers can pass an agent (or any mock) without importing
 * the concrete class here.
 */
export interface GatherAgentLike {
  generate(messages: HumanMessage[]): Promise<{ content: string }>;
}

/**
 * Adapts a `DzupAgent` (or anything matching {@link GatherAgentLike}) into the
 * `GatherModel` port by wrapping the prompt in a single human message and
 * returning the generated `content`. This reuses the agent's own model
 * invocation path (guardrails, middleware, memory) rather than reaching for a
 * raw provider client.
 */
export function agentAsGatherModel(agent: GatherAgentLike): GatherModel {
  return async (prompt: string) => {
    const result = await agent.generate([new HumanMessage(prompt)]);
    return result.content;
  };
}
