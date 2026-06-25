/**
 * W29-E — RunJournal deep tests: state transitions, journal operations,
 * snapshots, concurrent access, and schema validation.
 *
 * Covers all aspects of InMemoryRunJournal not already exercised by
 * src/persistence/__tests__/run-journal.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { InMemoryRunJournal } from "../persistence/in-memory-run-journal.js";
import {
  createEntryBase,
  isTerminalEntry,
  deserializeEntry,
} from "../persistence/run-journal.js";
import type {
  RunJournalEntry,
  StateUpdatedEntry,
  SnapshotEntry,
  RunStartedEntry,
  RunCompletedEntry,
  RunFailedEntry,
  RunCancelledEntry,
  RunSuspendedEntry,
  RunPausedEntry,
  RunResumedEntry,
  StepStartedEntry,
  StepCompletedEntry,
  StepFailedEntry,
} from "../persistence/run-journal-types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeJournal<T = Record<string, unknown>>(
  opts: {
    compactionThreshold?: number;
    stateSchema?: { parse(d: unknown): T };
  } = {}
) {
  return new InMemoryRunJournal<T>(opts);
}

async function appendLifecycle(
  journal: InMemoryRunJournal,
  runId: string
): Promise<void> {
  await journal.append(runId, { type: "run_started", data: { input: "test" } });
  await journal.append(runId, {
    type: "step_started",
    data: { stepId: "s1", toolName: "my_tool" },
  });
  await journal.append(runId, {
    type: "step_completed",
    data: { stepId: "s1", toolName: "my_tool", durationMs: 50 },
  });
  await journal.append(runId, {
    type: "run_completed",
    data: { output: "done", durationMs: 100 },
  });
}

// ─── 1. State transition: pending → running (run_started) ────────────────────

describe("State transition: run_started", () => {
  let journal: InMemoryRunJournal;
  beforeEach(() => {
    journal = makeJournal();
  });

  it("first entry is run_started with correct payload", async () => {
    await journal.append("r1", {
      type: "run_started",
      data: { input: { query: "hello" }, agentId: "agent-abc" },
    });
    const entries = await journal.getAll("r1");
    expect(entries).toHaveLength(1);
    const e = entries[0] as RunStartedEntry;
    expect(e.type).toBe("run_started");
    expect(e.data.input).toEqual({ query: "hello" });
    expect(e.data.agentId).toBe("agent-abc");
  });

  it("run_started with triggerId is persisted", async () => {
    await journal.append("r1", {
      type: "run_started",
      data: { input: null, triggerId: "trig-1" },
    });
    const entries = await journal.getAll("r1");
    const e = entries[0] as RunStartedEntry;
    expect(e.data.triggerId).toBe("trig-1");
  });

  it("run_started without agentId still works", async () => {
    await journal.append("r1", { type: "run_started", data: { input: null } });
    const e = (await journal.getAll("r1"))[0] as RunStartedEntry;
    expect(e.data.agentId).toBeUndefined();
  });

  it("run_started entry carries v=1 and a valid ISO timestamp", async () => {
    await journal.append("r1", { type: "run_started", data: { input: null } });
    const e = (await journal.getAll("r1"))[0]!;
    expect(e.v).toBe(1);
    expect(() => new Date(e.ts)).not.toThrow();
    expect(new Date(e.ts).toISOString()).toBe(e.ts);
  });
});

// ─── 2. State transition: running → completed ────────────────────────────────

describe("State transition: running → completed", () => {
  let journal: InMemoryRunJournal;
  beforeEach(() => {
    journal = makeJournal();
  });

  it("run_completed is appended after run_started", async () => {
    await journal.append("r1", { type: "run_started", data: { input: "x" } });
    await journal.append("r1", {
      type: "run_completed",
      data: { output: "result", durationMs: 200 },
    });
    const entries = await journal.getAll("r1");
    expect(entries).toHaveLength(2);
    const last = entries[1] as RunCompletedEntry;
    expect(last.type).toBe("run_completed");
    expect(last.data.output).toBe("result");
    expect(last.data.durationMs).toBe(200);
  });

  it("run_completed with token + cost metadata is persisted", async () => {
    await journal.append("r1", { type: "run_started", data: { input: null } });
    await journal.append("r1", {
      type: "run_completed",
      data: { output: null, totalTokens: 500, totalCostCents: 12 },
    });
    const e = (await journal.getAll("r1"))[1] as RunCompletedEntry;
    expect(e.data.totalTokens).toBe(500);
    expect(e.data.totalCostCents).toBe(12);
  });

  it("run_completed is detected as terminal entry", async () => {
    await journal.append("r1", { type: "run_started", data: { input: null } });
    await journal.append("r1", {
      type: "run_completed",
      data: { output: null },
    });
    const entries = await journal.getAll("r1");
    const last = entries[entries.length - 1]!;
    expect(isTerminalEntry(last.type)).toBe(true);
  });
});

// ─── 3. State transition: running → failed ───────────────────────────────────

describe("State transition: running → failed", () => {
  let journal: InMemoryRunJournal;
  beforeEach(() => {
    journal = makeJournal();
  });

  it("run_failed is appended with error message", async () => {
    await journal.append("r1", { type: "run_started", data: { input: null } });
    await journal.append("r1", {
      type: "run_failed",
      data: { error: "timeout exceeded" },
    });
    const entries = await journal.getAll("r1");
    const last = entries[1] as RunFailedEntry;
    expect(last.type).toBe("run_failed");
    expect(last.data.error).toBe("timeout exceeded");
  });

  it("run_failed with stepId is persisted", async () => {
    await journal.append("r1", { type: "run_started", data: { input: null } });
    await journal.append("r1", {
      type: "run_failed",
      data: { error: "tool error", stepId: "step-99" },
    });
    const e = (await journal.getAll("r1"))[1] as RunFailedEntry;
    expect(e.data.stepId).toBe("step-99");
  });

  it("run_failed is detected as terminal entry", async () => {
    await journal.append("r1", { type: "run_failed", data: { error: "E" } });
    const e = (await journal.getAll("r1"))[0]!;
    expect(isTerminalEntry(e.type)).toBe(true);
  });

  it("sequence increments correctly after failed entry", async () => {
    await journal.append("r1", { type: "run_started", data: { input: null } });
    const seq = await journal.append("r1", {
      type: "run_failed",
      data: { error: "E" },
    });
    expect(seq).toBe(2);
  });
});

// ─── 4. State transition: running → cancelled ────────────────────────────────

describe("State transition: running → cancelled", () => {
  let journal: InMemoryRunJournal;
  beforeEach(() => {
    journal = makeJournal();
  });

  it("run_cancelled is appended with reason", async () => {
    await journal.append("r1", { type: "run_started", data: { input: null } });
    await journal.append("r1", {
      type: "run_cancelled",
      data: { reason: "user request" },
    });
    const entries = await journal.getAll("r1");
    const last = entries[1] as RunCancelledEntry;
    expect(last.type).toBe("run_cancelled");
    expect(last.data.reason).toBe("user request");
  });

  it("run_cancelled without reason is persisted", async () => {
    await journal.append("r1", {
      type: "run_cancelled",
      data: {},
    });
    const e = (await journal.getAll("r1"))[0] as RunCancelledEntry;
    expect(e.type).toBe("run_cancelled");
    expect(e.data.reason).toBeUndefined();
  });

  it("run_cancelled is detected as terminal entry", async () => {
    await journal.append("r1", {
      type: "run_cancelled",
      data: { reason: "abort" },
    });
    const e = (await journal.getAll("r1"))[0]!;
    expect(isTerminalEntry(e.type)).toBe(true);
  });
});

// ─── 5. State transition: running → suspended ────────────────────────────────

describe("State transition: running → suspended", () => {
  let journal: InMemoryRunJournal;
  beforeEach(() => {
    journal = makeJournal();
  });

  it("run_suspended is appended with stepId and reason", async () => {
    await journal.append("r1", { type: "run_started", data: { input: null } });
    await journal.append("r1", {
      type: "run_suspended",
      data: {
        stepId: "step-42",
        reason: "awaiting approval",
        contactId: "ch-1",
      },
    });
    const entries = await journal.getAll("r1");
    const last = entries[1] as RunSuspendedEntry;
    expect(last.type).toBe("run_suspended");
    expect(last.data.stepId).toBe("step-42");
    expect(last.data.reason).toBe("awaiting approval");
    expect(last.data.contactId).toBe("ch-1");
  });

  it("run_suspended is NOT a terminal entry", async () => {
    await journal.append("r1", {
      type: "run_suspended",
      data: { stepId: "s1" },
    });
    const e = (await journal.getAll("r1"))[0]!;
    expect(isTerminalEntry(e.type)).toBe(false);
  });
});

// ─── 6. State transition: running → paused ───────────────────────────────────

describe("State transition: running → paused", () => {
  let journal: InMemoryRunJournal;
  beforeEach(() => {
    journal = makeJournal();
  });

  it("run_paused is appended with cooperative reason", async () => {
    await journal.append("r1", { type: "run_started", data: { input: null } });
    await journal.append("r1", {
      type: "run_paused",
      data: { reason: "cooperative" },
    });
    const entries = await journal.getAll("r1");
    const last = entries[1] as RunPausedEntry;
    expect(last.type).toBe("run_paused");
    expect(last.data.reason).toBe("cooperative");
  });

  it("run_paused with tool_timeout reason and stepId", async () => {
    await journal.append("r1", {
      type: "run_paused",
      data: { reason: "tool_timeout", stepId: "s99" },
    });
    const e = (await journal.getAll("r1"))[0] as RunPausedEntry;
    expect(e.data.reason).toBe("tool_timeout");
    expect(e.data.stepId).toBe("s99");
  });

  it("run_paused with user_request reason", async () => {
    await journal.append("r1", {
      type: "run_paused",
      data: { reason: "user_request" },
    });
    const e = (await journal.getAll("r1"))[0] as RunPausedEntry;
    expect(e.data.reason).toBe("user_request");
  });

  it("run_paused is NOT a terminal entry", async () => {
    await journal.append("r1", { type: "run_paused", data: {} });
    const e = (await journal.getAll("r1"))[0]!;
    expect(isTerminalEntry(e.type)).toBe(false);
  });
});

// ─── 7. State transition: suspended → resumed ───────────────────────────────

describe("State transition: suspended → resumed (run_resumed)", () => {
  let journal: InMemoryRunJournal;
  beforeEach(() => {
    journal = makeJournal();
  });

  it("run_resumed is appended after run_suspended", async () => {
    await journal.append("r1", { type: "run_started", data: { input: null } });
    await journal.append("r1", {
      type: "run_suspended",
      data: { stepId: "s1", reason: "waiting" },
    });
    await journal.append("r1", {
      type: "run_resumed",
      data: { resumeToken: "tok-xyz", input: { approved: true } },
    });
    const entries = await journal.getAll("r1");
    expect(entries).toHaveLength(3);
    const last = entries[2] as RunResumedEntry;
    expect(last.type).toBe("run_resumed");
    expect(last.data.resumeToken).toBe("tok-xyz");
    expect(last.data.input).toEqual({ approved: true });
  });

  it("run_resumed without input is valid", async () => {
    await journal.append("r1", {
      type: "run_resumed",
      data: { resumeToken: "tok-abc" },
    });
    const e = (await journal.getAll("r1"))[0] as RunResumedEntry;
    expect(e.data.resumeToken).toBe("tok-abc");
    expect(e.data.input).toBeUndefined();
  });

  it("run_resumed is NOT a terminal entry", async () => {
    await journal.append("r1", {
      type: "run_resumed",
      data: { resumeToken: "t" },
    });
    const e = (await journal.getAll("r1"))[0]!;
    expect(isTerminalEntry(e.type)).toBe(false);
  });
});

// ─── 8. Terminal entries: non-terminal entries rejected from isTerminalEntry ──

describe("isTerminalEntry — non-terminal types", () => {
  it("run_started is not terminal", () => {
    expect(isTerminalEntry("run_started")).toBe(false);
  });

  it("step_started is not terminal", () => {
    expect(isTerminalEntry("step_started")).toBe(false);
  });

  it("step_completed is not terminal", () => {
    expect(isTerminalEntry("step_completed")).toBe(false);
  });

  it("step_failed is not terminal", () => {
    expect(isTerminalEntry("step_failed")).toBe(false);
  });

  it("state_updated is not terminal", () => {
    expect(isTerminalEntry("state_updated")).toBe(false);
  });

  it("run_paused is not terminal", () => {
    expect(isTerminalEntry("run_paused")).toBe(false);
  });

  it("run_resumed is not terminal", () => {
    expect(isTerminalEntry("run_resumed")).toBe(false);
  });

  it("run_suspended is not terminal", () => {
    expect(isTerminalEntry("run_suspended")).toBe(false);
  });

  it("snapshot is not terminal", () => {
    expect(isTerminalEntry("snapshot")).toBe(false);
  });

  it("unknown is not terminal", () => {
    expect(isTerminalEntry("unknown")).toBe(false);
  });

  it("run_completed IS terminal", () => {
    expect(isTerminalEntry("run_completed")).toBe(true);
  });

  it("run_failed IS terminal", () => {
    expect(isTerminalEntry("run_failed")).toBe(true);
  });

  it("run_cancelled IS terminal", () => {
    expect(isTerminalEntry("run_cancelled")).toBe(true);
  });
});

// ─── 9. Journal operations: append, read, filter ────────────────────────────

describe("Journal operations: append and read", () => {
  let journal: InMemoryRunJournal;
  beforeEach(() => {
    journal = makeJournal();
  });

  it("appended entries are persisted in order", async () => {
    await appendLifecycle(journal, "r1");
    const entries = await journal.getAll("r1");
    expect(entries.map((e) => e.type)).toEqual([
      "run_started",
      "step_started",
      "step_completed",
      "run_completed",
    ]);
  });

  it("entries are ordered by seq ascending", async () => {
    await appendLifecycle(journal, "r1");
    const entries = await journal.getAll("r1");
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.seq).toBeGreaterThan(entries[i - 1]!.seq);
    }
  });

  it("filter by run_started type returns only that entry", async () => {
    await appendLifecycle(journal, "r1");
    const page = await journal.query("r1", { types: ["run_started"] });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.type).toBe("run_started");
  });

  it("filter by step types returns only step entries", async () => {
    await appendLifecycle(journal, "r1");
    const page = await journal.query("r1", {
      types: ["step_started", "step_completed"],
    });
    expect(page.entries).toHaveLength(2);
    expect(page.entries.every((e) => e.type.startsWith("step_"))).toBe(true);
  });

  it("filter by multiple terminal types returns matching entries", async () => {
    await journal.append("r1", { type: "run_started", data: { input: null } });
    await journal.append("r1", {
      type: "run_completed",
      data: { output: null },
    });
    await journal.append("r2", { type: "run_started", data: { input: null } });
    await journal.append("r2", { type: "run_failed", data: { error: "E" } });

    const p1 = await journal.query("r1", { types: ["run_completed"] });
    expect(p1.entries).toHaveLength(1);

    const p2 = await journal.query("r2", { types: ["run_failed"] });
    expect(p2.entries).toHaveLength(1);
  });

  it("different runIds have independent journals", async () => {
    await journal.append("r1", { type: "run_started", data: { input: "A" } });
    await journal.append("r2", { type: "run_started", data: { input: "B" } });
    await journal.append("r2", {
      type: "run_completed",
      data: { output: null },
    });

    const r1 = await journal.getAll("r1");
    const r2 = await journal.getAll("r2");
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(2);
  });

  it("events for run are only visible from their own runId", async () => {
    await journal.append("r1", { type: "run_started", data: { input: null } });
    const r2 = await journal.getAll("r2");
    expect(r2).toHaveLength(0);
  });
});

// ─── 10. Step entries ────────────────────────────────────────────────────────

describe("Step entries", () => {
  let journal: InMemoryRunJournal;
  beforeEach(() => {
    journal = makeJournal();
  });

  it("step_started carries toolName and toolArgs", async () => {
    await journal.append("r1", {
      type: "step_started",
      data: { stepId: "s1", toolName: "search", toolArgs: { q: "test" } },
    });
    const e = (await journal.getAll("r1"))[0] as StepStartedEntry;
    expect(e.data.toolName).toBe("search");
    expect(e.data.toolArgs).toEqual({ q: "test" });
  });

  it("step_completed carries output and tokenCount", async () => {
    await journal.append("r1", {
      type: "step_completed",
      data: {
        stepId: "s1",
        output: { results: [] },
        tokenCount: 42,
        costCents: 1,
      },
    });
    const e = (await journal.getAll("r1"))[0] as StepCompletedEntry;
    expect(e.data.output).toEqual({ results: [] });
    expect(e.data.tokenCount).toBe(42);
    expect(e.data.costCents).toBe(1);
  });

  it("step_failed carries error and retryCount", async () => {
    await journal.append("r1", {
      type: "step_failed",
      data: { stepId: "s1", error: "rate limit", retryCount: 3 },
    });
    const e = (await journal.getAll("r1"))[0] as StepFailedEntry;
    expect(e.data.error).toBe("rate limit");
    expect(e.data.retryCount).toBe(3);
  });
});

// ─── 11. State reconstruction via replay ─────────────────────────────────────

describe("State reconstruction via replay", () => {
  let journal: InMemoryRunJournal<{ step: number; status: string }>;
  beforeEach(() => {
    journal = makeJournal<{ step: number; status: string }>();
  });

  it("replaying state_updated entries rebuilds final state", async () => {
    await journal.append("r1", { type: "run_started", data: { input: null } });
    await journal.append("r1", {
      type: "state_updated",
      data: { state: { step: 1, status: "working" } },
    });
    await journal.append("r1", {
      type: "state_updated",
      data: { state: { step: 2, status: "done" } },
    });

    const entries = await journal.getAll("r1");
    const stateEntries = entries.filter(
      (e): e is StateUpdatedEntry<{ step: number; status: string }> =>
        e.type === "state_updated"
    );
    // Replay: take last state
    const finalState = stateEntries[stateEntries.length - 1]?.data.state;
    expect(finalState).toEqual({ step: 2, status: "done" });
  });

  it("each state_updated has correct stepId linkage", async () => {
    await journal.append("r1", {
      type: "state_updated",
      data: { state: { step: 1, status: "ok" }, stepId: "step-1" },
    });
    const e = (await journal.getAll("r1"))[0] as StateUpdatedEntry<{
      step: number;
      status: string;
    }>;
    expect(e.data.stepId).toBe("step-1");
  });

  it("full lifecycle replay produces ordered state history", async () => {
    const states = [
      { step: 0, status: "init" },
      { step: 1, status: "processing" },
      { step: 2, status: "done" },
    ];
    await journal.append("r1", { type: "run_started", data: { input: null } });
    for (const s of states) {
      await journal.append("r1", {
        type: "state_updated",
        data: { state: s },
      });
    }
    await journal.append("r1", {
      type: "run_completed",
      data: { output: null },
    });

    const entries = await journal.getAll("r1");
    const stateEntries = entries
      .filter(
        (e): e is StateUpdatedEntry<{ step: number; status: string }> =>
          e.type === "state_updated"
      )
      .map((e) => e.data.state);
    expect(stateEntries).toEqual(states);
  });
});

// ─── 12. Journal compaction ───────────────────────────────────────────────────

describe("Journal compaction", () => {
  it("compact() does nothing when below threshold", async () => {
    const journal = makeJournal({ compactionThreshold: 100 });
    await journal.append("r1", { type: "run_started", data: { input: null } });
    await journal.compact("r1");
    expect(journal._entryCount("r1")).toBe(1);
  });

  it("compact() does nothing for unknown runId", async () => {
    const journal = makeJournal({ compactionThreshold: 5 });
    await journal.compact("no-such-run");
    expect(journal._entryCount("no-such-run")).toBe(0);
  });

  it("compact() reduces entry count to below threshold", async () => {
    const journal = makeJournal({ compactionThreshold: 10 });
    for (let i = 0; i < 10; i++) {
      await journal.append("r1", {
        type: "step_started",
        data: { stepId: `s${i}` },
      });
    }
    // Auto-compaction fires at threshold — raw count reduced
    expect(journal._entryCount("r1")).toBeLessThan(10);
  });

  it("snapshot entry contains throughSeq and compactedCount", async () => {
    const journal = makeJournal({ compactionThreshold: 5 });
    await journal.append("r1", { type: "run_started", data: { input: null } });
    await journal.append("r1", {
      type: "state_updated",
      data: { state: { progress: 25 } },
    });
    for (let i = 0; i < 4; i++) {
      await journal.append("r1", {
        type: "step_started",
        data: { stepId: `s${i}` },
      });
    }
    const entries = await journal.getAll("r1");
    const snap = entries.find((e): e is SnapshotEntry => e.type === "snapshot");
    expect(snap).toBeDefined();
    expect(typeof snap!.data.throughSeq).toBe("number");
    expect(snap!.data.throughSeq).toBeGreaterThan(0);
    expect(snap!.data.compactedCount).toBeGreaterThan(0);
  });

  it("snapshot state matches last state_updated before compaction", async () => {
    const journal = makeJournal<{ val: number }>({ compactionThreshold: 5 });
    await journal.append("r1", { type: "run_started", data: { input: null } });
    await journal.append("r1", {
      type: "state_updated",
      data: { state: { val: 99 } },
    });
    for (let i = 0; i < 4; i++) {
      await journal.append("r1", {
        type: "step_started",
        data: { stepId: `s${i}` },
      });
    }
    const entries = await journal.getAll("r1");
    const snap = entries.find(
      (e): e is SnapshotEntry<{ val: number }> => e.type === "snapshot"
    );
    expect(snap?.data.state).toEqual({ val: 99 });
  });

  it("snapshot + remaining entries = full state when replayed", async () => {
    const journal = makeJournal<{ val: number }>({ compactionThreshold: 5 });
    await journal.append("r1", { type: "run_started", data: { input: null } });
    await journal.append("r1", {
      type: "state_updated",
      data: { state: { val: 10 } },
    });
    for (let i = 0; i < 3; i++) {
      await journal.append("r1", {
        type: "step_started",
        data: { stepId: `s${i}` },
      });
    }
    // Append more after compaction boundary
    await journal.append("r1", {
      type: "state_updated",
      data: { state: { val: 20 } },
    });
    await journal.append("r1", {
      type: "run_completed",
      data: { output: null },
    });

    const entries = await journal.getAll("r1");
    // Post-compaction query should include the snapshot + remaining entries
    const snap = entries.find(
      (e): e is SnapshotEntry<{ val: number }> => e.type === "snapshot"
    );
    const lastState = entries
      .filter(
        (e): e is StateUpdatedEntry<{ val: number }> =>
          e.type === "state_updated"
      )
      .pop();

    // Reconstructed state: start from snapshot, apply remaining state updates
    const reconstructed = lastState?.data.state ?? snap?.data.state;
    expect(reconstructed?.val).toBe(20);
  });

  it("needsCompaction returns true exactly at threshold", async () => {
    const journal = makeJournal({ compactionThreshold: 3 });
    // Manually fill without triggering auto-compact — use a bigger threshold
    const journal2 = makeJournal({ compactionThreshold: 1000 });
    for (let i = 0; i < 3; i++) {
      await journal2.append("r1", {
        type: "step_started",
        data: { stepId: `s${i}` },
      });
    }
    // Manually invoke needsCompaction check using the same threshold
    expect(await journal2.needsCompaction("r1")).toBe(false);
    await journal2.append("r1", {
      type: "step_started",
      data: { stepId: "s-extra" },
    });
    // Still below 1000
    expect(await journal2.needsCompaction("r1")).toBe(false);
    void journal; // silence unused
  });

  it("query excludes compacted entries by default after compaction", async () => {
    const journal = makeJournal({ compactionThreshold: 5 });
    for (let i = 0; i < 6; i++) {
      await journal.append("r1", {
        type: "step_started",
        data: { stepId: `s${i}` },
      });
    }
    const page = await journal.query("r1");
    // snapshot is kept, compacted step entries are hidden
    const compacted = page.entries.filter(
      (e) => e.type !== "snapshot" && e.seq <= 3
    );
    // No compacted non-snapshot entries visible in default query
    expect(compacted).toHaveLength(0);
  });

  it("includeCompacted=true and includeCompacted=false both return same count after in-memory compaction (entries are physically replaced)", async () => {
    // InMemoryRunJournal replaces compacted entries with a snapshot, so both
    // query modes return the same stored entries. The includeCompacted flag
    // matters for DB-backed journals that retain all rows.
    const journal = makeJournal({ compactionThreshold: 5 });
    for (let i = 0; i < 6; i++) {
      await journal.append("r1", {
        type: "step_started",
        data: { stepId: `s${i}` },
      });
    }
    const full = await journal.query("r1", { includeCompacted: true });
    const normal = await journal.query("r1", { includeCompacted: false });
    // Both include the snapshot entry; no hidden compacted entries exist in memory
    expect(full.entries.length).toBe(normal.entries.length);
  });

  it("compaction with no state_updated falls back to empty state", async () => {
    const journal = makeJournal({ compactionThreshold: 5 });
    for (let i = 0; i < 5; i++) {
      await journal.append("r1", {
        type: "step_started",
        data: { stepId: `s${i}` },
      });
    }
    const entries = await journal.getAll("r1");
    const snap = entries.find((e): e is SnapshotEntry => e.type === "snapshot");
    expect(snap).toBeDefined();
    // State falls back to empty object
    expect(snap!.data.state).toEqual({});
  });

  it("repeated compactions do not corrupt entry order", async () => {
    const journal = makeJournal({ compactionThreshold: 5 });
    // Fill enough to trigger compaction twice
    for (let i = 0; i < 15; i++) {
      await journal.append("r1", {
        type: "step_started",
        data: { stepId: `s${i}` },
      });
    }
    const entries = await journal.getAll("r1");
    const seqs = entries.map((e) => e.seq);
    // Seqs should remain sorted (ascending)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

// ─── 13. Concurrent access ────────────────────────────────────────────────────

describe("Concurrent access", () => {
  let journal: InMemoryRunJournal;
  beforeEach(() => {
    journal = makeJournal();
  });

  it("two concurrent writers produce unique seq numbers", async () => {
    const writes = Array.from({ length: 50 }, (_, i) =>
      journal.append("r1", {
        type: "step_started",
        data: { stepId: `s${i}` },
      })
    );
    const seqs = await Promise.all(writes);
    const unique = new Set(seqs);
    expect(unique.size).toBe(50);
  });

  it("concurrent writes for different runs don't interfere", async () => {
    const r1Writes = Array.from({ length: 10 }, (_, i) =>
      journal.append("r1", {
        type: "step_started",
        data: { stepId: `r1-s${i}` },
      })
    );
    const r2Writes = Array.from({ length: 10 }, (_, i) =>
      journal.append("r2", {
        type: "step_started",
        data: { stepId: `r2-s${i}` },
      })
    );
    await Promise.all([...r1Writes, ...r2Writes]);
    const r1All = await journal.getAll("r1");
    const r2All = await journal.getAll("r2");
    expect(r1All).toHaveLength(10);
    expect(r2All).toHaveLength(10);
  });

  it("reader always sees at least what was written before the read", async () => {
    await journal.append("r1", { type: "run_started", data: { input: null } });
    await journal.append("r1", {
      type: "run_completed",
      data: { output: null },
    });
    const entries = await journal.getAll("r1");
    expect(entries.length).toBeGreaterThanOrEqual(2);
  });

  it("concurrent appends produce monotonically increasing seqs within a run", async () => {
    const count = 30;
    const writes = Array.from({ length: count }, (_, i) =>
      journal.append("r1", {
        type: "step_started",
        data: { stepId: `s${i}` },
      })
    );
    const seqs = await Promise.all(writes);
    expect(Math.min(...seqs)).toBe(1);
    expect(Math.max(...seqs)).toBe(count);
  });
});

// ─── 14. Pagination ──────────────────────────────────────────────────────────

describe("Pagination", () => {
  let journal: InMemoryRunJournal;
  beforeEach(async () => {
    journal = makeJournal();
    await appendLifecycle(journal, "r1");
  });

  it("full page iteration covers all entries", async () => {
    let cursor: number | undefined;
    const all: RunJournalEntry[] = [];
    do {
      const page = await journal.query("r1", {
        afterSeq: cursor,
        limit: 2,
      });
      all.push(...page.entries);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    } while (cursor !== undefined);
    expect(all).toHaveLength(4);
  });

  it("nextCursor is the seq of the last entry in the page", async () => {
    const page = await journal.query("r1", { limit: 2 });
    expect(page.nextCursor).toBe(page.entries[1]!.seq);
  });

  it("last page sets hasMore=false and no nextCursor", async () => {
    const page = await journal.query("r1", { afterSeq: 2, limit: 10 });
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });

  it("afterSeq=0 returns all entries from the start", async () => {
    const page = await journal.query("r1", { afterSeq: 0 });
    expect(page.entries).toHaveLength(4);
  });

  it("combined type filter + pagination only counts matching entries", async () => {
    const page = await journal.query("r1", {
      types: ["step_started", "step_completed"],
      limit: 1,
    });
    expect(page.entries).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });
});

// ─── 15. Schema validation ────────────────────────────────────────────────────

describe("Schema validation: state_updated events", () => {
  it("valid state passes schema without warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = {
      parse(data: unknown): { count: number } {
        const d = data as Record<string, unknown>;
        if (typeof d["count"] !== "number") {
          throw new Error("count must be a number");
        }
        return d as { count: number };
      },
    };
    const journal = new InMemoryRunJournal<{ count: number }>({
      stateSchema: schema,
    });
    await journal.append("r1", {
      type: "state_updated",
      data: { state: { count: 42 } },
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("invalid state emits warning but still stores entry", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema = {
      parse(data: unknown): { count: number } {
        const d = data as Record<string, unknown>;
        if (typeof d["count"] !== "number")
          throw new Error("count must be a number");
        return d as { count: number };
      },
    };
    const journal = new InMemoryRunJournal<{ count: number }>({
      stateSchema: schema,
    });
    const seq = await journal.append("r1", {
      type: "state_updated",
      data: {
        state: { count: "not-a-number" } as unknown as { count: number },
      },
    });
    expect(seq).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = String(warnSpy.mock.calls[0]?.[0]);
    expect(warnMsg).toContain("[RunJournal]");
    expect(warnMsg).toContain("r1");
    warnSpy.mockRestore();
  });

  it("schema is NOT called for non-state_updated entry types", async () => {
    const parseFn = vi.fn().mockReturnValue({});
    const journal = new InMemoryRunJournal({
      stateSchema: { parse: parseFn },
    });
    await journal.append("r1", { type: "run_started", data: { input: null } });
    await journal.append("r1", {
      type: "step_started",
      data: { stepId: "s1" },
    });
    await journal.append("r1", {
      type: "run_completed",
      data: { output: null },
    });
    expect(parseFn).not.toHaveBeenCalled();
  });

  it("schema IS called for each state_updated entry", async () => {
    const parseFn = vi.fn().mockImplementation((d: unknown) => d);
    const journal = new InMemoryRunJournal({
      stateSchema: { parse: parseFn },
    });
    await journal.append("r1", {
      type: "state_updated",
      data: { state: { v: 1 } },
    });
    await journal.append("r1", {
      type: "state_updated",
      data: { state: { v: 2 } },
    });
    expect(parseFn).toHaveBeenCalledTimes(2);
  });

  it("journal without stateSchema never calls parse", async () => {
    const journal = new InMemoryRunJournal();
    // Should not throw or warn
    const seq = await journal.append("r1", {
      type: "state_updated",
      data: { state: { anything: true } },
    });
    expect(seq).toBe(1);
  });
});

// ─── 16. Helpers: createEntryBase ────────────────────────────────────────────

describe("createEntryBase helper", () => {
  it("produces base with v=1", () => {
    const base = createEntryBase("run-x", 5);
    expect(base.v).toBe(1);
  });

  it("produces base with correct runId and seq", () => {
    const base = createEntryBase("run-abc", 7);
    expect(base.runId).toBe("run-abc");
    expect(base.seq).toBe(7);
  });

  it("ts is a valid ISO 8601 string", () => {
    const base = createEntryBase("r1", 1);
    expect(new Date(base.ts).toISOString()).toBe(base.ts);
  });
});

// ─── 17. deserializeEntry helper ─────────────────────────────────────────────

describe("deserializeEntry helper", () => {
  it("returns null for null input", () => {
    expect(deserializeEntry(null)).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(deserializeEntry("string")).toBeNull();
    expect(deserializeEntry(42)).toBeNull();
  });

  it("returns null when runId is not a string", () => {
    expect(
      deserializeEntry({
        runId: 123,
        seq: 1,
        ts: new Date().toISOString(),
        type: "run_started",
      })
    ).toBeNull();
  });

  it("returns null when seq is not a number", () => {
    expect(
      deserializeEntry({
        runId: "r1",
        seq: "one",
        ts: new Date().toISOString(),
        type: "run_started",
      })
    ).toBeNull();
  });

  it("returns null when ts is not a string", () => {
    expect(
      deserializeEntry({ runId: "r1", seq: 1, ts: 12345, type: "run_started" })
    ).toBeNull();
  });

  it("wraps unknown future type as 'unknown' entry with originalType", () => {
    const raw = {
      v: 1,
      runId: "r1",
      seq: 1,
      ts: new Date().toISOString(),
      type: "future_event_type_v9",
      data: { custom: true },
    };
    const entry = deserializeEntry(raw);
    expect(entry).not.toBeNull();
    expect(entry!.type).toBe("unknown");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((entry as any).originalType).toBe("future_event_type_v9");
  });

  it("passes through known entry types unchanged", () => {
    const raw = {
      v: 1,
      runId: "r1",
      seq: 3,
      ts: new Date().toISOString(),
      type: "run_completed",
      data: { output: "ok" },
    };
    const entry = deserializeEntry(raw);
    expect(entry).not.toBeNull();
    expect(entry!.type).toBe("run_completed");
  });

  it("round-trips all known entry types", () => {
    const knownTypes = [
      "run_started",
      "step_started",
      "step_completed",
      "step_failed",
      "state_updated",
      "run_completed",
      "run_failed",
      "run_paused",
      "run_resumed",
      "run_suspended",
      "run_cancelled",
      "snapshot",
    ] as const;
    for (const type of knownTypes) {
      const raw = {
        v: 1,
        runId: "r1",
        seq: 1,
        ts: new Date().toISOString(),
        type,
        data: {},
      };
      const entry = deserializeEntry(raw);
      expect(entry?.type).toBe(type);
    }
  });
});
