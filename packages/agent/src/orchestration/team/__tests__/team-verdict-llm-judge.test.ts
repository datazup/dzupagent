/**
 * Tests for the LLM-backed verdict service.
 *
 * The scoring path is thin; the interesting surface is what happens when the
 * judge — an unreliable remote dependency — fails. The central contract is that
 * a broken judge NEVER silently becomes a score of 0, because that would turn
 * an infrastructure outage into a unanimous rejection of every run.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createLlmJudgeVerdictService,
  TeamJudgeUnavailableError,
} from "../team-verdict-llm-judge.js";
import type { TeamVerdictInput } from "../team-runtime-verdict.js";
import type { TeamPolicies } from "../team-policy.js";

function input(overrides: Partial<TeamVerdictInput> = {}): TeamVerdictInput {
  return {
    teamId: "team-a",
    runId: "run-1",
    task: "summarise the incident",
    result: {
      content: "a summary",
      agentResults: [],
      durationMs: 1,
      pattern: "council",
    },
    policies: {} as TeamPolicies,
    ...overrides,
  } as TeamVerdictInput;
}

describe("createLlmJudgeVerdictService — construction", () => {
  it("rejects an unknown failure policy", () => {
    expect(() =>
      createLlmJudgeVerdictService({
        judge: async () => "{}",
        onJudgeFailure: "ignore" as never,
      })
    ).toThrow(/'onJudgeFailure' must be/);
  });
});

describe("createLlmJudgeVerdictService — scoring", () => {
  it("returns the judge's score and unanimity", async () => {
    const service = createLlmJudgeVerdictService({
      judge: async () => '{"score": 0.75, "unanimous": true}',
      onJudgeFailure: "reject",
    });

    await expect(service.score(input())).resolves.toEqual({
      score: 0.75,
      unanimous: true,
    });
  });

  it("wires the same verdict into both gate seams", async () => {
    const service = createLlmJudgeVerdictService({
      judge: async () => '{"score": 0.5}',
      onJudgeFailure: "reject",
    });

    // One instance must satisfy governance and evaluation alike, so a host can
    // gate both groups without constructing two judges.
    await expect(service.evaluate(input())).resolves.toEqual({
      score: 0.5,
      unanimous: false,
    });
    await expect(service.score(input())).resolves.toEqual({
      score: 0.5,
      unanimous: false,
    });
  });

  it("extracts JSON wrapped in prose or a code fence", async () => {
    const service = createLlmJudgeVerdictService({
      judge: async () =>
        'Here is my verdict:\n```json\n{"score": 0.9, "unanimous": true}\n```\nHope that helps!',
      onJudgeFailure: "reject",
    });

    // Judges routinely wrap JSON in prose; a bare JSON.parse would reject an
    // otherwise-valid verdict and trip the failure policy.
    await expect(service.score(input())).resolves.toEqual({
      score: 0.9,
      unanimous: true,
    });
  });

  it("handles a nested object without truncating at the first brace", async () => {
    const service = createLlmJudgeVerdictService({
      judge: async () => '{"detail": {"a": 1}, "score": 0.4}',
      onJudgeFailure: "reject",
    });

    await expect(service.score(input())).resolves.toMatchObject({ score: 0.4 });
  });

  it("does not treat a brace inside a string as structure", async () => {
    const service = createLlmJudgeVerdictService({
      judge: async () => '{"note": "a } brace", "score": 0.3}',
      onJudgeFailure: "reject",
    });

    await expect(service.score(input())).resolves.toMatchObject({ score: 0.3 });
  });

  it("clamps an out-of-range score into [0, 1]", async () => {
    const high = createLlmJudgeVerdictService({
      judge: async () => '{"score": 1.4}',
      onJudgeFailure: "reject",
    });
    const low = createLlmJudgeVerdictService({
      judge: async () => '{"score": -2}',
      onJudgeFailure: "reject",
    });

    // A model returning 1.4 still means "excellent"; the threshold comparison
    // just needs a bounded number.
    await expect(high.score(input())).resolves.toMatchObject({ score: 1 });
    await expect(low.score(input())).resolves.toMatchObject({ score: 0 });
  });

  it("treats a missing unanimous flag as not unanimous", async () => {
    const service = createLlmJudgeVerdictService({
      judge: async () => '{"score": 1}',
      onJudgeFailure: "reject",
    });

    // requireUnanimous is a strict gate: absence must not read as consent.
    await expect(service.score(input())).resolves.toEqual({
      score: 1,
      unanimous: false,
    });
  });
});

describe("createLlmJudgeVerdictService — prompt construction", () => {
  it("uses the policy's scoringCriteria", async () => {
    const judge = vi.fn(async () => '{"score": 1}');
    const service = createLlmJudgeVerdictService({
      judge,
      onJudgeFailure: "reject",
      defaultCriteria: ["fallback criterion"],
    });

    await service.score(
      input({
        policies: {
          evaluation: {
            scorerModel: "m",
            scoringCriteria: ["must cite sources"],
          },
        } as TeamPolicies,
      })
    );

    const prompt = judge.mock.calls[0]![0] as string;
    expect(prompt).toContain("must cite sources");
    // The declared criteria win outright — a stale default must not leak in
    // alongside them.
    expect(prompt).not.toContain("fallback criterion");
  });

  it("falls back to defaultCriteria when the policy declares none", async () => {
    const judge = vi.fn(async () => '{"score": 1}');
    const service = createLlmJudgeVerdictService({
      judge,
      onJudgeFailure: "reject",
      defaultCriteria: ["fallback criterion"],
    });

    await service.score(input());

    expect(judge.mock.calls[0]![0]).toContain("fallback criterion");
  });

  it("includes the task and the run's output", async () => {
    const judge = vi.fn(async () => '{"score": 1}');
    const service = createLlmJudgeVerdictService({
      judge,
      onJudgeFailure: "reject",
    });

    await service.score(input());

    const prompt = judge.mock.calls[0]![0] as string;
    expect(prompt).toContain("summarise the incident");
    // Guards the field name: `result.content` is the merged output. Reading a
    // non-existent field would silently judge "undefined" on every run.
    expect(prompt).toContain("a summary");
  });

  it("marks an empty output rather than judging an empty string", async () => {
    const judge = vi.fn(async () => '{"score": 1}');
    const service = createLlmJudgeVerdictService({
      judge,
      onJudgeFailure: "reject",
    });

    await service.score(
      input({
        result: {
          content: "",
          agentResults: [],
          durationMs: 1,
          pattern: "council",
        },
      } as Partial<TeamVerdictInput>)
    );

    expect(judge.mock.calls[0]![0]).toContain("(no output produced)");
  });
});

describe("createLlmJudgeVerdictService — judge failure policy", () => {
  const brokenJudges: Array<[string, () => Promise<string>]> = [
    [
      "throws",
      async () => {
        throw new Error("rate limited");
      },
    ],
    ["returns prose", async () => "I think it was pretty good, honestly."],
    ["returns invalid JSON", async () => "{score: 0.5"],
    ["returns a non-numeric score", async () => '{"score": "high"}'],
    ["returns NaN", async () => '{"score": null}'],
    ["returns an array", async () => "[0.5]"],
  ];

  it.each(brokenJudges)(
    "does not gate the run when the judge %s and policy is 'skip'",
    async (_label, judge) => {
      const service = createLlmJudgeVerdictService({
        judge,
        onJudgeFailure: "skip",
      });

      // A pass-through, NOT a judgement of 1.0 — it is the only encoding of
      // "do not gate this run" the TeamVerdict contract allows. Scoring 0 here
      // would reject every run during an outage.
      //
      // notScored is what keeps that pass-through honest: without it the gate
      // counts this as a real unanimous pass and an outage becomes invisible.
      await expect(service.score(input())).resolves.toEqual({
        score: 1,
        unanimous: true,
        notScored: true,
      });
    }
  );

  it.each(brokenJudges)(
    "raises TeamJudgeUnavailableError when the judge %s and policy is 'reject'",
    async (_label, judge) => {
      const service = createLlmJudgeVerdictService({
        judge,
        onJudgeFailure: "reject",
      });

      // A distinct error type, never a fabricated 0.0 score: a host must be
      // able to tell "the judge says this is bad" from "the judge is broken".
      await expect(service.score(input())).rejects.toBeInstanceOf(
        TeamJudgeUnavailableError
      );
    }
  );

  it("preserves the underlying cause on the raised error", async () => {
    const cause = new Error("rate limited");
    const service = createLlmJudgeVerdictService({
      judge: async () => {
        throw cause;
      },
      onJudgeFailure: "reject",
    });

    await expect(service.score(input())).rejects.toMatchObject({
      name: "TeamJudgeUnavailableError",
      cause,
    });
  });

  it("does not mark a successful verdict as notScored", async () => {
    // The flag must mean "could not judge", not "judged". If a working judge
    // set it, every gate would silently stop enforcing — a far worse failure
    // than the one notScored exists to fix.
    const service = createLlmJudgeVerdictService({
      judge: async () => JSON.stringify({ score: 0.42, unanimous: false }),
      onJudgeFailure: "skip",
    });

    const verdict = await service.score(input());
    expect(verdict).toEqual({ score: 0.42, unanimous: false });
    expect(verdict.notScored).toBeUndefined();
  });

  it("never reports a score of 0 for a broken judge", async () => {
    const service = createLlmJudgeVerdictService({
      judge: async () => "unparseable",
      onJudgeFailure: "skip",
    });

    // The single most important property of this module: 0 means "the judge
    // scored this badly", and a broken judge must never be able to say that.
    const verdict = await service.score(input());
    expect(verdict.score).not.toBe(0);
  });
});
