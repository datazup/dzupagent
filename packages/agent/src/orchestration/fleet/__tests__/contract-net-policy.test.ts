import { describe, it, expect } from "vitest";
import { ContractNetPolicy } from "../policies/contract-net-policy.js";

describe("ContractNetPolicy", () => {
  it("awards to the highest-bidding worker", async () => {
    const p = new ContractNetPolicy({
      bidder: (worker, _task) =>
        Promise.resolve(worker.workerId === "b" ? 10 : 1),
    });
    const a = await p.assignTask(
      { id: "t1", description: "", payload: {}, dependsOn: [] },
      [
        { workerId: "a", repo: "r1", busy: false },
        { workerId: "b", repo: "r2", busy: false },
      ],
      {} as never
    );
    expect(a.workerId).toBe("b");
  });

  it("escalates when no bidder", async () => {
    const p = new ContractNetPolicy({ bidder: () => Promise.resolve(null) });
    await expect(
      p.assignTask(
        { id: "t", description: "", payload: {}, dependsOn: [] },
        [{ workerId: "a", repo: "r", busy: false }],
        {} as never
      )
    ).rejects.toThrow(/no.*bidder/i);
  });
});
