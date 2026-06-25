/**
 * Gap-filling tests for the council coordination pattern.
 * Covers hook wiring, agentResults shape, and single-proposer paths
 * not exercised by council-pattern.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentOrchestrator } from "../../../orchestrator.js";
import { councilPattern } from "../council-pattern.js";
import { buildContext, buildResolved } from "./test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("councilPattern — gap coverage", () => {
  describe("hook wiring", () => {
    it("fires emitParticipantStart for every participant including the judge", async () => {
      vi.spyOn(AgentOrchestrator, "debate").mockResolvedValue("verdict");
      const { ctx, calls } = buildContext("council", [
        buildResolved("judge", { role: "judge", model: "claude-opus-4-7" }),
        buildResolved("p1", { role: "proposer" }),
        buildResolved("p2", { role: "proposer" }),
      ]);
      await councilPattern.execute(ctx);
      expect(calls.starts).toHaveLength(3);
      expect(calls.starts).toContain("judge");
      expect(calls.starts).toContain("p1");
      expect(calls.starts).toContain("p2");
    });

    it("fires emitParticipantComplete with success=true for every participant on happy path", async () => {
      vi.spyOn(AgentOrchestrator, "debate").mockResolvedValue("verdict");
      const { ctx, calls } = buildContext("council", [
        buildResolved("judge", { role: "judge", model: "claude-opus-4-7" }),
        buildResolved("p1", { role: "proposer" }),
      ]);
      await councilPattern.execute(ctx);
      expect(calls.completes).toHaveLength(2);
      expect(calls.completes.every((c) => c.success)).toBe(true);
    });

    it("passes a non-negative durationMs to emitParticipantComplete", async () => {
      vi.spyOn(AgentOrchestrator, "debate").mockResolvedValue("ok");
      const { ctx, calls } = buildContext("council", [
        buildResolved("j", { role: "judge", model: "claude-opus-4-7" }),
        buildResolved("p", { role: "proposer" }),
      ]);
      await councilPattern.execute(ctx);
      expect(calls.completes.every((c) => c.durationMs >= 0)).toBe(true);
    });

    it("fires emitParticipantComplete with success=false and error message when debate throws", async () => {
      vi.spyOn(AgentOrchestrator, "debate").mockRejectedValue(
        new Error("debate exploded")
      );
      const { ctx, calls } = buildContext("council", [
        buildResolved("j", { role: "judge", model: "claude-opus-4-7" }),
        buildResolved("p", { role: "proposer" }),
      ]);
      await expect(councilPattern.execute(ctx)).rejects.toThrow(
        "debate exploded"
      );
      expect(calls.completes.every((c) => c.success === false)).toBe(true);
      expect(calls.completes.every((c) => c.error === "debate exploded")).toBe(
        true
      );
    });
  });

  describe("agentResults shape", () => {
    it("judge agentResult carries the verdict content; proposers have empty content", async () => {
      vi.spyOn(AgentOrchestrator, "debate").mockResolvedValue("final-verdict");
      const { ctx } = buildContext(
        "council",
        [
          buildResolved("j", { role: "judge", model: "claude-opus-4-7" }),
          buildResolved("pa", { role: "proposer" }),
          buildResolved("pb", { role: "proposer" }),
        ],
        { policies: { governance: { judgeModel: "claude-opus-4-7" } } }
      );
      const result = await councilPattern.execute(ctx);
      const judge = result.agentResults.find((r) => r.agentId === "j")!;
      const pa = result.agentResults.find((r) => r.agentId === "pa")!;
      expect(judge.content).toBe("final-verdict");
      expect(pa.content).toBe("");
    });

    it("all agentResults have success=true on the happy path", async () => {
      vi.spyOn(AgentOrchestrator, "debate").mockResolvedValue("ok");
      const { ctx } = buildContext("council", [
        buildResolved("j", { role: "judge", model: "claude-opus-4-7" }),
        buildResolved("p1", { role: "proposer" }),
      ]);
      const result = await councilPattern.execute(ctx);
      expect(result.agentResults.every((r) => r.success)).toBe(true);
    });

    it("result.durationMs is non-negative", async () => {
      vi.spyOn(AgentOrchestrator, "debate").mockResolvedValue("ok");
      const { ctx } = buildContext("council", [
        buildResolved("j", { role: "judge", model: "claude-opus-4-7" }),
        buildResolved("p", { role: "proposer" }),
      ]);
      const result = await councilPattern.execute(ctx);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("result contains all participant ids in agentResults", async () => {
      vi.spyOn(AgentOrchestrator, "debate").mockResolvedValue("ok");
      const { ctx } = buildContext("council", [
        buildResolved("j", { role: "judge", model: "claude-opus-4-7" }),
        buildResolved("p1", { role: "proposer" }),
        buildResolved("p2", { role: "proposer" }),
      ]);
      const result = await councilPattern.execute(ctx);
      const ids = result.agentResults.map((r) => r.agentId).sort();
      expect(ids).toEqual(["j", "p1", "p2"]);
    });
  });

  describe("single-proposer council", () => {
    it("runs debate with one proposer and produces a result", async () => {
      const spy = vi
        .spyOn(AgentOrchestrator, "debate")
        .mockResolvedValue("solo-verdict");
      const { ctx } = buildContext("council", [
        buildResolved("j", { role: "judge", model: "claude-opus-4-7" }),
        buildResolved("only-proposer", { role: "proposer" }),
      ]);
      const result = await councilPattern.execute(ctx);
      expect(spy).toHaveBeenCalledOnce();
      expect(result.content).toBe("solo-verdict");
      expect(result.pattern).toBe("council");
    });
  });
});
