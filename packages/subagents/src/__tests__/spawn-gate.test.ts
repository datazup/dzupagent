import { describe, it, expect } from "vitest";
import { SpawnGate, allowAllSpawnPolicy } from "../governance/spawn-gate.js";
import type { SpawnPolicy } from "../governance/spawn-gate.js";
import type { SubagentSpec } from "../contracts/background-task.js";

const spec: SubagentSpec = { agentId: "x", input: "hi" };

describe("SpawnGate.evaluate", () => {
  it("allows when policy allows and no approval required", async () => {
    const gate = new SpawnGate(allowAllSpawnPolicy);
    expect(await gate.evaluate(spec, "r", "a")).toEqual({ outcome: "allowed" });
  });

  it("denies when policy denies", async () => {
    const policy: SpawnPolicy = {
      check: () => ({ allow: false, reason: "agent_not_allowed" }),
    };
    const gate = new SpawnGate(policy);
    expect(await gate.evaluate(spec, "r", "a")).toEqual({
      outcome: "denied",
      reason: "agent_not_allowed",
    });
  });

  it("signals needs_approval when policy requires it", async () => {
    const policy: SpawnPolicy = {
      check: () => ({ allow: true, requiresApproval: true }),
    };
    const gate = new SpawnGate(policy);
    expect(await gate.evaluate(spec, "r", "a")).toEqual({
      outcome: "needs_approval",
    });
  });

  it("awaits an async policy check", async () => {
    const policy: SpawnPolicy = {
      check: async () => ({ allow: true, requiresApproval: false }),
    };
    const gate = new SpawnGate(policy);
    expect(await gate.evaluate(spec, "r", "a")).toEqual({ outcome: "allowed" });
  });
});

describe("SpawnGate.awaitApproval", () => {
  it("fails closed when approval required but no gate wired", async () => {
    const gate = new SpawnGate(allowAllSpawnPolicy);
    expect(await gate.awaitApproval("r", "a")).toEqual({
      approved: false,
      reason: "approval_required_but_no_gate_configured",
    });
  });

  it("approves when the gate resolves", async () => {
    const gate = new SpawnGate(allowAllSpawnPolicy, {
      waitForApproval: async () => undefined,
    });
    expect(await gate.awaitApproval("r", "a")).toEqual({ approved: true });
  });

  it("rejects with reason when the gate throws", async () => {
    const gate = new SpawnGate(allowAllSpawnPolicy, {
      waitForApproval: async () => {
        throw new Error("rejected by alice");
      },
    });
    expect(await gate.awaitApproval("r", "a")).toEqual({
      approved: false,
      reason: "rejected by alice",
    });
  });
});
