import { describe, it, expect } from "vitest";
import { SpawnGate, allowAllSpawnPolicy } from "../governance/spawn-gate.js";
import type {
  SpawnApprovalGate,
  SpawnPolicy,
} from "../governance/spawn-gate.js";
import type { SubagentSpec } from "../contracts/background-task.js";
import type { InterruptOutcome } from "@dzupagent/adapter-types";

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

  it("invokes checkWithContext with a batch-flavoured SpawnContext for batch-aware policies", async () => {
    const contexts: unknown[] = [];
    const policy: SpawnPolicy = {
      check: () => ({ allow: false, reason: "legacy_not_used" }),
      checkWithContext: (_checkedSpec, ctx) => {
        contexts.push(ctx);
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
    // The batch template is threaded through the SAME context-aware policy seam
    // as a single spawn — carrying the batch descriptor (with the template, so
    // per-item spawns can be scope-narrowed against it).
    expect(contexts).toEqual([
      {
        parentRunId: "run-1",
        depth: 0,
        batch: {
          batchId: "batch1",
          batchSize: 2,
          mode: "template",
          approved: false,
          template: spec,
        },
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

    // A per-item spawn carrying an approved batch template (with a narrower
    // outboundScope) that WIDENS the scope must be denied before the policy runs.
    expect(
      await gate.evaluate(
        { agentId: "x", input: "hi", outboundScope: ["repo", "network"] },
        {
          parentRunId: "run-1",
          depth: 0,
          batch: {
            batchId: "batch1",
            batchSize: 1,
            mode: "template",
            approved: true,
            template: { agentId: "x", input: "batch", outboundScope: ["repo"] },
          },
        },
        "subagent:t1",
      ),
    ).toEqual({
      outcome: "denied",
      reason: "batch_scope_widened: outboundScope",
    });
    expect(policyCalls).toBe(0);
  });
});

describe("SpawnGate.awaitApproval with InterruptOutcome", () => {
  it("returns a granted InterruptOutcome when the gate resolves", async () => {
    const fakeGate: SpawnApprovalGate = {
      async waitForInterrupt(): Promise<InterruptOutcome> {
        return { decision: "granted", response: { note: "ok" } };
      },
    };
    const spawnGate = new SpawnGate(allowAllSpawnPolicy, fakeGate);

    const outcome = await spawnGate.awaitApproval("run-1", "approval-1");
    expect(outcome).toEqual({ decision: "granted", response: { note: "ok" } });
  });

  it("returns a rejected InterruptOutcome when the gate rejects", async () => {
    const fakeGate: SpawnApprovalGate = {
      async waitForInterrupt(): Promise<InterruptOutcome> {
        return { decision: "rejected", reason: "denied by operator" };
      },
    };
    const spawnGate = new SpawnGate(allowAllSpawnPolicy, fakeGate);

    const outcome = await spawnGate.awaitApproval("run-1", "approval-2");
    expect(outcome).toEqual({
      decision: "rejected",
      reason: "denied by operator",
    });
  });

  it("returns a rejected InterruptOutcome when no gate is configured", async () => {
    const spawnGate = new SpawnGate(allowAllSpawnPolicy, undefined);

    const outcome = await spawnGate.awaitApproval("run-1", "approval-3");
    expect(outcome).toEqual({
      decision: "rejected",
      reason: "approval_required_but_no_gate_configured",
    });
  });
});
