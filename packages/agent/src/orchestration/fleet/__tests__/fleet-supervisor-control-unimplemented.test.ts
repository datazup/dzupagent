import { describe, it, expect } from "vitest";
import { ForgeError } from "@dzupagent/core/events";
import { FleetSupervisor } from "../fleet-supervisor.js";
import type { Executor, KnowledgeStore } from "@dzupagent/agent-types/fleet";

/**
 * Phase-1a fleet control surface (pauseTask/cancelTask/reassign) must throw a
 * non-recoverable ForgeError rather than silently no-op'ing, so a FleetPolicy
 * that depends on mid-run control fails loudly. Replaces the previous
 * Phase-1b empty-body stubs.
 */

function makeSupervisor(): FleetSupervisor {
  // Deps are never exercised — the control methods throw before touching them.
  const knowledge = {} as KnowledgeStore;
  const executorFor = (): Executor => {
    throw new Error("executorFor should not be called in this test");
  };
  return new FleetSupervisor({ knowledge, executorFor });
}

describe("FleetSupervisor mid-run control (Phase 1a)", () => {
  it("pauseTask throws a non-recoverable CAPABILITY_NOT_FOUND ForgeError", async () => {
    const sup = makeSupervisor();
    await expect(sup.pauseTask("t-1", "draining")).rejects.toThrow(ForgeError);
    await expect(sup.pauseTask("t-1", "draining")).rejects.toMatchObject({
      code: "CAPABILITY_NOT_FOUND",
      recoverable: false,
      context: { operation: "pauseTask", taskId: "t-1", reason: "draining" },
    });
  });

  it("cancelTask throws a non-recoverable CAPABILITY_NOT_FOUND ForgeError", async () => {
    const sup = makeSupervisor();
    await expect(sup.cancelTask("t-2", "abort")).rejects.toMatchObject({
      code: "CAPABILITY_NOT_FOUND",
      recoverable: false,
      context: { operation: "cancelTask", taskId: "t-2", reason: "abort" },
    });
  });

  it("reassign throws a non-recoverable CAPABILITY_NOT_FOUND ForgeError", async () => {
    const sup = makeSupervisor();
    await expect(sup.reassign("t-3")).rejects.toMatchObject({
      code: "CAPABILITY_NOT_FOUND",
      recoverable: false,
      context: { operation: "reassign", taskId: "t-3" },
    });
  });
});
