import { describe, it, expect, vi } from "vitest";
import type { FleetSupervisorApi } from "@dzupagent/agent-types/fleet";
import { FanOutPolicy } from "../policies/fan-out-policy.js";

const makeFleet = (states: boolean[]) =>
  states.map((busy, i) => ({ workerId: `w${i}`, repo: `r${i}`, busy }));

const makeTask = (id = "t1") => ({
  id,
  description: "",
  payload: {},
  dependsOn: [] as string[],
});

describe("FanOutPolicy", () => {
  it("has id 'fan-out'", () => {
    expect(new FanOutPolicy().id).toBe("fan-out");
  });

  it("assigns the task to the first non-busy worker", async () => {
    const p = new FanOutPolicy();
    const a = await p.assignTask(
      makeTask(),
      makeFleet([true, false]),
      {} as never,
    );
    expect(a.workerId).toBe("w1");
  });

  it("echoes the task id into the assignment", async () => {
    const p = new FanOutPolicy();
    const a = await p.assignTask(
      makeTask("my-task"),
      makeFleet([false]),
      {} as never,
    );
    expect(a.taskId).toBe("my-task");
  });

  it("picks the very first idle worker when several are free", async () => {
    const p = new FanOutPolicy();
    const a = await p.assignTask(
      makeTask(),
      makeFleet([false, false, false]),
      {} as never,
    );
    expect(a.workerId).toBe("w0");
  });

  it("includes a rationale string in the assignment", async () => {
    const p = new FanOutPolicy();
    const a = await p.assignTask(makeTask(), makeFleet([false]), {} as never);
    expect(typeof a.rationale).toBe("string");
    expect(a.rationale.length).toBeGreaterThan(0);
  });

  it("throws when all workers are busy", async () => {
    const p = new FanOutPolicy();
    await expect(
      p.assignTask(makeTask("t2"), makeFleet([true, true]), {} as never),
    ).rejects.toThrow(/no.*worker/i);
  });

  it("throws when the fleet is empty", async () => {
    const p = new FanOutPolicy();
    await expect(p.assignTask(makeTask("t3"), [], {} as never)).rejects.toThrow(
      /no.*worker/i,
    );
  });

  it("the error message includes the task id", async () => {
    const p = new FanOutPolicy();
    await expect(
      p.assignTask(makeTask("specific-task"), [], {} as never),
    ).rejects.toThrow("specific-task");
  });

  it("treats contract changes as no-op", async () => {
    const p = new FanOutPolicy();
    const plan = await p.onContractChange({ surface: "s", proposals: [] }, []);
    expect(plan).toEqual({
      ratified: null,
      rejectIds: [],
      pauseTasks: [],
      escalate: false,
    });
  });

  it("onWorkerComplete resolves without side effects", async () => {
    const p = new FanOutPolicy();
    // The real FleetSupervisorApi surface is pauseTask/cancelTask/reassign.
    // The previous double asserted on `complete`/`escalate`, which do not
    // exist on the interface, so no implementation could ever have called
    // them and the assertions could not fail.
    const supervisor = {
      pauseTask: vi.fn(async () => {}),
      cancelTask: vi.fn(async () => {}),
      reassign: vi.fn(async () => {}),
    } satisfies FleetSupervisorApi;
    const result = await p.onWorkerComplete(
      {
        workerId: "w0",
        repo: "r0",
        taskId: "t1",
        state: "completed",
        events: [],
      },
      supervisor,
    );
    expect(result).toBeUndefined();
    expect(supervisor.pauseTask).not.toHaveBeenCalled();
    expect(supervisor.cancelTask).not.toHaveBeenCalled();
    expect(supervisor.reassign).not.toHaveBeenCalled();
  });

  it("onEscalation returns human-handoff kind", async () => {
    const p = new FanOutPolicy();
    const outcome = await p.onEscalation("repeated-failure", {} as never);
    expect(outcome.kind).toBe("human-handoff");
  });

  it("onEscalation note is a non-empty string", async () => {
    const p = new FanOutPolicy();
    const outcome = await p.onEscalation("budget-exhausted", {} as never);
    // EscalationOutcome is a discriminated union (HumanHandoff | Retry);
    // only the human-handoff arm carries `note`.
    if (outcome.kind !== "human-handoff") {
      throw new Error(`expected human-handoff, got ${outcome.kind}`);
    }
    expect(typeof outcome.note).toBe("string");
    expect(outcome.note.length).toBeGreaterThan(0);
  });
});
