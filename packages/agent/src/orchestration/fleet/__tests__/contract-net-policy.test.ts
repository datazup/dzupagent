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

  it("skips busy workers when assigning", async () => {
    const p = new ContractNetPolicy({
      bidder: (_worker, _task) => Promise.resolve(5),
    });
    const a = await p.assignTask(
      { id: "t1", description: "", payload: {}, dependsOn: [] },
      [
        { workerId: "busy-one", repo: "r1", busy: true },
        { workerId: "free-one", repo: "r2", busy: false },
      ],
      {} as never
    );
    expect(a.workerId).toBe("free-one");
  });

  it("chooses the higher bid when multiple workers are available", async () => {
    const bids: Record<string, number> = { w1: 5, w2: 10, w3: 3 };
    const p = new ContractNetPolicy({
      bidder: (worker, _task) => Promise.resolve(bids[worker.workerId] ?? 0),
    });
    const a = await p.assignTask(
      { id: "t2", description: "", payload: {}, dependsOn: [] },
      [
        { workerId: "w1", repo: "r1", busy: false },
        { workerId: "w2", repo: "r2", busy: false },
        { workerId: "w3", repo: "r3", busy: false },
      ],
      {} as never
    );
    expect(a.workerId).toBe("w2");
  });

  it("onContractChange always ratifies null with no rejects", async () => {
    const p = new ContractNetPolicy({ bidder: () => Promise.resolve(1) });
    const result = await p.onContractChange({} as never, []);
    expect(result).toEqual({
      ratified: null,
      rejectIds: [],
      pauseTasks: [],
      escalate: false,
    });
  });

  it("onEscalation returns human-handoff", async () => {
    const p = new ContractNetPolicy({ bidder: () => Promise.resolve(1) });
    const outcome = await p.onEscalation({} as never, {} as never);
    expect(outcome).toEqual({ kind: "human-handoff", note: "no bidder" });
  });

  it("onWorkerComplete is a no-op (no throw)", async () => {
    const p = new ContractNetPolicy({ bidder: () => Promise.resolve(1) });
    await expect(
      p.onWorkerComplete({} as never, {} as never)
    ).resolves.toBeUndefined();
  });
});
