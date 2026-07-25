import { describe, it, expect } from "vitest";
import {
  toAgentResults,
  applyGatherStep,
} from "../gather/fleet-gather-bridge.js";
import type { RepoAgentResult, TaskState } from "@dzupagent/agent-types/fleet";

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function repoResult(
  workerId: string,
  state: TaskState,
  overrides: Partial<RepoAgentResult> = {},
): RepoAgentResult {
  return {
    workerId,
    repo: "example-repo",
    taskId: `task-${workerId}`,
    state,
    events: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// toAgentResults — state mapping
// ---------------------------------------------------------------------------

describe("toAgentResults state mapping", () => {
  it("maps completed -> success", () => {
    const [result] = toAgentResults([
      repoResult("w1", "completed", { outcome: "done" }),
    ]);
    expect(result?.status).toBe("success");
    expect(result?.agentId).toBe("w1");
  });

  it("maps failed -> error", () => {
    const [result] = toAgentResults([repoResult("w1", "failed")]);
    expect(result?.status).toBe("error");
  });

  it("maps surrendered -> error (NOT timeout)", () => {
    const [result] = toAgentResults([repoResult("w1", "surrendered")]);
    expect(result?.status).toBe("error");
  });

  it("maps every non-completed TaskState member to error", () => {
    const nonCompleted: TaskState[] = [
      "queued",
      "claimed",
      "in-progress",
      "blocked",
      "failed",
      "surrendered",
    ];
    for (const state of nonCompleted) {
      const [result] = toAgentResults([repoResult("w1", state)]);
      expect(result?.status).toBe("error");
      expect(result?.error).toContain(state);
    }
  });
});

// ---------------------------------------------------------------------------
// toAgentResults — output derivation
// ---------------------------------------------------------------------------

describe("toAgentResults output", () => {
  it("passes outcome through as output when defined", () => {
    const [result] = toAgentResults([
      repoResult("w1", "completed", { outcome: { files: 3 } }),
    ]);
    expect(result?.output).toEqual({ files: 3 });
  });

  it("uses deriveOutput only when outcome is undefined", () => {
    const results = toAgentResults(
      [
        repoResult("w1", "completed", { outcome: "explicit" }),
        repoResult("w2", "completed"),
      ],
      { deriveOutput: (r) => `derived-${r.workerId}` },
    );
    expect(results[0]?.output).toBe("explicit");
    expect(results[1]?.output).toBe("derived-w2");
  });

  it("leaves output undefined when neither outcome nor deriveOutput exist", () => {
    const [result] = toAgentResults([repoResult("w1", "completed")]);
    expect(result?.output).toBeUndefined();
  });

  it("leaves output undefined when deriveOutput returns undefined", () => {
    const [result] = toAgentResults([repoResult("w1", "completed")], {
      deriveOutput: () => undefined,
    });
    expect(result?.output).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// toAgentResults — error messages
// ---------------------------------------------------------------------------

describe("toAgentResults error", () => {
  it("uses the default `worker '<id>' <state>` message on non-success", () => {
    const [result] = toAgentResults([repoResult("w9", "failed")]);
    expect(result?.error).toBe("worker 'w9' failed");
  });

  it("supports a deriveError override", () => {
    const [result] = toAgentResults([repoResult("w1", "surrendered")], {
      deriveError: (r) => `custom: ${r.taskId} gave up`,
    });
    expect(result?.error).toBe("custom: task-w1 gave up");
  });

  it("sets no error on successful results", () => {
    const [result] = toAgentResults([
      repoResult("w1", "completed", { outcome: "ok" }),
    ]);
    expect(result?.error).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// toAgentResults — order preservation
// ---------------------------------------------------------------------------

describe("toAgentResults ordering", () => {
  it("preserves input order", () => {
    const results = toAgentResults([
      repoResult("w3", "completed", { outcome: 3 }),
      repoResult("w1", "failed"),
      repoResult("w2", "completed", { outcome: 2 }),
    ]);
    expect(results.map((r) => r.agentId)).toEqual(["w3", "w1", "w2"]);
  });

  it("returns an empty array for empty input", () => {
    expect(toAgentResults([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// applyGatherStep
// ---------------------------------------------------------------------------

describe("applyGatherStep", () => {
  const outcomes = [
    repoResult("w1", "completed", { outcome: ["a1"] }),
    repoResult("w2", "completed", { outcome: ["a2", "a3"] }),
  ];

  it("defaults to the 'all' strategy when strategy is undefined", () => {
    const merged = applyGatherStep({}, toAgentResults(outcomes));
    expect(merged.status).toBe("success");
    // AllRequired returns the array of successful outputs.
    expect(merged.output).toEqual([["a1"], ["a2", "a3"]]);
  });

  it("applies 'concat' (flattened output)", () => {
    const merged = applyGatherStep(
      { strategy: "concat" },
      toAgentResults(outcomes),
    );
    expect(merged.status).toBe("success");
    expect(merged.output).toEqual(["a1", "a2", "a3"]);
  });

  it("applies 'first' (first success wins)", () => {
    const merged = applyGatherStep(
      { strategy: "first" },
      toAgentResults([
        repoResult("w1", "failed"),
        repoResult("w2", "completed", { outcome: "winner" }),
        repoResult("w3", "completed", { outcome: "later" }),
      ]),
    );
    // FirstWinsMergeStrategy reports "success" whenever any success exists.
    expect(merged.status).toBe("success");
    expect(merged.output).toBe("winner");
  });

  it("applies 'best' with a scoreBy option", () => {
    const merged = applyGatherStep(
      { strategy: "best" },
      toAgentResults([
        repoResult("w1", "completed", { outcome: { score: 0.2, id: "low" } }),
        repoResult("w2", "completed", { outcome: { score: 0.8, id: "high" } }),
      ]),
    );
    expect(merged.status).toBe("success");
    expect(merged.output).toEqual({ score: 0.8, id: "high" });
  });

  it("throws on unknown strategy names, listing the valid names", () => {
    expect(() =>
      applyGatherStep({ strategy: "vote" }, toAgentResults(outcomes)),
    ).toThrowError(/vote.*all, first, concat, best/);
  });

  it("handles empty results without crashing", () => {
    const merged = applyGatherStep({ strategy: "concat" }, []);
    expect(merged.agentResults).toEqual([]);
    expect(merged.successCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: RepoAgentResult[] -> toAgentResults(deriveOutput) -> concat
// ---------------------------------------------------------------------------

describe("fleet -> gather end-to-end", () => {
  it("derives outputs from events and gathers via concat", () => {
    const taskOutcomes: RepoAgentResult[] = [
      repoResult("w1", "completed", {
        events: [
          {
            kind: "message",
            text: JSON.stringify(["finding-1", "finding-2"]),
            role: "assistant",
            at: "2026-07-25T00:00:00.000Z",
          },
        ],
      }),
      repoResult("w2", "failed"),
      repoResult("w3", "completed", {
        events: [
          {
            kind: "message",
            text: JSON.stringify(["finding-3"]),
            role: "assistant",
            at: "2026-07-25T00:00:01.000Z",
          },
        ],
      }),
    ];

    const agentResults = toAgentResults(taskOutcomes, {
      deriveOutput: (result) => {
        const message = result.events.find((e) => e.kind === "message");
        return message && message.kind === "message"
          ? (JSON.parse(message.text) as string[])
          : undefined;
      },
    });

    const merged = applyGatherStep({ strategy: "concat" }, agentResults);
    expect(merged.status).toBe("partial");
    expect(merged.output).toEqual(["finding-1", "finding-2", "finding-3"]);
    expect(merged.successCount).toBe(2);
    expect(merged.errorCount).toBe(1);
  });
});
