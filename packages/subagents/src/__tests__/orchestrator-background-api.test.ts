import { describe, it, expect } from "vitest";
import { OrchestratorBackgroundApi } from "../api/orchestrator-background-api.js";
import { allowAllSpawnPolicy } from "../governance/spawn-gate.js";
import { createInProcessSubagentRuntime } from "../runtime/create-runtime.js";
import { InMemoryFanoutBatchStore } from "../store/in-memory-fanout-batch-store.js";
import {
  ControllableExecutor,
  RecordingEventSink,
  sequentialIds,
} from "./helpers.js";

describe("OrchestratorBackgroundApi", () => {
  it("reconstructs fanout reports by batchId when configured with a batch store", async () => {
    const fanoutBatchStore = new InMemoryFanoutBatchStore();
    const runtime = createInProcessSubagentRuntime({
      executor: new ControllableExecutor(),
      events: new RecordingEventSink(),
      generateId: sequentialIds(),
      policy: allowAllSpawnPolicy,
    });
    const api = new OrchestratorBackgroundApi(runtime, { fanoutBatchStore });

    await fanoutBatchStore.create({
      batchId: "batch1",
      parentRunId: "run-1",
      mode: "template",
      declared: ["a", "b"],
      startedAt: 10,
    });
    await fanoutBatchStore.recordItem("batch1", "a", {
      taskId: "t1",
      status: "succeeded",
      result: { output: "done" },
      updatedAt: 20,
    });

    await expect(api.getFanoutReport("batch1")).resolves.toMatchObject({
      batchId: "batch1",
      declared: 2,
      dispatched: 1,
      uncovered: ["b"],
      settled: { succeeded: 1 },
      items: [
        { key: "a", taskId: "t1", status: "succeeded" },
        { key: "b", status: "never_dispatched" },
      ],
      budget: { wallClockMs: 10, aborted: false },
    });
    await expect(api.getFanoutReport("missing")).resolves.toBeNull();
  });

  it("returns null when no batch store is configured", async () => {
    const runtime = createInProcessSubagentRuntime({
      executor: new ControllableExecutor(),
      events: new RecordingEventSink(),
      generateId: sequentialIds(),
      policy: allowAllSpawnPolicy,
    });
    const api = new OrchestratorBackgroundApi(runtime);
    await expect(api.getFanoutReport("anything")).resolves.toBeNull();
  });
});
