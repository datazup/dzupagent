/**
 * Gap-filling tests for contract-net bid strategies and ContractNetManager
 * execution paths not covered by contract-net.test.ts or
 * contract-net-manager-branches.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { DzupAgent } from "../agent/dzip-agent.js";
import { ContractNetManager } from "../orchestration/contract-net/contract-net-manager.js";
import { OrchestrationError } from "../orchestration/orchestration-error.js";
import {
  lowestCostStrategy,
  fastestStrategy,
  highestQualityStrategy,
  createWeightedStrategy,
} from "../orchestration/contract-net/bid-strategies.js";
import type { ContractBid } from "../orchestration/contract-net/contract-net-types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeBid(
  agentId: string,
  overrides: Partial<ContractBid> = {}
): ContractBid {
  return {
    agentId,
    cfpId: "cfp-test",
    estimatedCostCents: 100,
    estimatedDurationMs: 5000,
    qualityEstimate: 0.8,
    confidence: 0.9,
    approach: "standard",
    ...overrides,
  };
}

function bidJson(overrides: Partial<ContractBid> = {}): string {
  return JSON.stringify({
    estimatedCostCents: overrides.estimatedCostCents ?? 100,
    estimatedDurationMs: overrides.estimatedDurationMs ?? 5000,
    qualityEstimate: overrides.qualityEstimate ?? 0.8,
    confidence: overrides.confidence ?? 0.9,
    approach: overrides.approach ?? "standard",
    ...(overrides.capabilities ? { capabilities: overrides.capabilities } : {}),
  });
}

/** A raw bid payload, for asserting how malformed `capabilities` degrade. */
function rawBidJson(capabilities: unknown): string {
  return JSON.stringify({
    estimatedCostCents: 100,
    estimatedDurationMs: 5000,
    qualityEstimate: 0.8,
    confidence: 0.9,
    approach: "standard",
    capabilities,
  });
}

function makeModel(responses: string[]): BaseChatModel {
  let i = 0;
  return {
    invoke: vi.fn(async (_msgs: BaseMessage[]) => {
      const content = responses[i] ?? responses[responses.length - 1]!;
      i++;
      return new AIMessage({ content, response_metadata: {} });
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this;
    }),
    _modelType: () => "base_chat_model",
    _llmType: () => "mock",
  } as unknown as BaseChatModel;
}

function makeAgent(id: string, model: BaseChatModel): DzupAgent {
  return new DzupAgent({
    id,
    description: id,
    instructions: `You are ${id}.`,
    model,
  });
}

// ---------------------------------------------------------------------------
// Bid strategy edge cases
// ---------------------------------------------------------------------------

describe("Bid strategy edge cases", () => {
  it("lowestCostStrategy: single bid returns it unchanged", () => {
    const bid = makeBid("solo");
    expect(lowestCostStrategy.evaluate([bid])).toEqual([bid]);
  });

  it("fastestStrategy: single bid returns it unchanged", () => {
    const bid = makeBid("solo", { estimatedDurationMs: 9999 });
    expect(fastestStrategy.evaluate([bid])).toEqual([bid]);
  });

  it("highestQualityStrategy: single bid returns it unchanged", () => {
    const bid = makeBid("solo", { qualityEstimate: 0.3 });
    expect(highestQualityStrategy.evaluate([bid])).toEqual([bid]);
  });

  it("lowestCostStrategy: tie yields stable ordering (first in wins)", () => {
    const b1 = makeBid("first", { estimatedCostCents: 50 });
    const b2 = makeBid("second", { estimatedCostCents: 50 });
    const result = lowestCostStrategy.evaluate([b1, b2]);
    // Both have the same cost; Array.sort is stable in V8/Node — first stays first.
    expect(result[0]!.agentId).toBe("first");
    expect(result[1]!.agentId).toBe("second");
  });

  it("highestQualityStrategy: tie yields stable ordering", () => {
    const b1 = makeBid("alpha", { qualityEstimate: 0.9 });
    const b2 = makeBid("beta", { qualityEstimate: 0.9 });
    const result = highestQualityStrategy.evaluate([b1, b2]);
    expect(result[0]!.agentId).toBe("alpha");
  });

  describe("createWeightedStrategy edge cases", () => {
    it("all-zero weights falls back to equal 1/3 weights and still ranks", () => {
      const strategy = createWeightedStrategy({
        cost: 0,
        speed: 0,
        quality: 0,
      });
      const bids = [
        makeBid("a", {
          estimatedCostCents: 10,
          estimatedDurationMs: 100,
          qualityEstimate: 0.9,
        }),
        makeBid("b", {
          estimatedCostCents: 50,
          estimatedDurationMs: 500,
          qualityEstimate: 0.5,
        }),
      ];
      const result = strategy.evaluate(bids);
      // With equal weights, 'a' wins on every axis.
      expect(result[0]!.agentId).toBe("a");
    });

    it("all-zero maxCost (all bids cost 0) normalizedCost is 1 for all — speed/quality break tie", () => {
      const strategy = createWeightedStrategy({
        cost: 0.4,
        speed: 0.3,
        quality: 0.3,
      });
      const bids = [
        makeBid("slow", {
          estimatedCostCents: 0,
          estimatedDurationMs: 9000,
          qualityEstimate: 0.5,
        }),
        makeBid("fast", {
          estimatedCostCents: 0,
          estimatedDurationMs: 1000,
          qualityEstimate: 0.9,
        }),
      ];
      const result = strategy.evaluate(bids);
      // maxCost=0 → normalizedCost=1 for both; 'fast' wins on speed+quality.
      expect(result[0]!.agentId).toBe("fast");
    });

    it("all-zero maxDuration normalizedSpeed is 1 for all — cost/quality break tie", () => {
      const strategy = createWeightedStrategy({
        cost: 0.4,
        speed: 0.3,
        quality: 0.3,
      });
      const bids = [
        makeBid("expensive", {
          estimatedCostCents: 500,
          estimatedDurationMs: 0,
          qualityEstimate: 0.5,
        }),
        makeBid("cheap", {
          estimatedCostCents: 10,
          estimatedDurationMs: 0,
          qualityEstimate: 0.9,
        }),
      ];
      const result = strategy.evaluate(bids);
      // maxDuration=0 → normalizedSpeed=1 for both; 'cheap' wins on cost+quality.
      expect(result[0]!.agentId).toBe("cheap");
    });

    it("pure quality weight (1.0) ranks by qualityEstimate descending", () => {
      const strategy = createWeightedStrategy({
        cost: 0,
        speed: 0,
        quality: 1,
      });
      const bids = [
        makeBid("low", { qualityEstimate: 0.3 }),
        makeBid("high", { qualityEstimate: 0.95 }),
        makeBid("mid", { qualityEstimate: 0.6 }),
      ];
      const result = strategy.evaluate(bids);
      expect(result.map((b) => b.agentId)).toEqual(["high", "mid", "low"]);
    });

    it("does not mutate the input array", () => {
      const strategy = createWeightedStrategy({});
      const bids = [makeBid("a"), makeBid("b"), makeBid("c")];
      const original = bids.map((b) => b.agentId);
      strategy.evaluate(bids);
      expect(bids.map((b) => b.agentId)).toEqual(original);
    });
  });
});

// ---------------------------------------------------------------------------
// ContractNetManager gap paths
// ---------------------------------------------------------------------------

describe("ContractNetManager gap paths", () => {
  it("abort between bid collection and execution is rejected", async () => {
    // The signal is already aborted before execute() is called — the pre-bid
    // abort check fires first.
    const controller = new AbortController();
    controller.abort();

    const spec = makeAgent(
      "spec",
      makeModel([
        bidJson({ estimatedCostCents: 10, approach: "fast" }),
        "execution result",
      ])
    );

    await expect(
      ContractNetManager.execute({
        specialists: [spec],
        task: "abort-before-exec",
        signal: controller.signal,
      })
    ).rejects.toThrow(OrchestrationError);
  });

  it("single specialist wins without competition", async () => {
    const spec = makeAgent(
      "solo",
      makeModel([bidJson({ estimatedCostCents: 42 }), "solo output"])
    );
    const result = await ContractNetManager.execute({
      specialists: [spec],
      task: "no competition",
      strategy: lowestCostStrategy,
    });
    expect(result.success).toBe(true);
    expect(result.agentId).toBe("solo");
    expect(result.result).toBe("solo output");
  });

  it("winner is chosen by strategy even when loser bids lower quality", async () => {
    // lowestCostStrategy — spec-cheap (cost 5) beats spec-pricey (cost 500).
    const cheap = makeAgent(
      "spec-cheap",
      makeModel([bidJson({ estimatedCostCents: 5 }), "cheap won"])
    );
    const pricey = makeAgent(
      "spec-pricey",
      makeModel([bidJson({ estimatedCostCents: 500 }), "pricey won"])
    );
    const result = await ContractNetManager.execute({
      specialists: [pricey, cheap], // pricey listed first
      task: "cheapest wins",
      strategy: lowestCostStrategy,
    });
    expect(result.agentId).toBe("spec-cheap");
    expect(result.result).toBe("cheap won");
  });

  it("retryOnNoBids succeeds when second attempt yields a valid bid", async () => {
    // First call: invalid. Second call: valid bid. Third call: execution.
    let callCount = 0;
    const model: BaseChatModel = {
      invoke: vi.fn(async () => {
        callCount++;
        if (callCount === 1)
          return new AIMessage({ content: "not json", response_metadata: {} });
        if (callCount === 2)
          return new AIMessage({
            content: bidJson({ estimatedCostCents: 99 }),
            response_metadata: {},
          });
        return new AIMessage({
          content: "retry execution done",
          response_metadata: {},
        });
      }),
      bindTools: vi.fn(function (this: BaseChatModel) {
        return this;
      }),
      _modelType: () => "base_chat_model",
      _llmType: () => "mock",
    } as unknown as BaseChatModel;

    const spec = makeAgent("retry-spec", model);
    const result = await ContractNetManager.execute({
      specialists: [spec],
      task: "retry success",
      retryOnNoBids: true,
    });
    expect(result.success).toBe(true);
    expect(result.result).toBe("retry execution done");
    expect(callCount).toBe(3);
  });

  it("all specialists return invalid JSON — no bids throws OrchestrationError", async () => {
    const a = makeAgent("a", makeModel(["not json"]));
    const b = makeAgent("b", makeModel(["also garbage"]));
    await expect(
      ContractNetManager.execute({ specialists: [a, b], task: "no bids" })
    ).rejects.toThrow(OrchestrationError);
  });

  it("cfpId in thrown error context when no bids received", async () => {
    const spec = makeAgent("x", makeModel(["garbage"]));
    try {
      await ContractNetManager.execute({ specialists: [spec], task: "ctx" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError);
      const oe = err as OrchestrationError;
      expect(oe.context).toBeDefined();
      expect((oe.context as Record<string, unknown>)["cfpId"]).toMatch(/^cfp_/);
    }
  });

  it("cfpId returned in ContractResult on success", async () => {
    const spec = makeAgent("s", makeModel([bidJson(), "result"]));
    const result = await ContractNetManager.execute({
      specialists: [spec],
      task: "cfp-id-check",
    });
    expect(result.cfpId).toMatch(/^cfp_/);
  });
});

// ---------------------------------------------------------------------------
// maxCostCents is an ENFORCED ceiling, not a hint
// ---------------------------------------------------------------------------

/** Collect every event emitted onto a stub bus. */
function makeRecordingBus(): {
  bus: never;
  emitted: Array<Record<string, unknown>>;
} {
  const emitted: Array<Record<string, unknown>> = [];
  const bus = {
    emit: vi.fn((event: Record<string, unknown>) => {
      emitted.push(event);
    }),
    on: vi.fn(() => () => {}),
    once: vi.fn(() => () => {}),
    onAny: vi.fn(() => () => {}),
  };
  return { bus: bus as never, emitted };
}

describe("ContractNetManager maxCostCents enforcement", () => {
  it("no budget set: every bid stays eligible and the strategy winner is unchanged", async () => {
    // Regression guard — without maxCostCents the filter must be a pure
    // pass-through, so the wildly expensive bid can still win on quality.
    const pricey = makeAgent(
      "pricey",
      makeModel([
        bidJson({ estimatedCostCents: 100_000, qualityEstimate: 0.99 }),
        "pricey ran",
      ])
    );
    const cheap = makeAgent(
      "cheap",
      makeModel([
        bidJson({ estimatedCostCents: 1, qualityEstimate: 0.1 }),
        "cheap ran",
      ])
    );

    const result = await ContractNetManager.execute({
      specialists: [pricey, cheap],
      task: "no budget",
      strategy: highestQualityStrategy,
    });

    expect(result.success).toBe(true);
    expect(result.agentId).toBe("pricey");
    expect(result.result).toBe("pricey ran");
  });

  it("over-budget bid cannot win even when it would otherwise rank first", async () => {
    // highestQualityStrategy would pick `lavish` (0.99) outright, but it bids
    // 900 against a 100-cent ceiling, so only `frugal` remains eligible.
    const lavish = makeAgent(
      "lavish",
      makeModel([
        bidJson({ estimatedCostCents: 900, qualityEstimate: 0.99 }),
        "lavish ran",
      ])
    );
    const frugal = makeAgent(
      "frugal",
      makeModel([
        bidJson({ estimatedCostCents: 40, qualityEstimate: 0.2 }),
        "frugal ran",
      ])
    );

    const result = await ContractNetManager.execute({
      specialists: [lavish, frugal],
      task: "budget capped",
      strategy: highestQualityStrategy,
      maxCostCents: 100,
    });

    expect(result.success).toBe(true);
    expect(result.agentId).toBe("frugal");
    expect(result.result).toBe("frugal ran");
  });

  it("a bid exactly at the budget is eligible (inclusive bound)", async () => {
    const exact = makeAgent(
      "exact",
      makeModel([bidJson({ estimatedCostCents: 250 }), "exact ran"])
    );

    const result = await ContractNetManager.execute({
      specialists: [exact],
      task: "boundary",
      maxCostCents: 250,
    });

    expect(result.success).toBe(true);
    expect(result.agentId).toBe("exact");
    expect(result.result).toBe("exact ran");
  });

  it("all bids over budget: throws OrchestrationError naming cheapest cost and budget", async () => {
    const a = makeAgent("a", makeModel([bidJson({ estimatedCostCents: 700 })]));
    const b = makeAgent("b", makeModel([bidJson({ estimatedCostCents: 420 })]));

    try {
      await ContractNetManager.execute({
        specialists: [a, b],
        task: "unaffordable",
        maxCostCents: 100,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError);
      const oe = err as OrchestrationError;
      expect(oe.pattern).toBe("contract-net");
      // Names the closest miss (420, not 700) and the ceiling.
      expect(oe.message).toContain("420");
      expect(oe.message).toContain("100");
      expect((oe.context as Record<string, unknown>)["cfpId"]).toMatch(/^cfp_/);
    }
  });

  it("all bids over budget: never executes the over-budget specialist", async () => {
    // The whole point of the ceiling — an unaffordable winner must not spend.
    const model = makeModel([bidJson({ estimatedCostCents: 5000 }), "SPENT"]);
    const spec = makeAgent("spendy", model);

    await expect(
      ContractNetManager.execute({
        specialists: [spec],
        task: "must not spend",
        maxCostCents: 10,
      })
    ).rejects.toThrow(OrchestrationError);

    // Exactly one invoke: the bid. The execution call never happened.
    expect(model.invoke).toHaveBeenCalledTimes(1);
  });

  it("all bids over budget: emits contractnet:failed with the budget reason and no award", async () => {
    const { bus, emitted } = makeRecordingBus();
    const spec = makeAgent(
      "spec",
      makeModel([bidJson({ estimatedCostCents: 800 })])
    );

    await expect(
      ContractNetManager.execute({
        specialists: [spec],
        task: "budget event",
        maxCostCents: 50,
        eventBus: bus,
      })
    ).rejects.toThrow(OrchestrationError);

    const types = emitted.map((e) => e["type"]);
    expect(types).toContain("contractnet:bid_received");
    // No contract was awarded, so no award/completion event.
    expect(types).not.toContain("contractnet:awarded");
    expect(types).not.toContain("contractnet:completed");

    const failure = emitted.find((e) => e["type"] === "contractnet:failed");
    expect(failure).toBeDefined();
    expect(failure!["phase"]).toBe("bidding");
    expect(String(failure!["reason"])).toContain("800");
    expect(String(failure!["reason"])).toContain("50");
    expect(failure!["cfpId"]).toMatch(/^cfp_/);
  });

  it("cost-less bid (omitted field coerces to 0) is eligible under a budget", async () => {
    // parseBid coerces a missing estimatedCostCents to 0, which is genuinely
    // within any non-negative budget — so it stays in the running.
    const model = makeModel([
      JSON.stringify({
        estimatedDurationMs: 1000,
        qualityEstimate: 0.8,
        confidence: 0.9,
        approach: "unpriced",
      }),
      "free ran",
    ]);
    const spec = makeAgent("free", model);

    const result = await ContractNetManager.execute({
      specialists: [spec],
      task: "omitted cost",
      maxCostCents: 100,
    });

    expect(result.success).toBe(true);
    expect(result.agentId).toBe("free");
  });

  it("unpriced bid (non-numeric cost coerces to NaN) is INELIGIBLE under a budget", async () => {
    // A NaN cost cannot be proven within budget, so it must not be awarded.
    const model = makeModel([
      JSON.stringify({
        estimatedCostCents: "cheap, trust me",
        estimatedDurationMs: 1000,
        qualityEstimate: 0.9,
        confidence: 0.9,
        approach: "vibes",
      }),
      "SPENT",
    ]);
    const spec = makeAgent("vague", model);

    try {
      await ContractNetManager.execute({
        specialists: [spec],
        task: "nan cost",
        maxCostCents: 100,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OrchestrationError);
      // No finite cost to name, so the message reports the budget alone.
      expect((err as OrchestrationError).message).toContain(
        "No bid within budget of 100 cents"
      );
    }
    expect(model.invoke).toHaveBeenCalledTimes(1);
  });

  it("unpriced bid is still eligible when NO budget is set", async () => {
    // Without a ceiling there is nothing to prove, so a NaN cost is harmless.
    const spec = makeAgent(
      "vague",
      makeModel([
        JSON.stringify({
          estimatedCostCents: "who knows",
          estimatedDurationMs: 1000,
          qualityEstimate: 0.9,
          confidence: 0.9,
          approach: "vibes",
        }),
        "vague ran",
      ])
    );

    const result = await ContractNetManager.execute({
      specialists: [spec],
      task: "nan cost, no budget",
    });

    expect(result.success).toBe(true);
    expect(result.result).toBe("vague ran");
  });

  it("budget set but all bids affordable: emits no failure and awards normally", async () => {
    const { bus, emitted } = makeRecordingBus();
    const a = makeAgent(
      "a",
      makeModel([bidJson({ estimatedCostCents: 10 }), "a ran"])
    );
    const b = makeAgent(
      "b",
      makeModel([bidJson({ estimatedCostCents: 20 }), "b ran"])
    );

    const result = await ContractNetManager.execute({
      specialists: [a, b],
      task: "all affordable",
      strategy: lowestCostStrategy,
      maxCostCents: 1000,
      eventBus: bus,
    });

    expect(result.success).toBe(true);
    expect(result.agentId).toBe("a");
    expect(emitted.map((e) => e["type"])).not.toContain("contractnet:failed");
  });
});

// ---------------------------------------------------------------------------
// requiredCapabilities is an ENFORCED subset filter, not prompt decoration
// ---------------------------------------------------------------------------

describe("ContractNetManager requiredCapabilities enforcement", () => {
  it("no requirement set: bids without capabilities stay eligible", async () => {
    // Regression guard — the overwhelmingly common case. Without a
    // requirement the filter must be a pure pass-through, so a bid that
    // declares nothing still wins on cost.
    const a = makeAgent(
      "a",
      makeModel([bidJson({ estimatedCostCents: 10 }), "a ran"])
    );
    const b = makeAgent(
      "b",
      makeModel([bidJson({ estimatedCostCents: 20 }), "b ran"])
    );

    const result = await ContractNetManager.execute({
      specialists: [a, b],
      task: "no capability requirement",
      strategy: lowestCostStrategy,
    });

    expect(result.success).toBe(true);
    expect(result.agentId).toBe("a");
  });

  it("an unqualified bid cannot win even when it would otherwise rank first", async () => {
    // The defect this closes: lowestCostStrategy would pick `cheap` outright,
    // but it never declares `sql`, so only `expert` remains eligible.
    const cheap = makeAgent(
      "cheap",
      makeModel([bidJson({ estimatedCostCents: 1 }), "cheap ran"])
    );
    const expert = makeAgent(
      "expert",
      makeModel([
        bidJson({ estimatedCostCents: 900, capabilities: ["sql", "python"] }),
        "expert ran",
      ])
    );

    const result = await ContractNetManager.execute({
      specialists: [cheap, expert],
      task: "needs sql",
      strategy: lowestCostStrategy,
      requiredCapabilities: ["sql"],
    });

    expect(result.success).toBe(true);
    expect(result.agentId).toBe("expert");
    expect(result.result).toBe("expert ran");
  });

  it("requires ALL capabilities, not merely one (subset, not intersection)", async () => {
    // `partial` overlaps on `sql` but lacks `security`. An intersection
    // semantic would let it through; the subset semantic must not.
    const partial = makeAgent(
      "partial",
      makeModel([
        bidJson({ estimatedCostCents: 1, capabilities: ["sql"] }),
        "partial ran",
      ])
    );
    const full = makeAgent(
      "full",
      makeModel([
        bidJson({
          estimatedCostCents: 900,
          capabilities: ["sql", "security"],
        }),
        "full ran",
      ])
    );

    const result = await ContractNetManager.execute({
      specialists: [partial, full],
      task: "needs both",
      strategy: lowestCostStrategy,
      requiredCapabilities: ["sql", "security"],
    });

    expect(result.agentId).toBe("full");
  });

  it("extra capabilities beyond the requirement do not disqualify", async () => {
    const generalist = makeAgent(
      "generalist",
      makeModel([
        bidJson({ capabilities: ["sql", "python", "rust", "design"] }),
        "generalist ran",
      ])
    );

    const result = await ContractNetManager.execute({
      specialists: [generalist],
      task: "superset is fine",
      requiredCapabilities: ["sql"],
    });

    expect(result.success).toBe(true);
    expect(result.agentId).toBe("generalist");
  });

  it("no qualifying bid: throws OrchestrationError naming the requirement", async () => {
    const a = makeAgent("a", makeModel([bidJson({}), "a ran"]));

    await expect(
      ContractNetManager.execute({
        specialists: [a],
        task: "nobody qualifies",
        requiredCapabilities: ["sql", "security"],
      })
    ).rejects.toThrow(/No bid met the required capabilities: sql, security/);
    await expect(
      ContractNetManager.execute({
        specialists: [makeAgent("a2", makeModel([bidJson({}), "a ran"]))],
        task: "nobody qualifies",
        requiredCapabilities: ["sql"],
      })
    ).rejects.toBeInstanceOf(OrchestrationError);
  });

  it("no qualifying bid: never executes the unqualified specialist", async () => {
    // Enforcement must happen BEFORE the winner runs, or the contract has
    // already been performed by an agent that could not do the work.
    const model = makeModel([bidJson({}), "should never run"]);
    const a = makeAgent("a", model);

    await expect(
      ContractNetManager.execute({
        specialists: [a],
        task: "must not execute",
        requiredCapabilities: ["sql"],
      })
    ).rejects.toThrow(OrchestrationError);

    // Exactly one invoke: the bid. No execution call followed.
    expect(model.invoke).toHaveBeenCalledTimes(1);
  });

  it("no qualifying bid: emits contractnet:failed and never awards", async () => {
    const { bus, emitted } = makeRecordingBus();
    const a = makeAgent("a", makeModel([bidJson({}), "a ran"]));

    await expect(
      ContractNetManager.execute({
        specialists: [a],
        task: "capability event",
        requiredCapabilities: ["sql"],
        eventBus: bus,
      })
    ).rejects.toThrow(OrchestrationError);

    const types = emitted.map((e) => e["type"]);
    expect(types).toContain("contractnet:failed");
    expect(types).not.toContain("contractnet:awarded");
    const failure = emitted.find((e) => e["type"] === "contractnet:failed");
    expect(String(failure?.["reason"])).toContain("sql");
  });

  it("budget is reported first when a bid fails both gates", async () => {
    // Ordering is deliberate: the caller fixes affordability by raising a
    // number, so name that before the roster problem.
    const a = makeAgent(
      "a",
      makeModel([bidJson({ estimatedCostCents: 900 }), "a ran"])
    );

    await expect(
      ContractNetManager.execute({
        specialists: [a],
        task: "both gates fail",
        maxCostCents: 100,
        requiredCapabilities: ["sql"],
      })
    ).rejects.toThrow(/No bid within budget/);
  });

  it("matching is exact: a near-miss tag does not qualify", async () => {
    const a = makeAgent(
      "a",
      makeModel([bidJson({ capabilities: ["SQL"] }), "a ran"])
    );

    await expect(
      ContractNetManager.execute({
        specialists: [a],
        task: "case sensitivity",
        requiredCapabilities: ["sql"],
      })
    ).rejects.toThrow(/No bid met the required capabilities/);
  });

  it("whitespace in declared and required tags is trimmed before matching", async () => {
    const a = makeAgent(
      "a",
      makeModel([bidJson({ capabilities: ["  sql  "] }), "a ran"])
    );

    const result = await ContractNetManager.execute({
      specialists: [a],
      task: "trimmed",
      requiredCapabilities: [" sql "],
    });

    expect(result.success).toBe(true);
  });

  it("an all-blank requirement list is treated as no requirement", async () => {
    const a = makeAgent("a", makeModel([bidJson({}), "a ran"]));

    const result = await ContractNetManager.execute({
      specialists: [a],
      task: "blank requirement",
      requiredCapabilities: ["   "],
    });

    expect(result.success).toBe(true);
    expect(result.agentId).toBe("a");
  });

  it("malformed capabilities degrade to unqualified rather than throwing", async () => {
    // Untrusted model output: a string, an object, and non-string entries must
    // not crash the parse, and must not be coerced into matching tags.
    for (const malformed of ["sql", { sql: true }, [0], [null], []]) {
      const a = makeAgent("a", makeModel([rawBidJson(malformed), "a ran"]));
      await expect(
        ContractNetManager.execute({
          specialists: [a],
          task: "malformed capabilities",
          requiredCapabilities: ["sql"],
        })
      ).rejects.toThrow(/No bid met the required capabilities/);
    }
  });

  it("does not mint a matching tag by coercing a number", async () => {
    // `String(0)` would produce the capability "0"; dropping non-strings
    // prevents a requirement of "0" from being met by a numeric entry.
    const a = makeAgent("a", makeModel([rawBidJson([0]), "a ran"]));

    await expect(
      ContractNetManager.execute({
        specialists: [a],
        task: "numeric coercion",
        requiredCapabilities: ["0"],
      })
    ).rejects.toThrow(/No bid met the required capabilities/);
  });

  it("asks bidders to declare capabilities only when the CFP requires them", async () => {
    // A bidder can only be filtered on a field it was asked to supply, so the
    // schema line must appear exactly when the filter is active — and must not
    // appear otherwise, to avoid training bidders to emit a field nothing
    // reads on the common no-requirement CFP.
    const bidPromptOf = (model: BaseChatModel): string => {
      const calls = (model.invoke as ReturnType<typeof vi.fn>).mock.calls;
      return calls
        .map((call) =>
          (call[0] as BaseMessage[]).map((m) => String(m.content)).join("\n")
        )
        .find((text) => text.includes("Respond ONLY with a JSON object"))!;
    };

    const withReqModel = makeModel([bidJson({ capabilities: ["sql"] }), "ran"]);
    await ContractNetManager.execute({
      specialists: [makeAgent("withReq", withReqModel)],
      task: "prompt with requirement",
      requiredCapabilities: ["sql"],
    });
    expect(bidPromptOf(withReqModel)).toContain('"capabilities"');

    const noReqModel = makeModel([bidJson({}), "ran"]);
    await ContractNetManager.execute({
      specialists: [makeAgent("noReq", noReqModel)],
      task: "prompt without requirement",
    });
    expect(bidPromptOf(noReqModel)).not.toContain('"capabilities"');
  });
});
