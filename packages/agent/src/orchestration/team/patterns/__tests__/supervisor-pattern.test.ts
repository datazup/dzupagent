/**
 * Unit tests for the supervisor coordination pattern.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentOrchestrator } from "../../../orchestrator.js";
import type {
  SpecialistInvocationObserver,
  SupervisorResult,
} from "../../../supervisor-types.js";
import { supervisorPattern } from "../supervisor-pattern.js";
import { buildContext, buildResolved } from "./test-helpers.js";

/**
 * Pin the supervisor spy to the modern config-object overload.
 *
 * `AgentOrchestrator.supervisor` is overloaded; the deprecated positional form
 * resolves last and returns `Promise<string>`, so `vi.spyOn(...)` infers that
 * one and rejects a `SupervisorResult` mock value. These tests exercise the
 * config-object form, so the spy is narrowed to its return type.
 */
const mockSupervisor = (
  value: SupervisorResult,
  invokedSpecialists = value.availableSpecialists
) =>
  vi.spyOn(AgentOrchestrator, "supervisor").mockImplementation(
    (async (rawConfig: unknown) => {
      const observer = (
        rawConfig as { invocationObserver?: SpecialistInvocationObserver }
      ).invocationObserver;
      for (const [invocationIndex, specialistId] of invokedSpecialists.entries()) {
        await observer?.onStart?.({ specialistId, invocationIndex });
        await observer?.onComplete?.({
          specialistId,
          invocationIndex,
          success: true,
          durationMs: 0,
        });
      }
      return value;
    }) as never
  );


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
    const supervisorSpy = mockSupervisor({
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
    mockSupervisor({
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
    mockSupervisor({
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

  it("emits a manager failure without fabricating uninvoked specialist failures", async () => {
    vi.spyOn(AgentOrchestrator, "supervisor").mockRejectedValue(
      new Error("boom")
    );
    const { ctx, calls } = buildContext("supervisor", [
      buildResolved("mgr", { role: "supervisor" }),
      buildResolved("s1", { role: "specialist" }),
    ]);

    await expect(supervisorPattern.execute(ctx)).rejects.toThrow("boom");
    expect(calls.completes.map((c) => c.success)).toEqual([false]);
    expect(calls.completes.map((c) => c.id)).toEqual(["mgr"]);
    expect(calls.completes[0]!.error).toBe("boom");
  });
});
