/**
 * Unit tests for the supervisor coordination pattern.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentOrchestrator } from "../../../orchestrator.js";
import { supervisorPattern } from "../supervisor-pattern.js";
import { buildContext, buildResolved } from "./test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("supervisorPattern", () => {
  it("exposes the canonical id", () => {
    expect(supervisorPattern.id).toBe("supervisor");
  });

  it("throws when participants is empty", async () => {
    const { ctx } = buildContext("supervisor", []);
    await expect(supervisorPattern.execute(ctx)).rejects.toThrow(
      /no participants/
    );
  });

  it("falls back to single-participant when only the manager is present", async () => {
    const { ctx, calls } = buildContext("supervisor", [
      buildResolved("mgr", { role: "supervisor", response: "solo-result" }),
    ]);
    const result = await supervisorPattern.execute(ctx);
    expect(result.pattern).toBe("single-participant");
    expect(result.content).toBe("solo-result");
    expect(calls.starts).toHaveLength(0);
  });

  it("delegates to AgentOrchestrator.supervisor for manager + specialists", async () => {
    const supervisorSpy = vi
      .spyOn(AgentOrchestrator, "supervisor")
      .mockResolvedValue({
        content: "supervised",
        availableSpecialists: ["s1"],
        filteredSpecialists: [],
      });
    const { ctx, calls } = buildContext("supervisor", [
      buildResolved("mgr", { role: "supervisor" }),
      buildResolved("s1", { role: "specialist" }),
    ]);

    const result = await supervisorPattern.execute(ctx);
    expect(supervisorSpy).toHaveBeenCalledTimes(1);
    expect(result.pattern).toBe("supervisor");
    expect(result.content).toBe("supervised");
    expect(result.agentResults).toHaveLength(2);
    expect(calls.starts).toEqual(["mgr", "s1"]);
    expect(calls.completes.map((c) => c.success)).toEqual([true, true]);
  });

  it("propagates routingDecisionId onto the run result when the supervisor routed", async () => {
    vi.spyOn(AgentOrchestrator, "supervisor").mockResolvedValue({
      content: "supervised",
      availableSpecialists: ["s1"],
      filteredSpecialists: [],
      routingDecisionId: "rule-team-123",
    });
    const { ctx } = buildContext("supervisor", [
      buildResolved("mgr", { role: "supervisor" }),
      buildResolved("s1", { role: "specialist" }),
    ]);

    const result = await supervisorPattern.execute(ctx);
    expect(result.routingDecisionId).toBe("rule-team-123");
  });

  it("omits routingDecisionId from the run result when the supervisor did not route", async () => {
    vi.spyOn(AgentOrchestrator, "supervisor").mockResolvedValue({
      content: "supervised",
      availableSpecialists: ["s1"],
      filteredSpecialists: [],
    });
    const { ctx } = buildContext("supervisor", [
      buildResolved("mgr", { role: "supervisor" }),
      buildResolved("s1", { role: "specialist" }),
    ]);

    const result = await supervisorPattern.execute(ctx);
    expect(result.routingDecisionId).toBeUndefined();
    expect("routingDecisionId" in result).toBe(false);
  });

  it("emits failed completes for all participants when supervisor throws", async () => {
    vi.spyOn(AgentOrchestrator, "supervisor").mockRejectedValue(
      new Error("boom")
    );
    const { ctx, calls } = buildContext("supervisor", [
      buildResolved("mgr", { role: "supervisor" }),
      buildResolved("s1", { role: "specialist" }),
    ]);

    await expect(supervisorPattern.execute(ctx)).rejects.toThrow("boom");
    expect(calls.completes.map((c) => c.success)).toEqual([false, false]);
    expect(calls.completes[0]!.error).toBe("boom");
  });
});
