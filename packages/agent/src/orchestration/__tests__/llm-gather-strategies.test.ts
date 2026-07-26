import { describe, it, expect, vi } from "vitest";
import {
  LLM_GATHER_STRATEGY_NAMES,
  isLlmGatherStrategyName,
  createLlmGatherStrategy,
  SynthesisGatherStrategy,
  JudgeGatherStrategy,
  agentAsGatherModel,
  type GatherModel,
} from "../gather/llm-gather-strategies.js";
import type { AgentResult } from "../orchestration-merge-strategy-types.js";

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function success<T>(agentId: string, output: T): AgentResult<T> {
  return { agentId, status: "success", output };
}
function timeout<T>(agentId: string): AgentResult<T> {
  return { agentId, status: "timeout", error: "timed out" };
}
function error<T>(agentId: string): AgentResult<T> {
  return { agentId, status: "error", error: "agent crashed" };
}

/** A deterministic mock model: records prompts, returns a scripted response. */
function mockModel(response: string): GatherModel & { prompts: string[] } {
  const prompts: string[] = [];
  const model = vi.fn(async (prompt: string) => {
    prompts.push(prompt);
    return response;
  }) as unknown as GatherModel & { prompts: string[] };
  (model as unknown as { prompts: string[] }).prompts = prompts;
  return Object.assign(model, { prompts });
}

// ---------------------------------------------------------------------------
// Strategy names
// ---------------------------------------------------------------------------

describe("llm gather strategy names", () => {
  it("exposes the LLM-backed gather vocabulary", () => {
    expect(LLM_GATHER_STRATEGY_NAMES).toEqual(["synthesis", "judge"]);
  });

  it("isLlmGatherStrategyName narrows known names only", () => {
    for (const name of LLM_GATHER_STRATEGY_NAMES) {
      expect(isLlmGatherStrategyName(name)).toBe(true);
    }
    expect(isLlmGatherStrategyName("all")).toBe(false);
    expect(isLlmGatherStrategyName("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createLlmGatherStrategy resolver
// ---------------------------------------------------------------------------

describe("createLlmGatherStrategy", () => {
  it("resolves synthesis and judge to their strategies", () => {
    const model = mockModel("x");
    expect(createLlmGatherStrategy("synthesis", { model })).toBeInstanceOf(
      SynthesisGatherStrategy,
    );
    expect(createLlmGatherStrategy("judge", { model })).toBeInstanceOf(
      JudgeGatherStrategy,
    );
  });

  it("throws a descriptive error on unknown names", () => {
    const model = mockModel("x");
    expect(() =>
      createLlmGatherStrategy("vote" as never, { model }),
    ).toThrowError(/Unknown LLM gather strategy "vote".*synthesis, judge/);
  });
});

// ---------------------------------------------------------------------------
// SynthesisGatherStrategy
// ---------------------------------------------------------------------------

describe("SynthesisGatherStrategy", () => {
  it("synthesizes successful outputs through the model and returns success", async () => {
    const model = mockModel("SYNTHESIZED");
    const strategy = new SynthesisGatherStrategy<string>({ model });

    const merged = await strategy.merge([
      success("a", "alpha"),
      success("b", "beta"),
    ]);

    expect(merged.status).toBe("success");
    expect(merged.output).toBe("SYNTHESIZED");
    expect(merged.successCount).toBe(2);
    expect(model.prompts).toHaveLength(1);
    // The prompt carries every successful contribution.
    expect(model.prompts[0]).toContain("alpha");
    expect(model.prompts[0]).toContain("beta");
  });

  it("reports partial when some agents failed but still synthesizes", async () => {
    const model = mockModel("PARTIAL-SYNTH");
    const strategy = new SynthesisGatherStrategy<string>({ model });

    const merged = await strategy.merge([success("a", "alpha"), error("b")]);

    expect(merged.status).toBe("partial");
    expect(merged.output).toBe("PARTIAL-SYNTH");
    expect(merged.errorCount).toBe(1);
    // Only successful outputs are handed to the model.
    expect(model.prompts[0]).toContain("alpha");
    expect(model.prompts[0]).not.toContain("agent crashed");
  });

  it("does not invoke the model when nothing succeeded", async () => {
    const model = mockModel("unused");
    const strategy = new SynthesisGatherStrategy<string>({ model });

    const merged = await strategy.merge([error("a"), timeout("b")]);

    expect(merged.status).toBe("all_failed");
    expect(merged.output).toBeUndefined();
    expect(model.prompts).toHaveLength(0);
  });

  it("maps all_timeout when every agent timed out", async () => {
    const model = mockModel("unused");
    const strategy = new SynthesisGatherStrategy<string>({ model });
    const merged = await strategy.merge([timeout("a"), timeout("b")]);
    expect(merged.status).toBe("all_timeout");
    expect(model.prompts).toHaveLength(0);
  });

  it("applies a custom render for structured outputs", async () => {
    const model = mockModel("SYNTH");
    const strategy = new SynthesisGatherStrategy<{ answer: string }>({
      model,
      renderOutput: (r) => (r.output ? r.output.answer : ""),
    });
    await strategy.merge([
      success("a", { answer: "first-answer" }),
      success("b", { answer: "second-answer" }),
    ]);
    expect(model.prompts[0]).toContain("first-answer");
    expect(model.prompts[0]).toContain("second-answer");
  });

  it("threads a custom instruction into the synthesis prompt", async () => {
    const model = mockModel("SYNTH");
    const strategy = new SynthesisGatherStrategy<string>({
      model,
      instruction: "Merge into a changelog.",
    });
    await strategy.merge([success("a", "x")]);
    expect(model.prompts[0]).toContain("Merge into a changelog.");
  });
});

// ---------------------------------------------------------------------------
// JudgeGatherStrategy
// ---------------------------------------------------------------------------

describe("JudgeGatherStrategy", () => {
  it("selects the output whose index the judge returns", async () => {
    // Judge picks proposal #2 (1-based) → index 1 → "beta".
    const model = mockModel("I choose Proposal 2 because it is best.");
    const strategy = new JudgeGatherStrategy<string>({ model });

    const merged = await strategy.merge([
      success("a", "alpha"),
      success("b", "beta"),
      success("c", "gamma"),
    ]);

    expect(merged.status).toBe("success");
    expect(merged.output).toBe("beta");
    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain("alpha");
    expect(model.prompts[0]).toContain("gamma");
  });

  it("falls back to the first success when the verdict names no valid index", async () => {
    const model = mockModel("They are all equally good.");
    const strategy = new JudgeGatherStrategy<string>({ model });

    const merged = await strategy.merge([
      timeout("a"),
      success("b", "only-real"),
      success("c", "later"),
    ]);

    // One agent timed out, so the overall status is partial; the judge still
    // picks among the successes and, with no valid verdict, falls back to the
    // first success.
    expect(merged.status).toBe("partial");
    expect(merged.output).toBe("only-real");
  });

  it("clamps an out-of-range verdict index to the available proposals", async () => {
    const model = mockModel("Proposal 9 wins");
    const strategy = new JudgeGatherStrategy<string>({ model });

    const merged = await strategy.merge([
      success("a", "alpha"),
      success("b", "beta"),
    ]);

    // No proposal 9 → treated as no valid pick → first success.
    expect(merged.output).toBe("alpha");
  });

  it("short-circuits to the sole success without invoking the model", async () => {
    const model = mockModel("unused");
    const strategy = new JudgeGatherStrategy<string>({ model });

    const merged = await strategy.merge([error("a"), success("b", "solo")]);

    // Only one success → no judgement needed (model not invoked); one failure
    // means the overall status is partial.
    expect(merged.status).toBe("partial");
    expect(merged.output).toBe("solo");
    expect(model.prompts).toHaveLength(0);
  });

  it("does not invoke the model when nothing succeeded", async () => {
    const model = mockModel("unused");
    const strategy = new JudgeGatherStrategy<string>({ model });

    const merged = await strategy.merge([error("a"), error("b")]);

    expect(merged.status).toBe("all_failed");
    expect(model.prompts).toHaveLength(0);
  });

  it("uses a custom criteria string in the judge prompt", async () => {
    const model = mockModel("Proposal 1");
    const strategy = new JudgeGatherStrategy<string>({
      model,
      criteria: "Prefer the most concise answer.",
    });
    await strategy.merge([success("a", "x"), success("b", "y")]);
    expect(model.prompts[0]).toContain("Prefer the most concise answer.");
  });
});

// ---------------------------------------------------------------------------
// agentAsGatherModel adapter
// ---------------------------------------------------------------------------

describe("agentAsGatherModel", () => {
  it("adapts a DzupAgent-shaped generate() into a GatherModel", async () => {
    const generate = vi.fn(async (_messages: unknown[]) => ({
      content: "agent-said",
    }));
    const model = agentAsGatherModel({ generate });

    const out = await model("hello prompt");

    expect(out).toBe("agent-said");
    expect(generate).toHaveBeenCalledOnce();
    // The prompt is wrapped in a single human message.
    const messages = generate.mock.calls[0]![0] as Array<{ content: unknown }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("hello prompt");
  });
});
