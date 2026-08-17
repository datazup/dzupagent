/**
 * Contract tests for the resume dimensions of `planResume`.
 *
 * These lock in the boundary documented on `TeamCheckpoint` / `ResumeContract`:
 * resume narrows work along the **participant** dimension only. The **phase**
 * dimension (`checkpoint.phase`, `contract.resumeFromPhase`) is scoped out of
 * in-repo enforcement because TeamRuntime phases are emitted markers around one
 * indivisible `pattern.execute()` call, not a driveable state machine.
 *
 * The phase-invariance tests below are deliberately *negative*: they assert the
 * phase fields have no effect, so that if someone later wires a real
 * phase-driven dispatcher these fail loudly and the scoped-out docs get
 * revisited rather than silently rotting.
 */
import { describe, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { DzupAgent } from "../../../agent/dzip-agent.js";
import { TeamRuntime } from "../team-runtime.js";
import { planResume } from "../team-runtime-resume.js";
import type { TeamCheckpoint, ResumeContract } from "../team-checkpoint.js";
import type { TeamPhase } from "../team-phase.js";
import type {
  ParticipantDefinition,
  TeamDefinition,
} from "../team-definition.js";
import type { TeamSpawnedAgent } from "../team-workspace.js";

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

function buildDefinition(id: string, participantIds: string[]): TeamDefinition {
  return {
    id,
    name: id,
    coordinatorPattern: "peer_to_peer",
    participants: participantIds.map((pid) => ({
      id: pid,
      role: "worker",
      model: "mock",
    })) as ParticipantDefinition[],
  };
}

function makeRuntime(
  definition: TeamDefinition,
  agentsById: Map<string, DzupAgent>
): TeamRuntime {
  return new TeamRuntime({
    definition,
    resolveParticipant: async (participant): Promise<TeamSpawnedAgent> => ({
      agent: agentsById.get(participant.id)!,
      status: "idle",
      role: participant.role as TeamSpawnedAgent["role"],
      tags: [],
      spawnedAt: Date.now(),
    }),
  });
}

function makeCheckpoint(
  teamId: string,
  phase: TeamPhase,
  completed: string[],
  pending: string[],
  sharedContext: Record<string, unknown> = {}
): TeamCheckpoint {
  return {
    teamId,
    runId: "run-1",
    phase,
    completedParticipantIds: completed,
    pendingParticipantIds: pending,
    sharedContext,
    checkpointedAt: new Date(),
  };
}

function makeContract(
  resumeFromPhase: TeamPhase,
  skipCompletedParticipants: boolean
): ResumeContract {
  return {
    checkpointId: "ck-1",
    resumeFromPhase,
    skipCompletedParticipants,
  };
}

/** Every phase in the `TeamPhase` union. */
const ALL_PHASES: TeamPhase[] = [
  "initializing",
  "planning",
  "executing",
  "evaluating",
  "completing",
  "failed",
];

describe("planResume — participant dimension", () => {
  it("narrows to pending participants when skipCompletedParticipants=true", () => {
    const def = buildDefinition("team-p", ["done", "pending"]);
    const plan = planResume(
      def,
      makeCheckpoint("team-p", "executing", ["done"], ["pending"]),
      makeContract("executing", true),
      "task"
    );

    expect(plan.workingParticipants.map((p) => p.id)).toEqual(["pending"]);
  });

  it("keeps all participants when skipCompletedParticipants=false", () => {
    const def = buildDefinition("team-p", ["done", "pending"]);
    const plan = planResume(
      def,
      makeCheckpoint("team-p", "executing", ["done"], ["pending"]),
      makeContract("executing", false),
      "task"
    );

    expect(plan.workingParticipants.map((p) => p.id)).toEqual([
      "done",
      "pending",
    ]);
  });

  it("appends serialized shared context to the resume task", () => {
    const def = buildDefinition("team-p", ["p1"]);
    const plan = planResume(
      def,
      makeCheckpoint("team-p", "executing", [], ["p1"], { note: "carried" }),
      makeContract("executing", true),
      "original task"
    );

    expect(plan.resumeTask).toContain("original task");
    expect(plan.resumeTask).toContain("Resumed shared context");
    expect(plan.resumeTask).toContain("carried");
  });

  it("leaves the task untouched when shared context is empty", () => {
    const def = buildDefinition("team-p", ["p1"]);
    const plan = planResume(
      def,
      makeCheckpoint("team-p", "executing", [], ["p1"]),
      makeContract("executing", true),
      "original task"
    );

    expect(plan.resumeTask).toBe("original task");
  });

  it("still throws when the checkpoint belongs to another team", () => {
    const def = buildDefinition("team-A", ["p1"]);

    expect(() =>
      planResume(
        def,
        makeCheckpoint("team-B", "executing", [], ["p1"]),
        makeContract("executing", true),
        "task"
      )
    ).toThrow("checkpoint belongs to team 'team-B', not 'team-A'");
  });
});

describe("planResume — phase dimension is scoped out", () => {
  it("produces an identical plan for every resumeFromPhase value", () => {
    const def = buildDefinition("team-phase", ["done", "pending"]);
    const checkpoint = makeCheckpoint(
      "team-phase",
      "executing",
      ["done"],
      ["pending"]
    );

    const plans = ALL_PHASES.map((phase) =>
      planResume(def, checkpoint, makeContract(phase, true), "task")
    );

    for (const plan of plans) {
      expect(plan.workingParticipants.map((p) => p.id)).toEqual(["pending"]);
      expect(plan.resumeTask).toBe(plans[0]!.resumeTask);
    }
  });

  it("produces an identical plan for every checkpoint.phase value", () => {
    const def = buildDefinition("team-phase", ["done", "pending"]);

    const plans = ALL_PHASES.map((phase) =>
      planResume(
        def,
        makeCheckpoint("team-phase", phase, ["done"], ["pending"]),
        makeContract("executing", true),
        "task"
      )
    );

    for (const plan of plans) {
      expect(plan.workingParticipants.map((p) => p.id)).toEqual(["pending"]);
      expect(plan.resumeTask).toBe(plans[0]!.resumeTask);
    }
  });

  it("does not reject a resumeFromPhase that precedes the checkpointed phase", () => {
    const def = buildDefinition("team-phase", ["p1"]);

    expect(() =>
      planResume(
        def,
        makeCheckpoint("team-phase", "completing", [], ["p1"]),
        makeContract("initializing", true),
        "task"
      )
    ).not.toThrow();
  });

  it("does not reject a resumeFromPhase that follows the checkpointed phase", () => {
    const def = buildDefinition("team-phase", ["p1"]);

    expect(() =>
      planResume(
        def,
        makeCheckpoint("team-phase", "initializing", [], ["p1"]),
        makeContract("completing", true),
        "task"
      )
    ).not.toThrow();
  });

  it("does not consult checkpointId, so a contract naming any record is accepted", () => {
    const def = buildDefinition("team-phase", ["p1"]);
    const contract: ResumeContract = {
      checkpointId: "some-unrelated-record-id",
      resumeFromPhase: "executing",
      skipCompletedParticipants: true,
    };

    expect(() =>
      planResume(
        def,
        makeCheckpoint("team-phase", "executing", [], ["p1"]),
        contract,
        "task"
      )
    ).not.toThrow();
  });
});

describe("TeamRuntime.resume — phase/participant composition", () => {
  it("runs the same participants regardless of resumeFromPhase", async () => {
    for (const phase of ALL_PHASES) {
      const def = buildDefinition("team-run", ["done", "pending"]);
      const runtime = makeRuntime(
        def,
        new Map([
          ["done", createAgent("done")],
          ["pending", createAgent("pending")],
        ])
      );

      const result = await runtime.resume(
        makeCheckpoint("team-run", "executing", ["done"], ["pending"]),
        makeContract(phase, true),
        "task"
      );

      expect(result.agentResults.map((r) => r.agentId)).toEqual(["pending"]);
    }
  });

  it("re-runs every participant when skipCompletedParticipants=false, at any phase", async () => {
    const def = buildDefinition("team-run", ["done", "pending"]);
    const runtime = makeRuntime(
      def,
      new Map([
        ["done", createAgent("done")],
        ["pending", createAgent("pending")],
      ])
    );

    const result = await runtime.resume(
      makeCheckpoint("team-run", "completing", ["done"], ["pending"]),
      makeContract("completing", false),
      "task"
    );

    expect(result.agentResults.map((r) => r.agentId)).toEqual([
      "done",
      "pending",
    ]);
  });

  it("returns the empty result when no participants remain, whatever the phase", async () => {
    const def = buildDefinition("team-run", ["p1"]);
    const runtime = makeRuntime(def, new Map([["p1", createAgent("p1")]]));

    const result = await runtime.resume(
      makeCheckpoint("team-run", "initializing", ["p1"], []),
      makeContract("initializing", true),
      "task"
    );

    expect(result.agentResults).toHaveLength(0);
    expect(result.content).toBe("");
    expect(result.durationMs).toBe(0);
  });

  it("restores the full participant list after a narrowed resume", async () => {
    const def = buildDefinition("team-run", ["done", "pending"]);
    const runtime = makeRuntime(
      def,
      new Map([
        ["done", createAgent("done")],
        ["pending", createAgent("pending")],
      ])
    );

    await runtime.resume(
      makeCheckpoint("team-run", "executing", ["done"], ["pending"]),
      makeContract("executing", true),
      "task"
    );

    expect(def.participants.map((p) => p.id)).toEqual(["done", "pending"]);
  });
});
