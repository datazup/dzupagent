import { describe, it, expect } from "vitest";
import { FanOutPolicy } from "../policies/fan-out-policy.js";

describe("FanOutPolicy", () => {
  it("assigns the task to the first non-busy worker", async () => {
    const p = new FanOutPolicy();
    const a = await p.assignTask(
      { id: "t1", description: "", payload: {}, dependsOn: [] },
      [
        { workerId: "a", repo: "r1", busy: true },
        { workerId: "b", repo: "r2", busy: false },
      ],
      {} as never
    );
    expect(a.workerId).toBe("b");
  });

  it("escalates on no available worker", async () => {
    const p = new FanOutPolicy();
    await expect(
      p.assignTask(
        { id: "t1", description: "", payload: {}, dependsOn: [] },
        [],
        {} as never
      )
    ).rejects.toThrow(/no.*worker/i);
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
});
