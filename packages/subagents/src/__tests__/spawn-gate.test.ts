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

describe("SpawnGate.evaluateBatch", () => {
  it("uses legacy policy check with the parent run string for batch evaluation", async () => {
    const calls: Array<{ spec: SubagentSpec; parentRunId: string }> = [];
    const policy: SpawnPolicy = {
      check: (checkedSpec, parentRunId) => {
        calls.push({ spec: checkedSpec, parentRunId });
        return { allow: true, requiresApproval: true };
      },
    };
    const gate = new SpawnGate(policy);

    expect(
      await gate.evaluateBatch({
        batchId: "batch1",
        parentRunId: "run-1",
        mode: "template",
        template: spec,
        itemKeys: ["a", "b"],
      }),
    ).toEqual({ outcome: "needs_approval" });
    expect(calls).toEqual([{ spec, parentRunId: "run-1" }]);
  });

  it("invokes checkWithContext for batch-aware policies", async () => {
    const contexts: unknown[] = [];
    const policy: SpawnPolicy = {
      check: () => ({ allow: false, reason: "legacy_not_used" }),
      checkWithContext: (_checkedSpec, _parentRunId, context) => {
        contexts.push(context);
        return { allow: true, requiresApproval: false };
      },
    };
    const gate = new SpawnGate(policy);

    expect(
      await gate.evaluateBatch({
        batchId: "batch1",
        parentRunId: "run-1",
        mode: "template",
        template: spec,
        itemKeys: ["a", "b"],
      }),
    ).toEqual({ outcome: "allowed" });
    expect(contexts).toEqual([
      {
        kind: "batch",
        batchId: "batch1",
        batchSize: 2,
        itemKeys: ["a", "b"],
        mode: "template",
      },
    ]);
  });

  it("denies approved batch items that widen outbound scope before policy runs", async () => {
    let policyCalls = 0;
    const policy: SpawnPolicy = {
      check: () => {
        policyCalls += 1;
        return { allow: true, requiresApproval: false };
      },
    };
    const gate = new SpawnGate(policy);

    expect(
      await gate.evaluate(
        { agentId: "x", input: "hi", outboundScope: ["repo", "network"] },
        "run-1",
        "subagent:t1",
        {
          batch: {
            batchId: "batch1",
            mode: "template",
            template: { agentId: "x", input: "batch", outboundScope: ["repo"] },
            itemKeys: ["a"],
          },
          itemKey: "a",
        },
      ),
    ).toEqual({
      outcome: "denied",
      reason: "batch_scope_widened: outboundScope",
    });
    expect(policyCalls).toBe(0);
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
