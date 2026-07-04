import { describe, it, expect } from "vitest";
import { InMemoryFanoutBatchStore } from "../store/in-memory-fanout-batch-store.js";
import { fanoutBatchRecordToReport } from "../tools/fanout-tool.js";

describe("InMemoryFanoutBatchStore", () => {
  it("initializes every declared key and returns cloned records", async () => {
    const store = new InMemoryFanoutBatchStore();

    await store.create({
      batchId: "batch1",
      parentRunId: "run-1",
      mode: "template",
      declared: ["a", "b"],
      startedAt: 10,
    });

    const record = await store.get("batch1");
    expect(record).toMatchObject({
      batchId: "batch1",
      parentRunId: "run-1",
      mode: "template",
      status: "running",
      declared: ["a", "b"],
      items: [
        { key: "a", status: "never_dispatched", updatedAt: 10 },
        { key: "b", status: "never_dispatched", updatedAt: 10 },
      ],
    });

    record!.items[0]!.status = "succeeded";
    expect((await store.get("batch1"))!.items[0]!.status).toBe(
      "never_dispatched",
    );
  });

  it("records item progress idempotently and reconstructs a report", async () => {
    const store = new InMemoryFanoutBatchStore();

    await store.create({
      batchId: "batch1",
      parentRunId: "run-1",
      mode: "template",
      declared: ["a", "b"],
      startedAt: 10,
    });
    await store.recordItem("batch1", "a", {
      taskId: "t1",
      status: "running",
      updatedAt: 20,
    });
    await store.recordItem("batch1", "a", {
      status: "succeeded",
      result: { output: "done", usage: { outputTokens: 4 } },
      durationMs: 8,
      outputTokens: 4,
      updatedAt: 30,
    });
    await store.complete("batch1", {
      status: "completed",
      completedAt: 40,
      wallClockMs: 30,
    });

    const record = await store.get("batch1");
    expect(record).toMatchObject({
      status: "completed",
      items: [
        {
          key: "a",
          taskId: "t1",
          status: "succeeded",
          result: { output: "done", usage: { outputTokens: 4 } },
          outputTokens: 4,
        },
        { key: "b", status: "never_dispatched" },
      ],
    });

    expect(fanoutBatchRecordToReport(record!)).toMatchObject({
      batchId: "batch1",
      declared: 2,
      dispatched: 1,
      uncovered: ["b"],
      settled: { succeeded: 1, failed: 0 },
      items: [
        { key: "a", taskId: "t1", status: "succeeded" },
        { key: "b", status: "never_dispatched" },
      ],
      budget: { wallClockMs: 30, aborted: false },
    });
  });

  it("rejects item records for undeclared keys", async () => {
    const store = new InMemoryFanoutBatchStore();

    await store.create({
      batchId: "batch1",
      parentRunId: "run-1",
      mode: "template",
      declared: ["a"],
      startedAt: 10,
    });

    await expect(
      store.recordItem("batch1", "missing", {
        status: "failed",
        error: "no such key",
        updatedAt: 20,
      }),
    ).rejects.toThrow('fanout batch "batch1" has no item "missing"');
  });
});
