/**
 * Focused tests for the ContractNetManager phase seams extracted in
 * DZUPAGENT-CODE-M-11 (execute() decomposition).
 *
 * Pins the `recordBids` invariant that the broader contract-net suites assert
 * only loosely: every collected bid is appended to state AND emits exactly one
 * `bid_received` event (across the initial and any retry round).
 *
 * Behavior is IDENTICAL to pre-refactor execute(); the refactor was a pure
 * structural extraction into private phase methods.
 */
import { describe, it, expect, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { DzupAgent } from "../agent/dzip-agent.js";
import { ContractNetManager } from "../orchestration/contract-net/contract-net-manager.js";
import { lowestCostStrategy } from "../orchestration/contract-net/bid-strategies.js";
import { createEventBus, type DzupEvent } from "@dzupagent/core";

function bidJson(costCents: number): string {
  return JSON.stringify({
    estimatedCostCents: costCents,
    estimatedDurationMs: 100,
    qualityEstimate: 0.8,
    confidence: 0.8,
    approach: `approach-${costCents}`,
  });
}

/** Model whose first invoke is the bid, subsequent are execution output. */
function biddingModel(bid: string): BaseChatModel {
  let i = 0;
  return {
    invoke: vi.fn(async (_m: BaseMessage[]) => {
      i++;
      return new AIMessage({
        content: i === 1 ? bid : "executed",
        response_metadata: {},
      });
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this;
    }),
    _modelType: () => "base_chat_model",
    _llmType: () => "mock",
  } as unknown as BaseChatModel;
}

function agent(id: string, model: BaseChatModel): DzupAgent {
  return new DzupAgent({
    id,
    description: id,
    instructions: `You are ${id}.`,
    model,
  });
}

describe("ContractNetManager recordBids seam (CODE-M-11)", () => {
  it("emits exactly one bid_received event per collected bid", async () => {
    const eventBus = createEventBus();
    const events: DzupEvent[] = [];
    eventBus.onAny((e) => events.push(e));

    const specialists = [
      agent("a", biddingModel(bidJson(30))),
      agent("b", biddingModel(bidJson(10))),
      agent("c", biddingModel(bidJson(20))),
    ];

    const result = await ContractNetManager.execute({
      specialists,
      task: "multi-bid",
      strategy: lowestCostStrategy,
      eventBus,
    });

    // Lowest cost wins.
    expect(result.success).toBe(true);
    expect(result.agentId).toBe("b");

    const bidReceived = events.filter(
      (e) =>
        e.type === "protocol:message_sent" &&
        (e as { messageType?: string }).messageType ===
          "contract-net:bid_received"
    );
    expect(bidReceived).toHaveLength(3);

    const bidderIds = bidReceived
      .map((e) => (e as { payload: { agentId: string } }).payload.agentId)
      .sort();
    expect(bidderIds).toEqual(["a", "b", "c"]);
  });
});
