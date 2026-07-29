/**
 * End-to-end proof that `createDeterministicVerdictService` actually wires into
 * a real `TeamRuntime` and makes the acceptance gates bite.
 *
 * The unit tests next door verify the scorer's arithmetic in isolation, which
 * would still pass if the service did not satisfy the runtime's injection
 * contract at all. This test closes that gap: it drives a genuine run through
 * `TeamRuntime.execute` and asserts the gate rejects, passes, and stops being
 * reported as `skipped` once a scorer is present.
 */
import { describe, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { DzupAgent } from "@dzupagent/agent";
import { TeamRuntime } from "@dzupagent/agent/orchestration";
import type { TeamRuntimeEvent } from "@dzupagent/agent/orchestration";
import { createDeterministicVerdictService } from "../deterministic-verdict-service.js";

function createAgent(id: string): DzupAgent {
  const model: BaseChatModel = {
    invoke: vi.fn(async (_messages: BaseMessage[]) => {
      return new AIMessage({ content: `${id}-out`, response_metadata: {} });
    }),
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this;
    }),
    _modelType: () => "base_chat_model",
    _llmType: () => "mock",
  } as unknown as BaseChatModel;
  return new DzupAgent({ id, name: id, instructions: `You are ${id}.`, model });
}

function makeRuntime(options: {
  policies: ConstructorParameters<typeof TeamRuntime>[0]["policies"];
  governance?: Parameters<typeof Object>[0];
  evaluation?: unknown;
  onEvent?: (event: TeamRuntimeEvent) => void;
}): TeamRuntime {
  const definition = {
    id: "eval-team",
    name: "eval-team",
    coordinatorPattern: "peer_to_peer" as const,
    participants: [
      { id: "p1", role: "worker", model: "mock" },
      { id: "p2", role: "worker", model: "mock" },
    ],
  };
  const agents = new Map(
    definition.participants.map((p) => [p.id, createAgent(p.id)])
  );
  return new TeamRuntime({
    definition,
    policies: options.policies,
    ...(options.evaluation ? { evaluation: options.evaluation } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    generateRunId: () => "run-det",
    resolveParticipant: async (participant) => ({
      agent: agents.get(participant.id)!,
      status: "idle" as const,
      role: participant.role as "worker",
      tags: [],
      spawnedAt: 0,
    }),
  } as ConstructorParameters<typeof TeamRuntime>[0]);
}

describe("createDeterministicVerdictService wired into TeamRuntime", () => {
  const policies = {
    evaluation: { scorerModel: "mock", minPassScore: 0.9 },
  };

  it("reports a skipped verdict when the declared gate has no scorer", async () => {
    const events: TeamRuntimeEvent[] = [];
    const runtime = makeRuntime({ policies, onEvent: (e) => events.push(e) });

    await runtime.execute("task");

    expect(
      events.filter((e) => e.type === "team_verdict_evaluated")
    ).toMatchObject([{ gate: "evaluation", outcome: "skipped" }]);
  });

  it("passes the gate and stops reporting skipped once the scorer is injected", async () => {
    const events: TeamRuntimeEvent[] = [];
    const runtime = makeRuntime({
      policies,
      // All participants succeed against the mock model, so the computed
      // score is 1.0 and clears the 0.9 bar.
      evaluation: createDeterministicVerdictService(),
      onEvent: (e) => events.push(e),
    });

    await runtime.execute("task");

    const verdicts = events.filter((e) => e.type === "team_verdict_evaluated");
    expect(verdicts).toMatchObject([
      { gate: "evaluation", outcome: "passed", score: 1 },
    ]);
    expect(events.some((e) => e.type === "team_completed")).toBe(true);
  });

  it("rejects the run when the injected scorer falls below the threshold", async () => {
    const events: TeamRuntimeEvent[] = [];
    const runtime = makeRuntime({
      policies,
      evaluation: createDeterministicVerdictService({ score: 0.1 }),
      onEvent: (e) => events.push(e),
    });

    await expect(runtime.execute("task")).rejects.toThrow(/minPassScore/);

    expect(
      events.filter((e) => e.type === "team_verdict_evaluated")
    ).toMatchObject([{ gate: "evaluation", outcome: "rejected", score: 0.1 }]);
  });
});
