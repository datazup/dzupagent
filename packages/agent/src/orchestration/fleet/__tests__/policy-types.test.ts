import { describe, it, expect } from "vitest";
import type { FleetPolicy } from "../policies/policy-types.js";

describe("FleetPolicy interface", () => {
  it("is implementable as a stub", async () => {
    const p: FleetPolicy = {
      id: "stub",
      async assignTask() {
        return { taskId: "t1", workerId: "w1", rationale: "" };
      },
      async onContractChange() {
        return {
          ratified: null,
          rejectIds: [],
          pauseTasks: [],
          escalate: false,
        };
      },
      async onWorkerComplete() {},
      async onEscalation() {
        return { kind: "retry", delayMs: 0 };
      },
    };
    const a = await p.assignTask({} as never, [] as never, {} as never);
    expect(a.workerId).toBe("w1");
  });
});
