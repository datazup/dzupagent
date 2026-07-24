import { describe, it, expect } from "vitest";
import {
  GATHER_STRATEGY_NAMES,
  isGatherStrategyName,
  createGatherStrategy,
  ConcatGatherStrategy,
  BestGatherStrategy,
} from "../gather/gather-strategies.js";
import { AllRequiredMergeStrategy } from "../merge/all-required.js";
import { FirstWinsMergeStrategy } from "../merge/first-wins.js";
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

// ---------------------------------------------------------------------------
// Strategy names
// ---------------------------------------------------------------------------

describe("gather strategy names", () => {
  it("exposes the fleet.gather DSL vocabulary", () => {
    expect(GATHER_STRATEGY_NAMES).toEqual(["all", "first", "concat", "best"]);
  });

  it("isGatherStrategyName narrows known names only", () => {
    for (const name of GATHER_STRATEGY_NAMES) {
      expect(isGatherStrategyName(name)).toBe(true);
    }
    expect(isGatherStrategyName("audit-synthesis")).toBe(false);
    expect(isGatherStrategyName("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createGatherStrategy resolver
// ---------------------------------------------------------------------------

describe("createGatherStrategy", () => {
  it("resolves all -> AllRequiredMergeStrategy semantics", () => {
    expect(createGatherStrategy("all")).toBeInstanceOf(
      AllRequiredMergeStrategy,
    );
  });

  it("resolves first -> FirstWinsMergeStrategy semantics", () => {
    expect(createGatherStrategy("first")).toBeInstanceOf(
      FirstWinsMergeStrategy,
    );
  });

  it("resolves concat and best to the gather strategies", () => {
    expect(createGatherStrategy("concat")).toBeInstanceOf(ConcatGatherStrategy);
    expect(createGatherStrategy("best")).toBeInstanceOf(BestGatherStrategy);
  });

  it("throws a descriptive error on unknown names", () => {
    expect(() => createGatherStrategy("vote" as never)).toThrowError(
      /Unknown gather strategy "vote".*all, first, concat, best/,
    );
  });
});

// ---------------------------------------------------------------------------
// ConcatGatherStrategy
// ---------------------------------------------------------------------------

describe("ConcatGatherStrategy", () => {
  const strategy = new ConcatGatherStrategy<unknown>();

  it("flattens array outputs in dispatch order", () => {
    const merged = strategy.merge([
      success("a", ["f1", "f2"]),
      success("b", ["f3"]),
    ]);
    expect(merged.status).toBe("success");
    expect(merged.output).toEqual(["f1", "f2", "f3"]);
    expect(merged.successCount).toBe(2);
  });

  it("appends non-array outputs without flattening", () => {
    const merged = strategy.merge([success("a", "x"), success("b", ["y"])]);
    expect(merged.output).toEqual(["x", "y"]);
  });

  it("tolerates failures and reports partial", () => {
    const merged = strategy.merge([
      success("a", ["f1"]),
      error("b"),
      success("c", ["f2"]),
    ]);
    expect(merged.status).toBe("partial");
    expect(merged.output).toEqual(["f1", "f2"]);
    expect(merged.errorCount).toBe(1);
    expect(merged.agentResults).toHaveLength(3);
  });

  it("reports all_failed / all_timeout when nothing succeeded", () => {
    expect(strategy.merge([error("a"), timeout("b")]).status).toBe(
      "all_failed",
    );
    expect(strategy.merge([timeout("a"), timeout("b")]).status).toBe(
      "all_timeout",
    );
  });
});

// ---------------------------------------------------------------------------
// BestGatherStrategy
// ---------------------------------------------------------------------------

interface Scored {
  score?: unknown;
  answer: string;
}

describe("BestGatherStrategy", () => {
  it("picks the highest default `score` field", () => {
    const strategy = new BestGatherStrategy<Scored>();
    const merged = strategy.merge([
      success("a", { score: 0.4, answer: "weak" }),
      success("b", { score: 0.9, answer: "strong" }),
      success("c", { score: 0.7, answer: "ok" }),
    ]);
    expect(merged.status).toBe("success");
    expect(merged.output).toEqual({ score: 0.9, answer: "strong" });
  });

  it("breaks ties toward earlier dispatch order (deterministic)", () => {
    const strategy = new BestGatherStrategy<Scored>();
    const merged = strategy.merge([
      success("a", { score: 0.5, answer: "first" }),
      success("b", { score: 0.5, answer: "second" }),
    ]);
    expect(merged.output).toEqual({ score: 0.5, answer: "first" });
  });

  it("ranks non-scorable outputs lowest but still gathers them", () => {
    const strategy = new BestGatherStrategy<Scored>();
    const merged = strategy.merge([
      success("a", { answer: "unscored" }),
      success("b", { score: 0.1, answer: "scored" }),
    ]);
    expect(merged.output).toEqual({ score: 0.1, answer: "scored" });
  });

  it("falls back to first success when no output is scorable", () => {
    const strategy = new BestGatherStrategy<Scored>();
    const merged = strategy.merge([
      timeout("a"),
      success("b", { answer: "only" }),
      success("c", { answer: "later" }),
    ]);
    expect(merged.status).toBe("success");
    expect(merged.output).toEqual({ answer: "only" });
    expect(merged.timeoutCount).toBe(1);
  });

  it("supports a custom scoreBy ranking", () => {
    const strategy = new BestGatherStrategy<string>({
      scoreBy: (result) => (result.output ?? "").length,
    });
    const merged = strategy.merge([
      success("a", "short"),
      success("b", "the longest output"),
      success("c", "medium!"),
    ]);
    expect(merged.output).toBe("the longest output");
  });

  it("ignores non-finite custom scores in favour of finite ones", () => {
    const strategy = new BestGatherStrategy<number>({
      scoreBy: (result) =>
        result.output === 2 ? Number.NaN : (result.output ?? 0),
    });
    const merged = strategy.merge([success("a", 2), success("b", 1)]);
    expect(merged.output).toBe(1);
  });

  it("reports all_failed / all_timeout when nothing succeeded", () => {
    const strategy = new BestGatherStrategy<Scored>();
    expect(strategy.merge([error("a"), timeout("b")]).status).toBe(
      "all_failed",
    );
    expect(strategy.merge([timeout("a")]).status).toBe("all_timeout");
  });
});
