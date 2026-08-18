/**
 * End-to-end contract-net configuration through `TeamRuntime`.
 *
 * These tests deliberately do NOT mock `ContractNetManager` — they drive the
 * real negotiation from a real `TeamRuntime` so they prove the config actually
 * arrives and takes effect, rather than just that a spy saw it. The headline
 * case is `maxCostCents`: it is an ENFORCED ceiling in the manager (over-budget
 * bids are filtered before ranking, and the negotiation throws when none fit),
 * but before the `policies.contractNet` group existed a team run could never
 * set it, so that enforcement was unreachable through the team path.
 */
import { describe, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { createEventBus, type DzupEvent } from "@dzupagent/core/events";
import { DzupAgent } from "../../../agent/dzip-agent.js";
import { TeamRuntime, type TeamRuntimeOptions } from "../team-runtime.js";
import type { TeamDefinition } from "../team-definition.js";
import type { TeamPolicies } from "../team-policy.js";
import type { TeamSpawnedAgent } from "../team-workspace.js";

/**
 * A specialist that bids a fixed cost and then returns a fixed execution
 * result. The first `generate` call is the bid (the manager asks for JSON), and
 * any later call is the awarded execution.
 */
function createBiddingAgent(id: string, costCents: number): DzupAgent {
  let calls = 0;
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    calls += 1;
    if (calls === 1) {
      return new AIMessage({
        content: JSON.stringify({
          estimatedCostCents: costCents,
          estimatedDurationMs: 10,
          qualityEstimate: 0.9,
          confidence: 0.9,
          approach: `${id} approach`,
        }),
        response_metadata: {},
      });
    }
    return new AIMessage({
      content: `${id} executed`,
      response_metadata: {},
    });
  });
  const model = {
    invoke,
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this;
    }),
    _modelType: () => "base_chat_model",
    _llmType: () => "mock",
  } as unknown as BaseChatModel;

  return new DzupAgent({
    id,
    description: `${id} agent`,
    instructions: `You are ${id}.`,
    model,
  });
}

/**
 * Build a contract_net TeamRuntime whose specialists bid the given costs.
 * `mgr` is the supervisor (excluded from bidding by the pattern).
 */
function buildRuntime(
  bids: Record<string, number>,
  options?: Partial<TeamRuntimeOptions>
): TeamRuntime {
  const specialistIds = Object.keys(bids);
  const definition: TeamDefinition = {
    id: "team-cn",
    name: "Contract-net team",
    coordinatorPattern: "contract_net",
    participants: [
      { id: "mgr", role: "supervisor", model: "mock-model" },
      ...specialistIds.map((id) => ({
        id,
        role: "specialist",
        model: "mock-model",
      })),
    ],
  };

  return new TeamRuntime({
    definition,
    resolveParticipant: async (participant): Promise<TeamSpawnedAgent> => ({
      agent:
        participant.id === "mgr"
          ? createBiddingAgent("mgr", 0)
          : createBiddingAgent(participant.id, bids[participant.id]!),
      status: "idle",
      role: participant.role as TeamSpawnedAgent["role"],
      tags: [],
      spawnedAt: Date.now(),
    }),
    ...options,
  });
}

describe("TeamRuntime — contract_net configuration", () => {
  describe("maxCostCents reaches the manager and is enforced", () => {
    it("awards the affordable bid when an expensive one exceeds the ceiling", async () => {
      // cheap=50 fits a 100c budget; pricey=500 does not. Without the budget,
      // the default weighted strategy would be free to pick either.
      const runtime = buildRuntime(
        { cheap: 50, pricey: 500 },
        { policies: { contractNet: { maxCostCents: 100 } } }
      );

      const result = await runtime.execute("do the thing");

      expect(result.pattern).toBe("contract-net");
      expect(result.content).toBe("cheap executed");
      const winner = result.agentResults.find((r) => r.agentId === "cheap")!;
      expect(winner.success).toBe(true);
      // The over-budget specialist never won, so it never executed.
      const loser = result.agentResults.find((r) => r.agentId === "pricey")!;
      expect(loser.content).toContain('"estimatedCostCents":500');
      expect(loser.success).toBe(true);
    });

    it("fails the run when EVERY bid exceeds the ceiling", async () => {
      const runtime = buildRuntime(
        { a: 400, b: 500 },
        { policies: { contractNet: { maxCostCents: 100 } } }
      );

      // The manager throws OrchestrationError naming the cheapest miss; the
      // team run surfaces it through the normal failure path.
      await expect(runtime.execute("do the thing")).rejects.toThrow(
        /No bid within budget: cheapest bid is 400 cents, budget is 100 cents/
      );
    });

    it("without the policy, an expensive bid can still win (pre-change behaviour)", async () => {
      // Regression anchor: this is precisely the state the ceiling was
      // unreachable in. `pricey` bids far above what any budget would allow,
      // and with no policy nothing filters it out.
      const runtime = buildRuntime({ pricey: 5000 });

      const result = await runtime.execute("do the thing");

      expect(result.content).toBe("pricey executed");
    });
  });

  describe("eventBus threading", () => {
    it("emits contractnet:* events from a team run", async () => {
      const observed: DzupEvent[] = [];
      const eventBus = createEventBus();
      eventBus.onAny((event) => {
        if (event.type.startsWith("contractnet:")) observed.push(event);
      });

      const runtime = buildRuntime({ s1: 10 }, { eventBus });
      await runtime.execute("do the thing");

      const types = observed.map((e) => e.type);
      expect(types).toContain("contractnet:announced");
      expect(types).toContain("contractnet:bid_received");
      expect(types).toContain("contractnet:awarded");
      expect(types).toContain("contractnet:completed");
    });

    it("emits nothing when no bus is wired (and does not throw)", async () => {
      const runtime = buildRuntime({ s1: 10 });
      await expect(runtime.execute("do the thing")).resolves.toBeDefined();
    });
  });

  describe("signal threading", () => {
    it("aborts a team contract-net run when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const runtime = buildRuntime({ s1: 10 }, { signal: controller.signal });

      await expect(runtime.execute("do the thing")).rejects.toThrow(
        /contract-net aborted before execution/
      );
    });

    it("completes normally when the signal is never aborted", async () => {
      const controller = new AbortController();
      const runtime = buildRuntime({ s1: 10 }, { signal: controller.signal });

      const result = await runtime.execute("do the thing");
      expect(result.content).toBe("s1 executed");
    });
  });

  describe("policy validation at construction", () => {
    it("rejects a contractNet policy on a non-contract_net team", () => {
      const definition: TeamDefinition = {
        id: "team-sup",
        name: "Supervisor team",
        coordinatorPattern: "supervisor",
        participants: [{ id: "mgr", role: "supervisor", model: "mock-model" }],
      };
      const policies: TeamPolicies = { contractNet: { maxCostCents: 100 } };

      expect(() => new TeamRuntime({ definition, policies })).toThrow(
        /contractNet policy group is only supported for coordinator pattern 'contract_net'/
      );
    });

    it("accepts a contractNet policy on a contract_net team", () => {
      expect(() =>
        buildRuntime(
          { s1: 10 },
          { policies: { contractNet: { maxCostCents: 100 } } }
        )
      ).not.toThrow();
    });
  });
});
