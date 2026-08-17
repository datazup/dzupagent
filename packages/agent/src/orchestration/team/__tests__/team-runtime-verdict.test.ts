/**
 * Runtime behavior tests for the governance and evaluation acceptance gates.
 *
 * Verifies that `governance.minScore` / `governance.requireUnanimous` and
 * `evaluation.minPassScore` are enforced when a scorer service is injected,
 * and are inert no-ops when no scorer is wired.
 */
import { describe, expect, it, vi } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { DzupAgent } from "../../../agent/dzip-agent.js";
import { TeamRuntime } from "../team-runtime.js";
import type {
  TeamEvaluationService,
  TeamGovernanceService,
  TeamRuntimeEvent,
} from "../team-runtime.js";
import type {
  ParticipantDefinition,
  TeamDefinition,
} from "../team-definition.js";
import type { CoordinatorPattern } from "../team-definition.js";
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

function buildDefinition(
  id: string,
  pattern: CoordinatorPattern,
  participants: Array<Pick<ParticipantDefinition, "id" | "role" | "model">>
): TeamDefinition {
  return {
    id,
    name: id,
    coordinatorPattern: pattern,
    // `model` is required by the parameter type and supplied by every call
    // site, so the previous `{ model: "mock", ...p }` default was always
    // overwritten.
    participants: participants.map((p) => ({ ...p })),
  };
}

function makeRuntime(
  definition: TeamDefinition,
  options: {
    policies: TeamRuntime["policy"];
    governance?: TeamGovernanceService;
    evaluation?: TeamEvaluationService;
    onEvent?: (event: TeamRuntimeEvent) => void;
  }
): TeamRuntime {
  const agents = new Map(
    definition.participants.map((p) => [p.id, createAgent(p.id)])
  );
  return new TeamRuntime({
    definition,
    policies: options.policies,
    ...(options.governance ? { governance: options.governance } : {}),
    ...(options.evaluation ? { evaluation: options.evaluation } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    generateRunId: () => "run-verdict",
    resolveParticipant: async (participant): Promise<TeamSpawnedAgent> => ({
      agent: agents.get(participant.id)!,
      status: "idle",
      role: participant.role as TeamSpawnedAgent["role"],
      tags: [],
      spawnedAt: Date.now(),
    }),
  });
}

describe("TeamRuntime governance acceptance gate", () => {
  const councilDefinition = () =>
    buildDefinition("council-governance", "council", [
      { id: "judge", role: "judge", model: "claude-opus-4-7" },
      { id: "p1", role: "worker", model: "mock" },
    ]);

  it("passes the run and emits a passed verdict when score >= minScore", async () => {
    const events: TeamRuntimeEvent[] = [];
    const governance: TeamGovernanceService = {
      evaluate: vi.fn(async () => ({ score: 0.9 })),
    };
    const runtime = makeRuntime(councilDefinition(), {
      policies: {
        governance: { judgeModel: "claude-opus-4-7", minScore: 0.8 },
      },
      governance,
      onEvent: (e) => events.push(e),
    });

    const result = await runtime.execute("task");

    expect(result.pattern).toBe("council");
    expect(governance.evaluate).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "team_verdict_evaluated",
        gate: "governance",
        outcome: "passed",
        score: 0.9,
      })
    );
    expect(events.some((e) => e.type === "team_completed")).toBe(true);
    expect(events.some((e) => e.type === "team_failed")).toBe(false);
  });

  it("rejects the run when score < minScore and emits team_failed, not team_completed", async () => {
    const events: TeamRuntimeEvent[] = [];
    const governance: TeamGovernanceService = {
      evaluate: vi.fn(async () => ({ score: 0.4 })),
    };
    const runtime = makeRuntime(councilDefinition(), {
      policies: {
        governance: { judgeModel: "claude-opus-4-7", minScore: 0.8 },
      },
      governance,
      onEvent: (e) => events.push(e),
    });

    await expect(runtime.execute("task")).rejects.toThrow(
      /governance\.minScore/
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "team_verdict_evaluated",
        gate: "governance",
        outcome: "rejected",
      })
    );
    expect(events.some((e) => e.type === "team_failed")).toBe(true);
    expect(events.some((e) => e.type === "team_completed")).toBe(false);
  });

  it("rejects when requireUnanimous is set but the verdict is not unanimous", async () => {
    const governance: TeamGovernanceService = {
      evaluate: vi.fn(async () => ({ score: 1, unanimous: false })),
    };
    const runtime = makeRuntime(councilDefinition(), {
      policies: {
        governance: { judgeModel: "claude-opus-4-7", requireUnanimous: true },
      },
      governance,
    });

    await expect(runtime.execute("task")).rejects.toThrow(/requireUnanimous/);
  });

  it("passes when requireUnanimous is set and the verdict is unanimous", async () => {
    const governance: TeamGovernanceService = {
      evaluate: vi.fn(async () => ({ score: 1, unanimous: true })),
    };
    const runtime = makeRuntime(councilDefinition(), {
      policies: {
        governance: { judgeModel: "claude-opus-4-7", requireUnanimous: true },
      },
      governance,
    });

    await expect(runtime.execute("task")).resolves.toMatchObject({
      pattern: "council",
    });
  });

  it("passes the run but reports a skipped verdict when the threshold is declared and no governance service is wired", async () => {
    const events: TeamRuntimeEvent[] = [];
    const runtime = makeRuntime(councilDefinition(), {
      policies: {
        governance: { judgeModel: "claude-opus-4-7", minScore: 0.99 },
      },
      onEvent: (e) => events.push(e),
    });

    // The run outcome is deliberately unchanged: an unwired gate does not
    // fail the run, it just cannot vouch for it.
    await expect(runtime.execute("task")).resolves.toMatchObject({
      pattern: "council",
    });
    expect(events.some((e) => e.type === "team_completed")).toBe(true);

    // ...but the ungated pass must be distinguishable from a real pass.
    const verdicts = events.filter((e) => e.type === "team_verdict_evaluated");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      gate: "governance",
      outcome: "skipped",
    });
    // No fabricated score: nothing scored this run.
    expect((verdicts[0] as { score?: number }).score).toBeUndefined();
  });

  it("reports a skipped verdict when only requireUnanimous is declared and no service is wired", async () => {
    const events: TeamRuntimeEvent[] = [];
    const runtime = makeRuntime(councilDefinition(), {
      policies: {
        governance: { judgeModel: "claude-opus-4-7", requireUnanimous: true },
      },
      onEvent: (e) => events.push(e),
    });

    await runtime.execute("task");
    expect(
      events.filter((e) => e.type === "team_verdict_evaluated")
    ).toMatchObject([{ gate: "governance", outcome: "skipped" }]);
  });

  it("distinguishes a scorer that declined to judge from an unwired gate", async () => {
    // The two skip causes need different responses: unwired is a static wiring
    // mistake, scorer_failed is a live outage during which every run passes a
    // gate someone is relying on. Reported under one label, the alert for the
    // outage is muted by the noise of the misconfiguration.
    const events: TeamRuntimeEvent[] = [];
    const governance: TeamGovernanceService = {
      evaluate: vi.fn(async () => ({
        score: 1,
        unanimous: true,
        notScored: true,
      })),
    };
    const runtime = makeRuntime(councilDefinition(), {
      policies: {
        governance: { judgeModel: "claude-opus-4-7", minScore: 0.99 },
      },
      governance,
      onEvent: (e) => events.push(e),
    });

    // Still ungated — a broken judge must not fail good runs.
    await expect(runtime.execute("task")).resolves.toMatchObject({
      pattern: "council",
    });

    const verdicts = events.filter((e) => e.type === "team_verdict_evaluated");
    expect(verdicts).toMatchObject([
      { gate: "governance", outcome: "skipped", reason: "scorer_failed" },
    ]);
    // The abstention must NOT be reported as a pass, even though score is 1.
    expect(verdicts[0]).not.toMatchObject({ outcome: "passed" });
  });

  it("labels an unwired governance gate unwired, not scorer_failed", async () => {
    const events: TeamRuntimeEvent[] = [];
    const runtime = makeRuntime(councilDefinition(), {
      policies: {
        governance: { judgeModel: "claude-opus-4-7", minScore: 0.99 },
      },
      onEvent: (e) => events.push(e),
    });

    await runtime.execute("task");
    expect(
      events.filter((e) => e.type === "team_verdict_evaluated")
    ).toMatchObject([{ outcome: "skipped", reason: "unwired" }]);
  });

  it("does not let notScored bypass a gate the scorer actually failed", async () => {
    // notScored is an abstention, not an override: a scorer returning a REAL
    // low score must still reject. Otherwise any scorer could silently disable
    // the gate by always abstaining.
    const governance: TeamGovernanceService = {
      evaluate: vi.fn(async () => ({ score: 0.1, notScored: false })),
    };
    const runtime = makeRuntime(councilDefinition(), {
      policies: {
        governance: { judgeModel: "claude-opus-4-7", minScore: 0.8 },
      },
      governance,
    });

    await expect(runtime.execute("task")).rejects.toThrow(
      /governance\.minScore/
    );
  });

  it("does not invoke the scorer when only judgeModel is set (no thresholds)", async () => {
    const governance: TeamGovernanceService = {
      evaluate: vi.fn(async () => ({ score: 0 })),
    };
    const runtime = makeRuntime(councilDefinition(), {
      policies: { governance: { judgeModel: "claude-opus-4-7" } },
      governance,
    });

    await runtime.execute("task");
    expect(governance.evaluate).not.toHaveBeenCalled();
  });
});

describe("TeamRuntime evaluation acceptance gate", () => {
  const peerDefinition = () =>
    buildDefinition("peer-evaluation", "peer_to_peer", [
      { id: "p1", role: "worker", model: "mock" },
    ]);

  it("passes and emits a passed verdict when score >= minPassScore on any pattern", async () => {
    const events: TeamRuntimeEvent[] = [];
    const evaluation: TeamEvaluationService = {
      score: vi.fn(async () => ({ score: 0.75 })),
    };
    const runtime = makeRuntime(peerDefinition(), {
      policies: {
        evaluation: { scorerModel: "claude-opus-4-7", minPassScore: 0.7 },
      },
      evaluation,
      onEvent: (e) => events.push(e),
    });

    await runtime.execute("task");

    expect(evaluation.score).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "team_verdict_evaluated",
        gate: "evaluation",
        outcome: "passed",
        score: 0.75,
      })
    );
  });

  it("rejects the run when score < minPassScore", async () => {
    const evaluation: TeamEvaluationService = {
      score: vi.fn(async () => ({ score: 0.3 })),
    };
    const runtime = makeRuntime(peerDefinition(), {
      policies: {
        evaluation: { scorerModel: "claude-opus-4-7", minPassScore: 0.7 },
      },
      evaluation,
    });

    await expect(runtime.execute("task")).rejects.toThrow(
      /evaluation\.minPassScore/
    );
  });

  it("passes the run but reports a skipped verdict when minPassScore is declared and no evaluation service is wired", async () => {
    const events: TeamRuntimeEvent[] = [];
    const runtime = makeRuntime(peerDefinition(), {
      policies: {
        evaluation: { scorerModel: "claude-opus-4-7", minPassScore: 0.99 },
      },
      onEvent: (e) => events.push(e),
    });

    await expect(runtime.execute("task")).resolves.toMatchObject({
      pattern: "peer-to-peer",
    });
    expect(
      events.filter((e) => e.type === "team_verdict_evaluated")
    ).toMatchObject([{ gate: "evaluation", outcome: "skipped" }]);
  });

  it("reports scorer_failed on the evaluation gate when the scorer abstains", async () => {
    const events: TeamRuntimeEvent[] = [];
    const evaluation: TeamEvaluationService = {
      score: vi.fn(async () => ({ score: 1, notScored: true })),
    };
    const runtime = makeRuntime(peerDefinition(), {
      policies: {
        evaluation: { scorerModel: "claude-opus-4-7", minPassScore: 0.99 },
      },
      evaluation,
      onEvent: (e) => events.push(e),
    });

    await expect(runtime.execute("task")).resolves.toMatchObject({
      pattern: "peer-to-peer",
    });
    expect(
      events.filter((e) => e.type === "team_verdict_evaluated")
    ).toMatchObject([
      { gate: "evaluation", outcome: "skipped", reason: "scorer_failed" },
    ]);
  });

  it("does not invoke the scorer when only scorerModel is set (no threshold)", async () => {
    const evaluation: TeamEvaluationService = {
      score: vi.fn(async () => ({ score: 0 })),
    };
    const runtime = makeRuntime(peerDefinition(), {
      policies: { evaluation: { scorerModel: "claude-opus-4-7" } },
      evaluation,
    });

    await runtime.execute("task");
    expect(evaluation.score).not.toHaveBeenCalled();
  });

  it("emits no skipped verdict when no threshold is declared at all", async () => {
    // The skipped signal must mean "a declared gate could not run", not
    // "this run had no gate". Firing it on ungated teams would make the
    // metric useless — every run in the fleet would report a skip.
    const events: TeamRuntimeEvent[] = [];
    const runtime = makeRuntime(peerDefinition(), {
      policies: { evaluation: { scorerModel: "claude-opus-4-7" } },
      onEvent: (e) => events.push(e),
    });

    await runtime.execute("task");
    expect(events.some((e) => e.type === "team_verdict_evaluated")).toBe(false);
  });

  it("keeps run scores out of serialized event metadata leakage risk (numeric only)", async () => {
    const events: TeamRuntimeEvent[] = [];
    const evaluation: TeamEvaluationService = {
      score: vi.fn(async () => ({ score: 0.9 })),
    };
    const runtime = makeRuntime(peerDefinition(), {
      policies: {
        evaluation: { scorerModel: "secret-model-name", minPassScore: 0.1 },
      },
      evaluation,
      onEvent: (e) => events.push(e),
    });

    await runtime.execute("task");
    expect(JSON.stringify(events)).not.toContain("secret-model-name");
  });
});
