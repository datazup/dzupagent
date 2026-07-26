/**
 * `ctx.signal` threading through the non-contract-net team patterns.
 *
 * Before this suite only `contract_net` read `TeamPatternContext.signal`, so a
 * `supervisor` / `council` / `peer_to_peer` / `blackboard` team run was
 * non-cancellable: `TeamRuntime` populated the signal and the pattern dropped
 * it. These tests pin the two ends of the contract for each pattern, mirroring
 * the established contract-net expectations in
 * `team-runtime-contract-net.test.ts`:
 *
 *   1. an already-aborted signal rejects the run rather than spawning work;
 *   2. a signal that never aborts leaves behaviour completely unchanged.
 *
 * They drive real `TeamRuntime` instances (no pattern mocking) so they prove
 * the signal actually reaches the coordination code.
 */
import { describe, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { DzupAgent } from "../../../agent/dzip-agent.js";
import { TeamRuntime, type TeamRuntimeOptions } from "../team-runtime.js";
import type { CoordinatorPattern, TeamDefinition } from "../team-definition.js";
import type { TeamSpawnedAgent } from "../team-workspace.js";

/** Records every invocation so a test can assert no model work was attempted. */
interface TrackedAgent {
  agent: DzupAgent;
  invoke: ReturnType<typeof vi.fn>;
}

function createTrackedAgent(id: string): TrackedAgent {
  const invoke = vi.fn(
    async (_messages: BaseMessage[]) =>
      new AIMessage({ content: `${id}-result`, response_metadata: {} })
  );
  const model = {
    invoke,
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this;
    }),
    _modelType: () => "base_chat_model",
    _llmType: () => "mock",
  } as unknown as BaseChatModel;

  return {
    invoke,
    agent: new DzupAgent({
      id,
      description: `${id} agent`,
      instructions: `You are ${id}.`,
      model,
    }),
  };
}

/**
 * Build a runtime for `pattern` with one supervisor + two workers. Two workers
 * keep every pattern in its real coordination path rather than the degenerate
 * `runSingleParticipant` fallback.
 */
function buildRuntime(
  pattern: CoordinatorPattern,
  options?: Partial<TeamRuntimeOptions>
): { runtime: TeamRuntime; agents: Map<string, TrackedAgent> } {
  const agents = new Map<string, TrackedAgent>([
    ["mgr", createTrackedAgent("mgr")],
    ["w1", createTrackedAgent("w1")],
    ["w2", createTrackedAgent("w2")],
  ]);

  const definition: TeamDefinition = {
    id: `team-${pattern}`,
    name: `Team ${pattern}`,
    coordinatorPattern: pattern,
    participants: [
      { id: "mgr", role: "supervisor", model: "mock-model" },
      { id: "w1", role: "worker", model: "mock-model" },
      { id: "w2", role: "worker", model: "mock-model" },
    ],
  };

  const runtime = new TeamRuntime({
    ...options,
    definition,
    resolveParticipant: async (participant): Promise<TeamSpawnedAgent> => ({
      agent: agents.get(participant.id)!.agent,
      status: "idle",
      role: participant.role as TeamSpawnedAgent["role"],
      tags: [],
      spawnedAt: Date.now(),
    }),
  });

  return { runtime, agents };
}

const PATTERNS: CoordinatorPattern[] = [
  "supervisor",
  "council",
  "peer_to_peer",
  "blackboard",
];

describe("team pattern signal threading", () => {
  for (const pattern of PATTERNS) {
    describe(pattern, () => {
      it("aborts the run when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();

        const { runtime, agents } = buildRuntime(pattern, {
          signal: controller.signal,
        });

        await expect(runtime.execute("do the thing")).rejects.toThrow();

        // Fail-fast means no participant model call was ever attempted.
        for (const tracked of agents.values()) {
          expect(tracked.invoke).not.toHaveBeenCalled();
        }
      });

      it("completes normally when the signal is never aborted", async () => {
        const controller = new AbortController();
        const { runtime } = buildRuntime(pattern, {
          signal: controller.signal,
        });

        const result = await runtime.execute("do the thing");
        expect(result.content).toBeTypeOf("string");
        expect(result.agentResults.length).toBeGreaterThan(0);
      });

      it("completes normally when no signal is wired at all", async () => {
        const { runtime } = buildRuntime(pattern);

        const result = await runtime.execute("do the thing");
        expect(result.content).toBeTypeOf("string");
      });
    });
  }
});
