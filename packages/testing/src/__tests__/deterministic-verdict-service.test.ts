/**
 * Tests for the deterministic verdict service.
 *
 * The behaviour that matters most here is the empty-run case: a run with no
 * participant results must score 0, not 1. Scoring it 1 would let a team that
 * executed nothing clear a `minScore: 1.0` bar, which is the same silent-pass
 * failure the verdict seam exists to prevent.
 */
import { describe, expect, it } from "vitest";
import type { TeamVerdictInput } from "@dzupagent/agent/orchestration";
import { createDeterministicVerdictService } from "../deterministic-verdict-service.js";

function inputWith(successes: boolean[]): TeamVerdictInput {
  return {
    teamId: "team-1",
    runId: "run-1",
    task: "task",
    policies: {},
    result: {
      content: "out",
      durationMs: 1,
      pattern: "peer-to-peer",
      agentResults: successes.map((success, i) => ({
        agentId: `a${i}`,
        role: "worker",
        content: "c",
        success,
        durationMs: 1,
      })),
    },
  } as unknown as TeamVerdictInput;
}

describe("createDeterministicVerdictService", () => {
  it("scores the fraction of participants that succeeded", async () => {
    const svc = createDeterministicVerdictService();
    const verdict = await svc.score(inputWith([true, true, false, false]));
    expect(verdict.score).toBe(0.5);
  });

  it("scores 1 and reports unanimous when every participant succeeded", async () => {
    const svc = createDeterministicVerdictService();
    const verdict = await svc.evaluate(inputWith([true, true]));
    expect(verdict.score).toBe(1);
    expect(verdict.unanimous).toBe(true);
  });

  it("is not unanimous when any participant failed", async () => {
    const svc = createDeterministicVerdictService();
    const verdict = await svc.evaluate(inputWith([true, false]));
    expect(verdict.unanimous).toBe(false);
  });

  it("scores an empty run 0, not 1, so a run that did nothing clears no bar", async () => {
    const svc = createDeterministicVerdictService();
    const verdict = await svc.evaluate(inputWith([]));
    expect(verdict.score).toBe(0);
    expect(verdict.unanimous).toBe(false);
  });

  it("honours a pinned score over the computed one", async () => {
    const svc = createDeterministicVerdictService({ score: 0.25 });
    // Participants all succeeded, so the computed score would be 1.
    const verdict = await svc.score(inputWith([true, true]));
    expect(verdict.score).toBe(0.25);
  });

  it("honours a pinned unanimity verdict over the computed one", async () => {
    const svc = createDeterministicVerdictService({ unanimous: false });
    const verdict = await svc.evaluate(inputWith([true, true]));
    expect(verdict.unanimous).toBe(false);
  });

  it("rejects an out-of-range pinned score", () => {
    expect(() => createDeterministicVerdictService({ score: 1.5 })).toThrow(
      /must be a number in \[0, 1\]/
    );
    expect(() => createDeterministicVerdictService({ score: -1 })).toThrow(
      /must be a number in \[0, 1\]/
    );
  });

  it("serves both verdict seams from one instance", async () => {
    const svc = createDeterministicVerdictService();
    const input = inputWith([true, false]);
    await expect(svc.evaluate(input)).resolves.toMatchObject({ score: 0.5 });
    await expect(svc.score(input)).resolves.toMatchObject({ score: 0.5 });
  });
});
