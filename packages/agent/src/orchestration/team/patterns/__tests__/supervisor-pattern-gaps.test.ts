/**
 * Gap-filling tests for the supervisor coordination pattern.
 * Covers agentResults shape, durationMs, manager-fallback selection,
 * and hook start ordering.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentOrchestrator } from "../../../orchestrator.js";
import { supervisorPattern } from "../supervisor-pattern.js";
import { buildContext, buildResolved } from "./test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("supervisorPattern — gap coverage", () => {
  describe("agentResults shape", () => {
    it("manager agentResult carries the full content; specialists get empty content", async () => {
      vi.spyOn(AgentOrchestrator, "supervisor").mockResolvedValue({
        content: "manager-output",
        availableSpecialists: ["s1", "s2"],
        filteredSpecialists: [],
      });
      const { ctx } = buildContext("supervisor", [
        buildResolved("mgr", { role: "supervisor" }),
        buildResolved("s1", { role: "specialist" }),
        buildResolved("s2", { role: "specialist" }),
      ]);
      const result = await supervisorPattern.execute(ctx);
      const mgr = result.agentResults.find((r) => r.agentId === "mgr")!;
      const s1 = result.agentResults.find((r) => r.agentId === "s1")!;
      expect(mgr.content).toBe("manager-output");
      expect(s1.content).toBe("");
    });

    it("all agentResults have success=true on the happy path", async () => {
      vi.spyOn(AgentOrchestrator, "supervisor").mockResolvedValue({
        content: "ok",
        availableSpecialists: ["s1"],
        filteredSpecialists: [],
      });
      const { ctx } = buildContext("supervisor", [
        buildResolved("mgr", { role: "supervisor" }),
        buildResolved("s1", { role: "specialist" }),
      ]);
      const result = await supervisorPattern.execute(ctx);
      expect(result.agentResults.every((r) => r.success)).toBe(true);
    });

    it("agentResults ordering: manager first, then specialists in input order", async () => {
      vi.spyOn(AgentOrchestrator, "supervisor").mockResolvedValue({
        content: "ok",
        availableSpecialists: ["alpha", "beta"],
        filteredSpecialists: [],
      });
      const { ctx } = buildContext("supervisor", [
        buildResolved("mgr", { role: "supervisor" }),
        buildResolved("alpha", { role: "specialist" }),
        buildResolved("beta", { role: "specialist" }),
      ]);
      const result = await supervisorPattern.execute(ctx);
      expect(result.agentResults.map((r) => r.agentId)).toEqual([
        "mgr",
        "alpha",
        "beta",
      ]);
    });

    it("result.durationMs is non-negative", async () => {
      vi.spyOn(AgentOrchestrator, "supervisor").mockResolvedValue({
        content: "ok",
        availableSpecialists: [],
        filteredSpecialists: [],
      });
      const { ctx } = buildContext("supervisor", [
        buildResolved("mgr", { role: "supervisor" }),
        buildResolved("s1", { role: "specialist" }),
      ]);
      const result = await supervisorPattern.execute(ctx);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("all agentResults carry a non-negative durationMs", async () => {
      vi.spyOn(AgentOrchestrator, "supervisor").mockResolvedValue({
        content: "ok",
        availableSpecialists: ["s1"],
        filteredSpecialists: [],
      });
      const { ctx } = buildContext("supervisor", [
        buildResolved("mgr", { role: "supervisor" }),
        buildResolved("s1", { role: "specialist" }),
      ]);
      const result = await supervisorPattern.execute(ctx);
      expect(result.agentResults.every((r) => r.durationMs >= 0)).toBe(true);
    });
  });

  describe("manager selection fallback", () => {
    it("uses first participant as manager when no participant has role 'supervisor'", async () => {
      vi.spyOn(AgentOrchestrator, "supervisor").mockResolvedValue({
        content: "first-wins",
        availableSpecialists: ["second"],
        filteredSpecialists: [],
      });
      const { ctx } = buildContext("supervisor", [
        buildResolved("first", { role: "worker" }),
        buildResolved("second", { role: "worker" }),
      ]);
      const result = await supervisorPattern.execute(ctx);
      // First participant is the manager → its agentResult gets the content.
      const first = result.agentResults.find((r) => r.agentId === "first")!;
      expect(first.content).toBe("first-wins");
    });

    it("prefers the participant with role 'supervisor' over an earlier non-supervisor", async () => {
      vi.spyOn(AgentOrchestrator, "supervisor").mockResolvedValue({
        content: "sup-output",
        availableSpecialists: ["worker"],
        filteredSpecialists: [],
      });
      const { ctx } = buildContext("supervisor", [
        buildResolved("worker", { role: "specialist" }),
        buildResolved("sup", { role: "supervisor" }),
      ]);
      const result = await supervisorPattern.execute(ctx);
      const sup = result.agentResults.find((r) => r.agentId === "sup")!;
      expect(sup.content).toBe("sup-output");
    });
  });

  describe("hook wiring", () => {
    it("emitParticipantStart fires for manager and all specialists", async () => {
      vi.spyOn(AgentOrchestrator, "supervisor").mockResolvedValue({
        content: "ok",
        availableSpecialists: ["s1", "s2"],
        filteredSpecialists: [],
      });
      const { ctx, calls } = buildContext("supervisor", [
        buildResolved("mgr", { role: "supervisor" }),
        buildResolved("s1", { role: "specialist" }),
        buildResolved("s2", { role: "specialist" }),
      ]);
      await supervisorPattern.execute(ctx);
      expect(calls.starts).toHaveLength(3);
      expect(calls.starts).toContain("mgr");
      expect(calls.starts).toContain("s1");
      expect(calls.starts).toContain("s2");
    });

    it("manager start fires before specialist starts", async () => {
      vi.spyOn(AgentOrchestrator, "supervisor").mockResolvedValue({
        content: "ok",
        availableSpecialists: ["s1"],
        filteredSpecialists: [],
      });
      const { ctx, calls } = buildContext("supervisor", [
        buildResolved("mgr", { role: "supervisor" }),
        buildResolved("s1", { role: "specialist" }),
      ]);
      await supervisorPattern.execute(ctx);
      expect(calls.starts[0]).toBe("mgr");
      expect(calls.starts[1]).toBe("s1");
    });

    it("emitParticipantComplete fires for all participants on success", async () => {
      vi.spyOn(AgentOrchestrator, "supervisor").mockResolvedValue({
        content: "ok",
        availableSpecialists: ["s1"],
        filteredSpecialists: [],
      });
      const { ctx, calls } = buildContext("supervisor", [
        buildResolved("mgr", { role: "supervisor" }),
        buildResolved("s1", { role: "specialist" }),
      ]);
      await supervisorPattern.execute(ctx);
      expect(calls.completes).toHaveLength(2);
      expect(calls.completes.every((c) => c.success)).toBe(true);
    });

    it("emitParticipantComplete error message matches thrown error", async () => {
      vi.spyOn(AgentOrchestrator, "supervisor").mockRejectedValue(
        new Error("sup-crash")
      );
      const { ctx, calls } = buildContext("supervisor", [
        buildResolved("mgr", { role: "supervisor" }),
        buildResolved("s1", { role: "specialist" }),
      ]);
      await expect(supervisorPattern.execute(ctx)).rejects.toThrow("sup-crash");
      expect(calls.completes.every((c) => c.error === "sup-crash")).toBe(true);
    });
  });
});
