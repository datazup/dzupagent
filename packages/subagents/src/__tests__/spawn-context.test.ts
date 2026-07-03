import { describe, it, expect, vi } from "vitest";
import { SpawnGate } from "../governance/spawn-gate.js";
import type { SpawnContext, SpawnPolicy } from "../governance/spawn-gate.js";
import type { SubagentSpec } from "../contracts/background-task.js";
import { createInProcessSubagentRuntime } from "../runtime/create-runtime.js";
import { DEFAULT_LIFECYCLE_POLICY } from "../runtime/runtime-config.js";
import { allowAllSpawnPolicy } from "../governance/spawn-gate.js";
import {
  ControllableExecutor,
  RecordingEventSink,
  RecordingGovernanceSink,
  flush,
  sequentialIds,
} from "./helpers.js";

const spec: SubagentSpec = { agentId: "x", input: "hi" };

describe("SpawnGate context dispatch rule (Spec 03 §2 / AC4)", () => {
  it("calls checkWithContext with the full SpawnContext when defined", async () => {
    const checkWithContext = vi.fn(() => ({
      allow: true as const,
      requiresApproval: false,
    }));
    const check = vi.fn(() => ({ allow: true as const, requiresApproval: false }));
    const gate = new SpawnGate({ check, checkWithContext });
    const ctx: SpawnContext = {
      parentRunId: "run-9",
      depth: 1,
      originTaskId: "t-parent",
      batch: {
        batchId: "b1",
        batchSize: 10,
        mode: "template",
        approved: false,
      },
    };
    expect(await gate.evaluate(spec, ctx, "a")).toEqual({
      outcome: "allowed",
    });
    expect(checkWithContext).toHaveBeenCalledWith(spec, ctx);
    expect(check).not.toHaveBeenCalled();
  });

  it("calls legacy check with a plain string even when given a context", async () => {
    const received: unknown[] = [];
    const policy: SpawnPolicy = {
      check: (_spec, parentRunId) => {
        received.push(parentRunId);
        // A legacy policy operating on the string — throws if handed an object.
        return parentRunId.startsWith("run-")
          ? { allow: true, requiresApproval: false }
          : { allow: false, reason: "wrong_run_prefix" };
      },
    };
    const gate = new SpawnGate(policy);
    const ctx: SpawnContext = { parentRunId: "run-7", depth: 1 };
    expect(await gate.evaluate(spec, ctx, "a")).toEqual({
      outcome: "allowed",
    });
    expect(received).toEqual(["run-7"]);
  });

  it("keeps the plain-string evaluate signature working (backward compat)", async () => {
    const gate = new SpawnGate(allowAllSpawnPolicy);
    expect(await gate.evaluate(spec, "r", "a")).toEqual({
      outcome: "allowed",
    });
  });
});

describe("structural depth bound (Spec 03 FR7 / AC3)", () => {
  function setup(maxSpawnDepth?: number) {
    const check = vi.fn(() => ({ allow: true as const, requiresApproval: false }));
    const checkWithContext = vi.fn(() => ({
      allow: true as const,
      requiresApproval: false,
    }));
    const events = new RecordingEventSink();
    const governance = new RecordingGovernanceSink();
    const executor = new ControllableExecutor("instant");
    const runtime = createInProcessSubagentRuntime({
      executor,
      events,
      governance,
      generateId: sequentialIds(),
      policy: { check, checkWithContext },
      ...(maxSpawnDepth !== undefined
        ? { lifecyclePolicy: { maxSpawnDepth } }
        : {}),
    });
    return { runtime, check, checkWithContext, events, governance, executor };
  }

  it("defaults maxSpawnDepth to 2", () => {
    expect(DEFAULT_LIFECYCLE_POLICY.maxSpawnDepth).toBe(2);
  });

  it("rejects depth >= maxSpawnDepth BEFORE any policy call", async () => {
    const { runtime, check, checkWithContext, governance } = setup();
    const outcome = await runtime.spawn(spec, "run-1", { depth: 2 });
    expect(outcome).toEqual({
      ok: false,
      reason: "denied",
      detail: "max_spawn_depth_exceeded",
    });
    // Structural, not policy-overridable: zero policy invocations.
    expect(check).not.toHaveBeenCalled();
    expect(checkWithContext).not.toHaveBeenCalled();
    expect(governance.types()).toContain("governance:rule_violation");
    // No task persisted for over-depth spawns.
    expect(await runtime.list("run-1")).toEqual([]);
  });

  it("admits spawns below the bound and persists depth + batchId", async () => {
    const { runtime, events } = setup();
    const outcome = await runtime.spawn(spec, "run-1", {
      depth: 1,
      batchId: "b1",
    });
    expect(outcome.ok).toBe(true);
    await flush();
    const [task] = await runtime.list("run-1");
    expect(task).toMatchObject({ depth: 1, batchId: "b1" });
    const spawned = events.events.find((e) => e.type === "subagent:spawned");
    expect(spawned).toMatchObject({ depth: 1, batchId: "b1" });
  });

  it("honours a custom maxSpawnDepth", async () => {
    const { runtime, check } = setup(1);
    expect(await runtime.spawn(spec, "run-1", { depth: 1 })).toEqual({
      ok: false,
      reason: "denied",
      detail: "max_spawn_depth_exceeded",
    });
    expect(check).not.toHaveBeenCalled();
    const ok = await runtime.spawn(spec, "run-1", { depth: 0 });
    expect(ok.ok).toBe(true);
  });

  it("defaults depth to 0 for legacy spawn calls", async () => {
    const { runtime, executor } = setup();
    const outcome = await runtime.spawn(spec, "run-1");
    expect(outcome.ok).toBe(true);
    await flush();
    const [task] = await runtime.list("run-1");
    expect(task?.depth).toBe(0);
    expect(task?.batchId).toBeUndefined();
    expect(executor.runCalls).toHaveLength(1);
  });
});
