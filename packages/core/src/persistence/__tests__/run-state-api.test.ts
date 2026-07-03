import { describe, it, expect } from "vitest";
import { createRunStateApi } from "../run-state-api.js";
import { InMemoryRunStateStore } from "../in-memory-run-state-store.js";
import { InMemoryRunJournal } from "../in-memory-run-journal.js";

describe("RunStateApi", () => {
  it("getState returns undefined for an unknown run", async () => {
    const runStateStore = new InMemoryRunStateStore();
    const runJournal = new InMemoryRunJournal();
    const api = createRunStateApi({ runStateStore, runJournal });

    const result = await api.getState("unknown-run-id");
    expect(result).toBeUndefined();
  });

  it("getState returns the snapshot when runStateStore has one", async () => {
    const runStateStore = new InMemoryRunStateStore();
    const runJournal = new InMemoryRunJournal();
    const api = createRunStateApi({ runStateStore, runJournal });

    const state = {
      version: 1 as const,
      runId: "run-1",
      agentId: "agent-1",
      messages: [],
      iteration: 3,
      cumulativeUsage: [],
      snapshotAt: 1700000000000,
    };
    await runStateStore.save(state);

    const result = await api.getState("run-1");
    expect(result).toEqual({
      runId: "run-1",
      seq: 3,
      state,
      capturedAt: 1700000000000,
    });
  });

  it("getStateHistory returns journal entries mapped to summaries", async () => {
    const runStateStore = new InMemoryRunStateStore();
    const runJournal = new InMemoryRunJournal();
    const api = createRunStateApi({ runStateStore, runJournal });

    await runJournal.append("run-2", {
      type: "run_started",
      data: { input: "test input" },
    });
    await runJournal.append("run-2", {
      type: "run_paused",
      data: { reason: "cooperative" },
    });

    const page = await api.getStateHistory("run-2");
    expect(page.runId).toBe("run-2");
    expect(page.entries).toHaveLength(2);
    expect(page.entries[1]?.summary).toBe("paused (cooperative)");
  });
});
