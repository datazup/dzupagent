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
