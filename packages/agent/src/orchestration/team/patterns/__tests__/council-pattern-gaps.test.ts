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
      const { ctx, calls } = buildContext("council", [
        buildResolved("judge", { role: "judge", model: "claude-opus-4-7" }),
        buildResolved("p1", { role: "proposer" }),
      ]);
      await councilPattern.execute(ctx);
      expect(calls.completes).toHaveLength(2);
      expect(calls.completes.every((call) => call.success)).toBe(true);
    });

    it("passes a non-negative durationMs to emitParticipantComplete", async () => {
      const { ctx, calls } = buildContext("council", [
        buildResolved("j", { role: "judge", model: "claude-opus-4-7" }),
        buildResolved("p", { role: "proposer" }),
      ]);
      await councilPattern.execute(ctx);
      expect(calls.completes.length).toBeGreaterThan(0)
      expect(calls.completes.every((call) => call.durationMs >= 0)).toBe(true);
    });

    it("records only the judge failure when the judge throws", async () => {
      const { ctx, calls } = buildContext("council", [
        buildResolved("j", {
          role: "judge",
          model: "claude-opus-4-7",
          shouldThrow: true,
        }),
        buildResolved("p", { role: "proposer", response: "proposal" }),
      ]);
      await expect(councilPattern.execute(ctx)).rejects.toThrow(
        "mock model failed"
      );
      expect(calls.completes).toEqual([
        expect.objectContaining({ id: "p", success: true }),
        expect.objectContaining({
          id: "j",
          success: false,
          error: "mock model failed",
        }),
      ]);
      expect(calls.completes.length).toBeGreaterThan(0);
      expect(calls.completes.every((call) => Number.isFinite(call.durationMs)))
        .toBe(true);
      expect(calls.completes.every((call) => call.durationMs >= 0)).toBe(true);
    });
  });

  describe("agentResults shape", () => {
    it("judge and proposer agentResults carry their exact generated content", async () => {
      const { ctx } = buildContext(
        "council",
        [
          buildResolved("j", {
            role: "judge",
            model: "claude-opus-4-7",
            response: "final-verdict",
          }),
          buildResolved("pa", { role: "proposer", response: "proposal-a" }),
          buildResolved("pb", { role: "proposer", response: "proposal-b" }),
        ],
        { policies: { governance: { judgeModel: "claude-opus-4-7" } } }
      );
      const result = await councilPattern.execute(ctx);
      const judge = result.agentResults.find((r) => r.agentId === "j")!;
      const pa = result.agentResults.find((r) => r.agentId === "pa")!;
      expect(judge.content).toBe("final-verdict");
      expect(pa.content).toBe("proposal-a");
    });

    it("all agentResults have success=true on the happy path", async () => {
      const { ctx } = buildContext("council", [
        buildResolved("j", { role: "judge", model: "claude-opus-4-7" }),
        buildResolved("p1", { role: "proposer" }),
      ]);
      const result = await councilPattern.execute(ctx);
      expect(result.agentResults.length).toBeGreaterThan(0)
      expect(result.agentResults.every((item) => item.success)).toBe(true);
    });

    it("result.durationMs is non-negative", async () => {
      const { ctx } = buildContext("council", [
        buildResolved("j", { role: "judge", model: "claude-opus-4-7" }),
        buildResolved("p", { role: "proposer" }),
      ]);
      const result = await councilPattern.execute(ctx);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("result contains all participant ids in agentResults", async () => {
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
      const spy = vi.spyOn(AgentOrchestrator, "debateDetailed");
      const { ctx } = buildContext("council", [
        buildResolved("j", {
          role: "judge",
          model: "claude-opus-4-7",
          response: "solo-verdict",
        }),
        buildResolved("only-proposer", {
          role: "proposer",
          response: "only proposal",
        }),
      ]);
      const result = await councilPattern.execute(ctx);
      expect(spy).toHaveBeenCalledOnce();
      expect(result.content).toBe("solo-verdict");
      expect(result.pattern).toBe("council");
    });
  });
});
