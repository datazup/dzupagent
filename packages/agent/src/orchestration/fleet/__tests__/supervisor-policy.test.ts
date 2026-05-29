import { describe, it, expect } from "vitest";
import { SupervisorPolicy } from "../policies/supervisor-policy.js";
import type { ContractPayload } from "@dzupagent/agent-types/fleet";

const contract = (after: string): ContractPayload => ({
  surface: "s",
  changeKind: "modify",
  after: { v: after },
  consumers: [],
  rationale: "",
  status: "proposed",
});

describe("SupervisorPolicy", () => {
  it("assigns round-robin across non-busy workers", async () => {
    const p = new SupervisorPolicy();
    const fleet = [
      { workerId: "a", repo: "r1", busy: false },
      { workerId: "b", repo: "r2", busy: false },
    ];
    const a1 = await p.assignTask(
      { id: "t1", description: "", payload: {}, dependsOn: [] },
      fleet,
      {} as never
    );
    const a2 = await p.assignTask(
      { id: "t2", description: "", payload: {}, dependsOn: [] },
      fleet,
      {} as never
    );
    expect([a1.workerId, a2.workerId].sort()).toEqual(["a", "b"]);
  });

  it("ratifies a single proposal", async () => {
    const p = new SupervisorPolicy();
    const plan = await p.onContractChange(
      { surface: "s", proposals: [contract("v1")] },
      []
    );
    expect(plan.ratified?.status).toBe("ratified");
    expect(plan.escalate).toBe(false);
  });

  it("escalates when proposals conflict", async () => {
    const p = new SupervisorPolicy();
    const plan = await p.onContractChange(
      { surface: "s", proposals: [contract("v1"), contract("v2")] },
      []
    );
    expect(plan.ratified).toBeNull();
    expect(plan.escalate).toBe(true);
  });
});
