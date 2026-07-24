import { describe, it, expect, vi } from "vitest";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { DzupAgent } from "../../../../agent/dzip-agent.js";
import type { ParticipantDefinition } from "../../team-definition.js";
import type { TeamSpawnedAgent } from "../../team-workspace.js";
import type { ResolvedParticipant } from "../team-pattern.js";
import { peerToPeerPattern } from "../peer-to-peer-pattern.js";
import {
  DEFAULT_MEMBER_MAX_RETRIES,
  runMemberAgent,
} from "../pattern-utils.js";
import { buildContext } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// runMemberAgent (unit)
// ---------------------------------------------------------------------------

function fakeAgent(
  generate: (...args: unknown[]) => Promise<unknown>
): DzupAgent {
  return { id: "member", generate: vi.fn(generate) } as unknown as DzupAgent;
}

const TASK = [new HumanMessage("do the task")];

describe("runMemberAgent", () => {
  it("returns the first successful result without retry policy", async () => {
    const agent = fakeAgent(async () => ({ content: "ok" }));
    const res = await runMemberAgent(agent, TASK);
    expect(res).toEqual({ content: "ok" });
    expect(agent.generate).toHaveBeenCalledTimes(1);
  });

  it("does not retry by default — first failure propagates", async () => {
    const agent = fakeAgent(async () => {
      throw new Error("boom");
    });
    await expect(runMemberAgent(agent, TASK)).rejects.toThrow("boom");
    expect(agent.generate).toHaveBeenCalledTimes(1);
  });

  it("retries once by default when retryOnFailure is enabled", async () => {
    let calls = 0;
    const agent = fakeAgent(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return { content: "recovered" };
    });
    const res = await runMemberAgent(agent, TASK, { retryOnFailure: true });
    expect(res).toEqual({ content: "recovered" });
    expect(agent.generate).toHaveBeenCalledTimes(
      1 + DEFAULT_MEMBER_MAX_RETRIES
    );
  });

  it("bounds attempts at 1 + maxRetries and rethrows the last error", async () => {
    let calls = 0;
    const agent = fakeAgent(async () => {
      calls += 1;
      throw new Error(`failure ${calls}`);
    });
    await expect(
      runMemberAgent(agent, TASK, { retryOnFailure: true, maxRetries: 2 })
    ).rejects.toThrow("failure 3");
    expect(agent.generate).toHaveBeenCalledTimes(3);
  });

  it("retryOnFailure false behaves like no policy", async () => {
    const agent = fakeAgent(async () => {
      throw new Error("boom");
    });
    await expect(
      runMemberAgent(agent, TASK, { retryOnFailure: false, maxRetries: 5 })
    ).rejects.toThrow("boom");
    expect(agent.generate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// peer_to_peer integration — retry policy heals a flaky member
// ---------------------------------------------------------------------------

function createFlakyModel(failures: number, response: string): BaseChatModel {
  let remaining = failures;
  const invoke = vi.fn(async () => {
    if (remaining > 0) {
      remaining -= 1;
      throw new Error("transient provider failure");
    }
    return new AIMessage({ content: response, response_metadata: {} });
  });
  return {
    invoke,
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this;
    }),
    _modelType: () => "base_chat_model",
    _llmType: () => "mock",
  } as unknown as BaseChatModel;
}

function buildFlakyResolved(id: string, failures: number): ResolvedParticipant {
  const agent = new DzupAgent({
    id,
    description: `${id} agent`,
    instructions: `You are ${id}.`,
    model: createFlakyModel(failures, `${id}-result`),
  });
  const participant: ParticipantDefinition = {
    id,
    role: "specialist",
    model: "mock-model",
  };
  const spawned: TeamSpawnedAgent = {
    agent,
    status: "idle",
    role: "specialist" as TeamSpawnedAgent["role"],
    tags: [],
    spawnedAt: Date.now(),
  };
  return { participant, spawned };
}

describe("peer_to_peer with participant retry policy", () => {
  it("a member that fails once succeeds when retryOnFailure is enabled", async () => {
    const { ctx } = buildContext(
      "peer_to_peer",
      [buildFlakyResolved("flaky", 1), buildFlakyResolved("steady", 0)],
      { policies: { execution: { retryOnFailure: true } } }
    );
    const result = await peerToPeerPattern.execute(ctx);
    expect(result.agentResults.map((r) => r.success)).toEqual([true, true]);
    expect(result.content).toContain("flaky-result");
    expect(result.content).toContain("steady-result");
  });

  it("the same flaky member fails without the retry policy (control)", async () => {
    const { ctx } = buildContext(
      "peer_to_peer",
      [buildFlakyResolved("flaky", 1), buildFlakyResolved("steady", 0)],
      {}
    );
    const result = await peerToPeerPattern.execute(ctx);
    expect(result.agentResults.map((r) => r.success)).toEqual([false, true]);
  });
});
