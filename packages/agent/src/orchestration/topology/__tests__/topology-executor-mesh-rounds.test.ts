/**
 * Tests for executeMesh() multi-round peer exchange.
 *
 * Mesh is an all-to-all topology: after round 0 every agent must see every
 * *other* agent's previous output, and never its own. These tests pin that
 * contract, the round-boundary abort check, and the multi-round metrics.
 */
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { DzupAgent } from "../../../agent/dzip-agent.js";
import { TopologyExecutor } from "../topology-executor.js";

/**
 * Agent that records the prompt text it received on every call and replies
 * with a per-round marker so peer propagation is observable.
 */
function createRecordingAgent(id: string): {
  agent: DzupAgent;
  prompts: string[];
} {
  const prompts: string[] = [];
  let round = 0;

  const model = {
    invoke: vi.fn(async (messages: BaseMessage[]) => {
      const last = messages[messages.length - 1];
      prompts.push(String(last?.content ?? ""));
      round++;
      return new AIMessage({
        content: `${id}-round${round}`,
        response_metadata: {},
      });
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this;
    }),
    _modelType: () => "base_chat_model",
    _llmType: () => "mock",
  } as unknown as BaseChatModel;

  return {
    agent: new DzupAgent({
      id,
      description: `Recording agent ${id}`,
      instructions: `You are ${id}.`,
      model,
    }),
    prompts,
  };
}

function createAlwaysFailAgent(id: string, failure: string): DzupAgent {
  const model = {
    invoke: vi.fn(async () => {
      throw new Error(failure);
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this;
    }),
    _modelType: () => "base_chat_model",
    _llmType: () => "mock",
  } as unknown as BaseChatModel;

  return new DzupAgent({
    id,
    description: `Always failing agent ${id}`,
    instructions: `You are ${id}.`,
    model,
  });
}

function countInvocations(agent: DzupAgent): number {
  const model = (agent as unknown as { resolvedModel: BaseChatModel })
    .resolvedModel;
  return (model.invoke as ReturnType<typeof vi.fn>).mock.calls.length;
}

describe("TopologyExecutor.executeMesh — multi-round peer exchange", () => {
  it("sends only the bare task when maxRounds is 1", async () => {
    const a = createRecordingAgent("alpha");
    const b = createRecordingAgent("beta");

    const { results, metrics } = await TopologyExecutor.executeMesh({
      agents: [a.agent, b.agent],
      task: "Assess the outage",
      maxRounds: 1,
    });

    expect(a.prompts).toEqual(["Assess the outage"]);
    expect(b.prompts).toEqual(["Assess the outage"]);
    expect(results).toEqual(["alpha-round1", "beta-round1"]);
    expect(metrics.messageCount).toBe(2);
    expect(metrics.errorCount).toBe(0);
  });

  it("gives each agent its peers' previous output but not its own", async () => {
    const a = createRecordingAgent("alpha");
    const b = createRecordingAgent("beta");
    const c = createRecordingAgent("gamma");

    await TopologyExecutor.executeMesh({
      agents: [a.agent, b.agent, c.agent],
      task: "Assess the outage",
      maxRounds: 2,
    });

    const alphaRound2 = a.prompts[1]!;

    // Peers' round-1 outputs are present...
    expect(alphaRound2).toContain("beta-round1");
    expect(alphaRound2).toContain("gamma-round1");
    // ...and the agent's own round-1 output is not.
    expect(alphaRound2).not.toContain("alpha-round1");

    // The original task is still carried alongside the peer block.
    expect(alphaRound2).toContain("Assess the outage");
    expect(alphaRound2).toContain(
      "Peer agent outputs from the previous round:"
    );

    // Symmetric for another agent.
    const gammaRound2 = c.prompts[1]!;
    expect(gammaRound2).toContain("alpha-round1");
    expect(gammaRound2).toContain("beta-round1");
    expect(gammaRound2).not.toContain("gamma-round1");
  });

  it("labels peers by agent name", async () => {
    const a = createRecordingAgent("alpha");
    const b = createRecordingAgent("beta");

    await TopologyExecutor.executeMesh({
      agents: [a.agent, b.agent],
      task: "Label check",
      maxRounds: 2,
    });

    expect(a.prompts[1]).toContain("beta:");
  });

  it("carries a failed peer as an [error: ...] placeholder and keeps going", async () => {
    const ok = createRecordingAgent("ok");
    const bad = createAlwaysFailAgent("bad", "model exploded");

    const { results, metrics } = await TopologyExecutor.executeMesh({
      agents: [ok.agent, bad],
      task: "Mixed mesh",
      maxRounds: 2,
    });

    // The healthy agent sees the failure as its peer's contribution.
    expect(ok.prompts[1]).toContain("[error: model exploded]");

    // Final round is index-aligned and well-formed.
    expect(results).toHaveLength(2);
    expect(results[0]).toBe("ok-round2");
    expect(results[1]).toContain("[error: model exploded]");

    // The failing agent is retried rather than ejected: 1 failure per round.
    expect(metrics.errorCount).toBe(2);
    expect(metrics.messageCount).toBe(4);
  });

  it("defaults to 2 rounds when maxRounds is omitted", async () => {
    const a = createRecordingAgent("alpha");
    const b = createRecordingAgent("beta");

    const { metrics } = await TopologyExecutor.executeMesh({
      agents: [a.agent, b.agent],
      task: "Default rounds",
    });

    expect(a.prompts).toHaveLength(2);
    expect(b.prompts).toHaveLength(2);
    expect(metrics.messageCount).toBe(4);
  });

  it("counts one message per agent per round", async () => {
    const agents = [
      createRecordingAgent("a1"),
      createRecordingAgent("a2"),
      createRecordingAgent("a3"),
    ];

    const { metrics } = await TopologyExecutor.executeMesh({
      agents: agents.map((entry) => entry.agent),
      task: "Count messages",
      maxRounds: 3,
    });

    expect(metrics.messageCount).toBe(9); // 3 agents * 3 rounds
    expect(metrics.agentCount).toBe(3);
  });

  it("aborts at a round boundary and stops invoking agents", async () => {
    const controller = new AbortController();
    const prompts: string[] = [];

    const makeAgent = (id: string): DzupAgent => {
      const model = {
        invoke: vi.fn(async (messages: BaseMessage[]) => {
          prompts.push(String(messages[messages.length - 1]?.content ?? ""));
          // Abort once round 0 has produced output.
          controller.abort();
          return new AIMessage({
            content: `${id}-out`,
            response_metadata: {},
          });
        }),
        bindTools: vi.fn(function (this: BaseChatModel) {
          return this;
        }),
        _modelType: () => "base_chat_model",
        _llmType: () => "mock",
      } as unknown as BaseChatModel;

      return new DzupAgent({ id, instructions: id, model });
    };

    const agents = [makeAgent("x1"), makeAgent("x2")];

    await expect(
      TopologyExecutor.executeMesh({
        agents,
        task: "Abort mid-mesh",
        maxRounds: 3,
        signal: controller.signal,
      })
    ).rejects.toThrow("aborted");

    // Only round 0 ran; the round-1 boundary check threw first.
    expect(prompts).toHaveLength(2);
  });

  it("throws OrchestrationError when aborted before the first round", async () => {
    const controller = new AbortController();
    controller.abort();

    const a = createRecordingAgent("alpha");

    await expect(
      TopologyExecutor.executeMesh({
        agents: [a.agent],
        task: "Pre-aborted",
        signal: controller.signal,
      })
    ).rejects.toThrow("aborted");

    expect(countInvocations(a.agent)).toBe(0);
  });

  it("omits the peer block for a single-agent mesh", async () => {
    const solo = createRecordingAgent("solo");

    const { results } = await TopologyExecutor.executeMesh({
      agents: [solo.agent],
      task: "Solo mesh",
      maxRounds: 2,
    });

    // No peers exist, so round 2 receives the bare task rather than an
    // empty "Peer agent outputs" header.
    expect(solo.prompts[1]).toBe("Solo mesh");
    expect(results).toEqual(["solo-round2"]);
  });
});
