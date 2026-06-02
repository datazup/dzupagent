import { describe, it, expect } from "vitest";
import { createSubagentTools } from "../tools/subagent-tools.js";
import { createInProcessSubagentRuntime } from "../runtime/create-runtime.js";
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
  });
  const tools = createSubagentTools({
    runtime,
    resolveParentRunId: () => "run-1",
  });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { runtime, executor, tools, byName };
}

describe("subagent tools", () => {
  it("exposes the four expected tools", () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "await_subagent",
      "cancel_subagent",
      "check_subagent",
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
});
