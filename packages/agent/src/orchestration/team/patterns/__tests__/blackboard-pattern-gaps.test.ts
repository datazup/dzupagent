/**
 * Gap-filling tests for the blackboard coordination pattern.
 * Covers paths not exercised by blackboard-pattern.test.ts.
 */
import { describe, expect, it } from "vitest";
import { blackboardPattern } from "../blackboard-pattern.js";
import { buildContext, buildResolved } from "./test-helpers.js";

describe("blackboardPattern — gap coverage", () => {
  describe("single participant", () => {
    it("runs with a single specialist and returns its contribution", async () => {
      const { ctx } = buildContext("blackboard", [
        buildResolved("solo", { role: "specialist", response: "solo-output" }),
      ]);
      const result = await blackboardPattern.execute(ctx);
      expect(result.pattern).toBe("blackboard");
      expect(result.agentResults).toHaveLength(1);
      expect(result.agentResults[0]!.success).toBe(true);
      expect(result.content).toContain("solo-output");
    });
  });

  describe("compact overflow behavior (default)", () => {
    it("compacts oversized entry instead of failing when overflowBehavior is 'compact'", async () => {
      const longResponse = "A".repeat(200);
      const { ctx } = buildContext(
        "blackboard",
        [buildResolved("a1", { response: longResponse })],
        {
          policies: {
            memory: {
              tier: "ephemeral",
              shareAcrossParticipants: true,
              blackboardContext: {
                maxEntryChars: 50,
                overflowBehavior: "compact",
              },
            },
          },
        }
      );
      const result = await blackboardPattern.execute(ctx);
      // Should succeed (not fail) and the stored contribution is truncated.
      expect(result.agentResults[0]!.success).toBe(true);
      // The final content in the workspace must fit within the effective budget.
      const contribution = result.agentResults[0]!.content;
      expect(contribution.length).toBeLessThanOrEqual(50);
    });

    it("uses compact behavior when no memory policy is supplied (default)", async () => {
      const longResponse = "B".repeat(5000);
      const { ctx } = buildContext("blackboard", [
        buildResolved("a1", { response: longResponse }),
      ]);
      // Default maxEntryChars is 4000 — response exceeds it but must not throw.
      const result = await blackboardPattern.execute(ctx);
      expect(result.agentResults[0]!.success).toBe(true);
    });
  });

  describe("maxSerializedChars enforcement", () => {
    it("throws when total workspace context exceeds maxSerializedChars with overflowBehavior=reject", async () => {
      // formatBoundedBlackboardContext is called at the top of the round loop to
      // build the prompt. With reject behavior and a very tight budget, it throws
      // before any participant runs — the error escapes execute() uncaught.
      const { ctx } = buildContext(
        "blackboard",
        [buildResolved("a1", { response: "hello-from-a1" })],
        {
          policies: {
            memory: {
              tier: "ephemeral",
              shareAcrossParticipants: true,
              blackboardContext: {
                maxSerializedChars: 10,
                maxEntryChars: 5,
                overflowBehavior: "reject",
              },
            },
          },
        }
      );
      await expect(blackboardPattern.execute(ctx)).rejects.toThrow(
        /maxSerializedChars/
      );
    });

    it("compacts total workspace context when maxSerializedChars is tight with compact behavior", async () => {
      const { ctx } = buildContext(
        "blackboard",
        [
          buildResolved("p1", { response: "contribution-from-p1" }),
          buildResolved("p2", { response: "contribution-from-p2" }),
        ],
        {
          policies: {
            memory: {
              tier: "ephemeral",
              shareAcrossParticipants: true,
              blackboardContext: {
                maxSerializedChars: 80,
                overflowBehavior: "compact",
              },
            },
          },
        }
      );
      const result = await blackboardPattern.execute(ctx);
      // compact: should succeed, final content is truncated to budget.
      expect(result.pattern).toBe("blackboard");
      expect(result.content.length).toBeLessThanOrEqual(80);
    });
  });

  describe("hook wiring", () => {
    it("fires emitParticipantStart exactly once per participant", async () => {
      const { ctx, calls } = buildContext("blackboard", [
        buildResolved("x"),
        buildResolved("y"),
        buildResolved("z"),
      ]);
      await blackboardPattern.execute(ctx);
      expect(calls.starts).toHaveLength(3);
      expect(calls.starts).toContain("x");
      expect(calls.starts).toContain("y");
      expect(calls.starts).toContain("z");
    });

    it("fires emitParticipantComplete once per participant after all rounds", async () => {
      const { ctx, calls } = buildContext("blackboard", [
        buildResolved("p1"),
        buildResolved("p2"),
      ]);
      await blackboardPattern.execute(ctx);
      expect(calls.completes).toHaveLength(2);
      expect(calls.completes.map((c) => c.id).sort()).toEqual(["p1", "p2"]);
    });

    it("marks complete success=false for a throwing participant", async () => {
      const { ctx, calls } = buildContext("blackboard", [
        buildResolved("good"),
        buildResolved("bad", { shouldThrow: true }),
      ]);
      await blackboardPattern.execute(ctx);
      const goodComplete = calls.completes.find((c) => c.id === "good")!;
      const badComplete = calls.completes.find((c) => c.id === "bad")!;
      expect(goodComplete.success).toBe(true);
      expect(badComplete.success).toBe(false);
    });
  });

  describe("workspace state", () => {
    it("writes the task into the workspace under __runtime__ before rounds", async () => {
      const { ctx } = buildContext(
        "blackboard",
        [buildResolved("w1", { response: "w1-note" })],
        { task: "build-the-widget" }
      );
      await blackboardPattern.execute(ctx);
      // The pattern sets key 'task' for agents to read in their prompts.
      expect(ctx.workspace.get("task")).toBe("build-the-widget");
    });

    it("advances the round counter in the workspace across iterations", async () => {
      const { ctx } = buildContext("blackboard", [
        buildResolved("r1", { response: "r1-note" }),
      ]);
      await blackboardPattern.execute(ctx);
      // After 3 rounds (DEFAULT_MAX_ROUNDS), the round key should be '3'.
      expect(ctx.workspace.get("round")).toBe("3");
    });

    it("writes each participant's contribution into the workspace under its id", async () => {
      const { ctx } = buildContext("blackboard", [
        buildResolved("contrib-a", { response: "alpha" }),
        buildResolved("contrib-b", { response: "beta" }),
      ]);
      await blackboardPattern.execute(ctx);
      expect(ctx.workspace.get("contrib-a")).toBe("alpha");
      expect(ctx.workspace.get("contrib-b")).toBe("beta");
    });
  });

  describe("agentResults shape", () => {
    it("includes agentId, role, content, success, and durationMs for each participant", async () => {
      const { ctx } = buildContext("blackboard", [
        buildResolved("s1", { role: "specialist", response: "my-note" }),
      ]);
      const result = await blackboardPattern.execute(ctx);
      const r = result.agentResults[0]!;
      expect(r.agentId).toBe("s1");
      expect(r.role).toBe("specialist");
      expect(r.content).toBe("my-note");
      expect(r.success).toBe(true);
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("includes error field for a failed participant but omits it for successful ones", async () => {
      const { ctx } = buildContext("blackboard", [
        buildResolved("ok"),
        buildResolved("err", { shouldThrow: true }),
      ]);
      const result = await blackboardPattern.execute(ctx);
      const ok = result.agentResults.find((r) => r.agentId === "ok")!;
      const err = result.agentResults.find((r) => r.agentId === "err")!;
      expect("error" in ok).toBe(false);
      expect(err.error).toMatch(/mock model failed/);
    });
  });
});
