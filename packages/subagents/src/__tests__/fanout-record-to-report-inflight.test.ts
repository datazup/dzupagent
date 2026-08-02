/**
 * A ledger rebuilt mid-batch must not look like a clean run.
 *
 * `fanoutBatchRecordToReport` exists so a host can reconstruct the report
 * after the coordinator that ran the batch is gone. `FanoutBatchItemStatus`
 * includes the whole of `TaskStatus`, so a persisted item can legitimately be
 * `queued`, `awaiting_approval`, or `running` at that moment.
 *
 * Those three used to fall through the switch's `default` arm: they were
 * counted in `dispatched` but landed in neither `settled` nor `uncovered`.
 * Since `uncovered: []` is the documented clean-run signal, a supervisor
 * recovering a crashed batch saw "nothing left to do" while items were still
 * in flight. These tests pin the distinction.
 */
import { describe, it, expect } from "vitest";
import { InMemoryFanoutBatchStore } from "../store/in-memory-fanout-batch-store.js";
import { fanoutBatchRecordToReport } from "../tools/fanout-tool.js";

async function seedBatch() {
  const store = new InMemoryFanoutBatchStore();
  await store.create({
    batchId: "batch-crash",
    parentRunId: "run-1",
    mode: "template",
    declared: ["done", "inflight", "untouched"],
    startedAt: 10,
  });
  return store;
}

describe("fanoutBatchRecordToReport — non-terminal items", () => {
  it("reports a still-running item as inFlight, not as a clean run", async () => {
    const store = await seedBatch();
    await store.recordItem("batch-crash", "done", {
      status: "succeeded",
      taskId: "t1",
      updatedAt: 20,
    });
    // The coordinator died here: this item was dispatched and never settled.
    await store.recordItem("batch-crash", "inflight", {
      status: "running",
      taskId: "t2",
      updatedAt: 25,
    });

    const record = await store.get("batch-crash");
    const report = fanoutBatchRecordToReport(record!);

    // The regression: 'inflight' was dispatched, so it is NOT uncovered...
    expect(report.uncovered).toEqual(["untouched"]);
    // ...and it has no outcome, so it must not be counted as settled.
    expect(report.settled).toMatchObject({
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      expired: 0,
      denied: 0,
      aborted_budget: 0,
    });
    // Previously this item vanished from every aggregate.
    expect(report.inFlight).toEqual(["inflight"]);

    // A caller must be able to tell this from a finished batch.
    const accountedFor =
      Object.values(report.settled).reduce((a, b) => a + b, 0) +
      report.uncovered.length +
      report.inFlight.length;
    expect(accountedFor).toBe(report.declared);
  });

  it("counts queued and awaiting_approval as in flight too", async () => {
    const store = await seedBatch();
    await store.recordItem("batch-crash", "done", {
      status: "queued",
      taskId: "t1",
      updatedAt: 20,
    });
    await store.recordItem("batch-crash", "inflight", {
      status: "awaiting_approval",
      taskId: "t2",
      updatedAt: 25,
    });

    const record = await store.get("batch-crash");
    const report = fanoutBatchRecordToReport(record!);

    expect(report.inFlight).toEqual(["done", "inflight"]);
    expect(report.uncovered).toEqual(["untouched"]);
  });

  it("leaves inFlight empty for a fully settled batch", async () => {
    const store = await seedBatch();
    for (const [key, taskId] of [
      ["done", "t1"],
      ["inflight", "t2"],
      ["untouched", "t3"],
    ] as const) {
      await store.recordItem("batch-crash", key, {
        status: "succeeded",
        taskId,
        updatedAt: 30,
      });
    }

    const record = await store.get("batch-crash");
    const report = fanoutBatchRecordToReport(record!);

    expect(report.inFlight).toEqual([]);
    expect(report.uncovered).toEqual([]);
    expect(report.settled.succeeded).toBe(3);
  });
});
