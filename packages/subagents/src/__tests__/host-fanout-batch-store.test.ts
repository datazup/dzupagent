import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import {
  HostFanoutBatchStore,
  recoverFanoutReport,
} from "../store/host-fanout-batch-store.js";

describe("HostFanoutBatchStore", () => {
  it("recovers and resumes a running batch by batchId across store instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dzupagent-fanout-"));
    try {
      const first = new HostFanoutBatchStore({ directory: dir });
      await first.create({
        batchId: "batch/1",
        parentRunId: "run-1",
        mode: "template",
        declared: ["a", "b"],
        startedAt: 10,
      });
      await first.recordItem("batch/1", "a", {
        taskId: "task-a",
        status: "succeeded",
        result: { output: "done", usage: { outputTokens: 3 } },
        outputTokens: 3,
        durationMs: 15,
        updatedAt: 25,
      });

      const recovered = await recoverFanoutReport(
        new HostFanoutBatchStore({ directory: dir }),
        "batch/1"
      );
      expect(recovered).toMatchObject({
        batchId: "batch/1",
        declared: 2,
        dispatched: 1,
        uncovered: ["b"],
        settled: { succeeded: 1 },
        budget: { wallClockMs: 15, aborted: false },
      });

      const resumed = new HostFanoutBatchStore({ directory: dir });
      await resumed.create({
        batchId: "batch/1",
        parentRunId: "run-1",
        mode: "template",
        declared: ["a", "b"],
        startedAt: 10,
      });
      await resumed.recordItem("batch/1", "b", {
        taskId: "task-b",
        status: "failed",
        error: "boom",
        durationMs: 5,
        updatedAt: 30,
      });
      await resumed.complete("batch/1", {
        status: "completed",
        completedAt: 35,
        wallClockMs: 25,
        outputTokensUsed: 3,
      });

      expect(await recoverFanoutReport(first, "batch/1")).toMatchObject({
        batchId: "batch/1",
        declared: 2,
        dispatched: 2,
        uncovered: [],
        settled: { succeeded: 1, failed: 1 },
        budget: { outputTokensUsed: 3, wallClockMs: 25, aborted: false },
        items: [
          { key: "a", taskId: "task-a", status: "succeeded" },
          { key: "b", taskId: "task-b", status: "failed", error: "boom" },
        ],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves budget-aborted completion metadata for report recovery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dzupagent-fanout-"));
    try {
      const store = new HostFanoutBatchStore({ directory: dir });
      await store.create({
        batchId: "budgeted",
        parentRunId: "run-1",
        mode: "template",
        declared: ["a", "b"],
        startedAt: 100,
      });
      await store.recordItem("budgeted", "a", {
        taskId: "task-a",
        status: "succeeded",
        outputTokens: 10,
        updatedAt: 125,
      });
      await store.recordItem("budgeted", "b", {
        status: "aborted_budget",
        error: "max_total_output_tokens_exceeded",
        updatedAt: 126,
      });
      await store.complete("budgeted", {
        status: "aborted",
        completedAt: 130,
        wallClockMs: 30,
        outputTokensUsed: 10,
        abortedReason: "max_total_output_tokens_exceeded",
        budgetAborted: true,
      });

      expect(
        await recoverFanoutReport(
          new HostFanoutBatchStore({ directory: dir }),
          "budgeted"
        )
      ).toMatchObject({
        batchId: "budgeted",
        settled: { succeeded: 1, aborted_budget: 1 },
        uncovered: [],
        budget: {
          outputTokensUsed: 10,
          wallClockMs: 30,
          aborted: true,
          abortedReason: "max_total_output_tokens_exceeded",
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("attributes the executing provider in recovered report items", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dzupagent-fanout-"));
    try {
      const store = new HostFanoutBatchStore({ directory: dir });
      await store.create({
        batchId: "attr",
        parentRunId: "run-1",
        mode: "template",
        declared: ["a"],
        startedAt: 1,
      });
      await store.recordItem("attr", "a", {
        taskId: "task-a",
        status: "succeeded",
        provider: "codex",
        updatedAt: 2,
      });

      const recovered = await recoverFanoutReport(
        new HostFanoutBatchStore({ directory: dir }),
        "attr"
      );
      expect(recovered?.items[0]).toMatchObject({
        key: "a",
        status: "succeeded",
        provider: "codex",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
