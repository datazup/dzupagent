import { describe, it, expect } from "vitest";
import { createSubagentTools } from "../tools/subagent-tools.js";
import { createInProcessSubagentRuntime } from "../runtime/create-runtime.js";
import { allowAllSpawnPolicy } from "../governance/spawn-gate.js";
import {
  ControllableExecutor,
  RecordingEventSink,
  sequentialIds,
  flush,
} from "./helpers.js";

function setup() {
  const events = new RecordingEventSink();
  const executor = new ControllableExecutor("manual");
  const runtime = createInProcessSubagentRuntime({
    executor,
    events,
    generateId: sequentialIds(),
    // Base runtime now denies spawns by default (AGENT-H-03); this suite exercises
    // tool mechanics, not governance, so opt into the test-only allow-all policy.
    policy: allowAllSpawnPolicy,
  });
  const tools = createSubagentTools({
    runtime,
    resolveParentRunId: () => "run-1",
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { runtime, executor, tools, byName };
}

/** Build a second tool-set bound to a different parent run over the same runtime. */
function toolsForRun(
  runtime: ReturnType<typeof createInProcessSubagentRuntime>,
  parentRunId: string,
) {
  const tools = createSubagentTools({
    runtime,
    resolveParentRunId: () => parentRunId,
  });
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

describe("subagent tools", () => {
  it("exposes the five expected tools", () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "await_subagent",
      "cancel_subagent",
      "check_subagent",
      "fanout_template",
      "spawn_subagent",
    ]);
  });

  it("spawn → check → await round-trip", async () => {
    const { executor, byName } = setup();
    const spawned = (await byName.spawn_subagent!.invoke({
      agentId: "x",
      input: "go",
    })) as { ok: boolean; taskId: string };
    expect(spawned.ok).toBe(true);
    await flush();

    const checked = (await byName.check_subagent!.invoke({
      taskId: spawned.taskId,
    })) as {
      found: boolean;
      status: string;
    };
    expect(checked).toMatchObject({ found: true, status: "running" });

    executor.complete(spawned.taskId, { output: "done" });
    const awaited = (await byName.await_subagent!.invoke({
      taskId: spawned.taskId,
      timeoutMs: 1000,
    })) as { status: string; result: unknown };
    expect(awaited).toMatchObject({
      status: "succeeded",
      result: { output: "done" },
    });
  });

  it("check reports not found for unknown task", async () => {
    const { byName } = setup();
    expect(await byName.check_subagent!.invoke({ taskId: "ghost" })).toEqual({
      found: false,
    });
  });

  it("cancel stops a running task", async () => {
    const { byName } = setup();
    const spawned = (await byName.spawn_subagent!.invoke({
      agentId: "x",
      input: "go",
    })) as { taskId: string };
    await flush();
    const cancelled = (await byName.cancel_subagent!.invoke({
      taskId: spawned.taskId,
    })) as { status: string };
    expect(cancelled.status).toBe("cancelled");
  });

  // ── SEC-M-04: cross-run task IDOR ──────────────────────────────────
  describe("ownership isolation (SEC-M-04)", () => {
    it("a foreign run cannot check, await, or cancel another run's task", async () => {
      const { runtime, executor, byName } = setup(); // owner = run-1
      const foreign = toolsForRun(runtime, "run-2");

      const spawned = (await byName.spawn_subagent!.invoke({
        agentId: "x",
        input: "go",
      })) as { ok: boolean; taskId: string };
      expect(spawned.ok).toBe(true);
      await flush();

      // run-2 must not be able to read run-1's task.
      expect(
        await foreign.check_subagent!.invoke({ taskId: spawned.taskId }),
      ).toEqual({ found: false });

      // run-2 must not be able to await it (resolves as not-found immediately).
      expect(
        await foreign.await_subagent!.invoke({
          taskId: spawned.taskId,
          timeoutMs: 50,
        }),
      ).toEqual({ found: false });

      // run-2's cancel must be a no-op — the task keeps running.
      expect(
        await foreign.cancel_subagent!.invoke({ taskId: spawned.taskId }),
      ).toEqual({ status: "not_found" });
      const stillOwned = (await byName.check_subagent!.invoke({
        taskId: spawned.taskId,
      })) as { found: boolean; status: string };
      expect(stillOwned).toMatchObject({ found: true, status: "running" });

      // The legitimate owner still has full access.
      executor.complete(spawned.taskId, { output: "done" });
      const awaited = (await byName.await_subagent!.invoke({
        taskId: spawned.taskId,
        timeoutMs: 1000,
      })) as { status: string; result: unknown };
      expect(awaited).toMatchObject({
        status: "succeeded",
        result: { output: "done" },
      });
    });
  });
});
