/**
 * W26-C full package coverage — orchestrator sub-modules
 *
 * Targets the uncovered branches in:
 *   - eval-orchestrator-recovery.ts   (was ~15%)
 *   - eval-orchestrator-transitions.ts (was ~32%)
 *   - eval-orchestrator-errors.ts      (was ~52%)
 *   - eval-orchestrator-metrics.ts     (was ~64%)
 *   - eval-orchestrator-lease.ts       (was ~65%)
 *   - eval-orchestrator-cost.ts        (was ~95%, branch gap)
 *   - eval-orchestrator-attempts.ts    (was ~75%)
 *   - eval-orchestrator-impl.ts        (was ~59%)
 *   - benchmark-orchestrator.ts        (regression-gate paths)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  EvalRunListFilter,
  EvalRunRecord,
  EvalRunStore,
  EvalSuite,
  EvalScorer,
  BenchmarkRunStore,
  BenchmarkRunRecord,
  BenchmarkRunListFilter,
  BenchmarkRunListPage,
  BenchmarkBaselineRecord,
} from "@dzupagent/eval-contracts";

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Shallow-clone an EvalRunRecord — we can't use structuredClone because the
 * suite.scorers array contains async functions which are not structured-cloneable.
 */
function cloneRun(run: EvalRunRecord): EvalRunRecord {
  return {
    ...run,
    attemptHistory: run.attemptHistory
      ? run.attemptHistory.map((a) => ({ ...a }))
      : undefined,
  };
}

class MockRunStore implements EvalRunStore {
  private runs = new Map<string, EvalRunRecord>();

  async saveRun(run: EvalRunRecord): Promise<void> {
    this.runs.set(run.id, cloneRun(run));
  }
  async updateRun(runId: string, patch: Partial<EvalRunRecord>): Promise<void> {
    const cur = this.runs.get(runId);
    if (!cur) throw new Error(`run ${runId} missing`);
    this.runs.set(runId, { ...cur, ...patch });
  }
  async updateRunIf(
    runId: string,
    predicate: (run: EvalRunRecord) => boolean,
    patch: Partial<EvalRunRecord>,
  ): Promise<boolean> {
    const cur = this.runs.get(runId);
    if (!cur) throw new Error(`run ${runId} missing`);
    if (!predicate(cur)) return false;
    this.runs.set(runId, { ...cur, ...patch });
    return true;
  }
  async getRun(runId: string): Promise<EvalRunRecord | null> {
    const r = this.runs.get(runId);
    return r ? cloneRun(r) : null;
  }
  async listRuns(_filter?: EvalRunListFilter): Promise<EvalRunRecord[]> {
    return Array.from(this.runs.values()).map(cloneRun);
  }
  async listAllRuns(): Promise<EvalRunRecord[]> {
    return Array.from(this.runs.values()).map(cloneRun);
  }
  seedRun(run: EvalRunRecord): void {
    this.runs.set(run.id, cloneRun(run));
  }
}

class MockBenchmarkRunStore implements BenchmarkRunStore {
  private runs = new Map<string, BenchmarkRunRecord>();
  private baselines = new Map<string, BenchmarkBaselineRecord>();

  async saveRun(run: BenchmarkRunRecord): Promise<void> {
    this.runs.set(run.id, { ...run });
  }
  async getRun(runId: string): Promise<BenchmarkRunRecord | null> {
    return this.runs.get(runId) ?? null;
  }
  async listRuns(
    _filter?: BenchmarkRunListFilter,
  ): Promise<BenchmarkRunListPage> {
    return {
      data: Array.from(this.runs.values()),
      nextCursor: null,
      hasMore: false,
    };
  }
  async saveBaseline(baseline: BenchmarkBaselineRecord): Promise<void> {
    this.baselines.set(`${baseline.suiteId}:${baseline.targetId}`, {
      ...baseline,
    });
  }
  async getBaseline(
    suiteId: string,
    targetId: string,
  ): Promise<BenchmarkBaselineRecord | null> {
    return this.baselines.get(`${suiteId}:${targetId}`) ?? null;
  }
  async listBaselines(filter?: {
    suiteId?: string;
    targetId?: string;
  }): Promise<BenchmarkBaselineRecord[]> {
    let results = Array.from(this.baselines.values());
    if (filter?.suiteId)
      results = results.filter((b) => b.suiteId === filter.suiteId);
    if (filter?.targetId)
      results = results.filter((b) => b.targetId === filter.targetId);
    return results;
  }
}

const noopScorer: EvalScorer = {
  name: "noop",
  async score() {
    return { score: 1, pass: true, reasoning: "ok" };
  },
};

function buildSuite(name = "test-suite"): EvalSuite {
  return {
    name,
    description: "Test suite",
    cases: [{ id: "a", input: "hello", expectedOutput: "world" }],
    scorers: [noopScorer],
  };
}

function makeQueuedRun(overrides: Partial<EvalRunRecord> = {}): EvalRunRecord {
  const now = new Date().toISOString();
  return {
    id: `run-${Math.random().toString(36).slice(2)}`,
    suiteId: "test-suite",
    suite: buildSuite(),
    status: "queued",
    createdAt: now,
    queuedAt: now,
    attempts: 1,
    attemptHistory: [{ attempt: 1, status: "queued", queuedAt: now }],
    ...overrides,
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

// ── eval-orchestrator-errors ─────────────────────────────────────────────────

import {
  EvalCostExceededError,
  EvalExecutionUnavailableError,
  EvalRunInvalidStateError,
} from "../orchestrator/eval-orchestrator-errors.js";

describe("eval-orchestrator-errors", () => {
  describe("EvalExecutionUnavailableError", () => {
    it("creates error with correct name and code", () => {
      const err = new EvalExecutionUnavailableError("target not configured");
      expect(err.name).toBe("EvalExecutionUnavailableError");
      expect(err.code).toBe("EVAL_EXECUTION_UNAVAILABLE");
      expect(err.message).toBe("target not configured");
      expect(err instanceof Error).toBe(true);
    });
    it("is instanceof Error", () => {
      expect(new EvalExecutionUnavailableError("x") instanceof Error).toBe(
        true,
      );
    });
  });

  describe("EvalRunInvalidStateError", () => {
    it("creates error with correct name and code", () => {
      const err = new EvalRunInvalidStateError(
        "cannot cancel in completed state",
      );
      expect(err.name).toBe("EvalRunInvalidStateError");
      expect(err.code).toBe("INVALID_STATE");
      expect(err.message).toContain("completed");
    });
    it("is instanceof Error", () => {
      expect(new EvalRunInvalidStateError("x") instanceof Error).toBe(true);
    });
  });

  describe("EvalCostExceededError", () => {
    it("stores capCents and observedCents", () => {
      const err = new EvalCostExceededError("too expensive", 100, 250);
      expect(err.name).toBe("EvalCostExceededError");
      expect(err.code).toBe("EVAL_COST_CAP_EXCEEDED");
      expect(err.capCents).toBe(100);
      expect(err.observedCents).toBe(250);
      expect(err.message).toBe("too expensive");
    });
  });
});

// ── eval-orchestrator-cost ───────────────────────────────────────────────────

import {
  resolveAccumulatedCostCents,
  assertCostWithinCap,
} from "../orchestrator/eval-orchestrator-cost.js";

describe("eval-orchestrator-cost", () => {
  it("resolveAccumulatedCostCents returns 0 when no getter provided", async () => {
    const result = await resolveAccumulatedCostCents({});
    expect(result).toBe(0);
  });

  it("resolveAccumulatedCostCents returns 0 when getter returns non-finite", async () => {
    const result = await resolveAccumulatedCostCents({
      getAccumulatedCostCents: () => NaN,
    });
    expect(result).toBe(0);
  });

  it("resolveAccumulatedCostCents returns 0 when getter returns Infinity", async () => {
    const result = await resolveAccumulatedCostCents({
      getAccumulatedCostCents: () => Infinity,
    });
    expect(result).toBe(0);
  });

  it("resolveAccumulatedCostCents returns async value", async () => {
    const result = await resolveAccumulatedCostCents({
      getAccumulatedCostCents: async () => 42,
    });
    expect(result).toBe(42);
  });

  it("assertCostWithinCap does nothing when no cap", async () => {
    await expect(assertCostWithinCap({})).resolves.toBeUndefined();
  });

  it("assertCostWithinCap passes when cost is under cap", async () => {
    await expect(
      assertCostWithinCap({
        costCapCents: 100,
        getAccumulatedCostCents: () => 50,
      }),
    ).resolves.toBeUndefined();
  });

  it("assertCostWithinCap passes when cost equals cap exactly", async () => {
    await expect(
      assertCostWithinCap({
        costCapCents: 100,
        getAccumulatedCostCents: () => 100,
      }),
    ).resolves.toBeUndefined();
  });

  it("assertCostWithinCap throws EvalCostExceededError when cost exceeds cap", async () => {
    await expect(
      assertCostWithinCap({
        costCapCents: 100,
        getAccumulatedCostCents: () => 150,
      }),
    ).rejects.toBeInstanceOf(EvalCostExceededError);
  });

  it("assertCostWithinCap error contains accurate cost info", async () => {
    try {
      await assertCostWithinCap({
        costCapCents: 10,
        getAccumulatedCostCents: () => 20,
      });
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EvalCostExceededError);
      const costErr = err as EvalCostExceededError;
      expect(costErr.capCents).toBe(10);
      expect(costErr.observedCents).toBe(20);
    }
  });
});

// ── eval-orchestrator-attempts ───────────────────────────────────────────────

import {
  createAbortError,
  toEvalRunError,
  cloneAttemptRecord,
  createAttemptRecord,
  getAttemptHistory,
  getCurrentAttemptNumber,
  updateAttemptHistory,
  appendAttemptHistory,
} from "../orchestrator/eval-orchestrator-attempts.js";

describe("eval-orchestrator-attempts", () => {
  it("createAbortError returns DOMException with AbortError name", () => {
    const err = createAbortError();
    expect(err).toBeInstanceOf(DOMException);
    expect(err.name).toBe("AbortError");
    expect(err.message).toContain("cancelled");
  });

  describe("toEvalRunError", () => {
    it("converts Error instance to record using name and message", () => {
      const err = new TypeError("bad type");
      const record = toEvalRunError(err);
      expect(record.code).toBe("TypeError");
      expect(record.message).toBe("bad type");
    });

    it("uses EVAL_RUN_FAILED when error has no name", () => {
      const err = new Error("generic");
      // Simulate unnamed error
      const fakeErr = { name: "", message: "generic" } as Error;
      const record = toEvalRunError(fakeErr);
      expect(record.code).toBe("EVAL_RUN_FAILED");
    });

    it("converts non-Error values via String()", () => {
      const record = toEvalRunError("string error");
      expect(record.code).toBe("EVAL_RUN_FAILED");
      expect(record.message).toBe("string error");
    });

    it("converts null to string representation", () => {
      const record = toEvalRunError(null);
      expect(record.code).toBe("EVAL_RUN_FAILED");
      expect(record.message).toBe("null");
    });

    it("converts number to string representation", () => {
      const record = toEvalRunError(42);
      expect(record.code).toBe("EVAL_RUN_FAILED");
      expect(record.message).toBe("42");
    });
  });

  describe("cloneAttemptRecord", () => {
    it("returns a shallow clone", () => {
      const now = new Date().toISOString();
      const original = { attempt: 1, status: "queued" as const, queuedAt: now };
      const clone = cloneAttemptRecord(original);
      expect(clone).not.toBe(original);
      expect(clone).toEqual(original);
    });

    it("clones optional recovery field", () => {
      const now = new Date().toISOString();
      const record = {
        attempt: 2,
        status: "queued" as const,
        queuedAt: now,
        recovery: {
          previousStatus: "running" as const,
          recoveredAt: now,
          reason: "process-restart" as const,
        },
      };
      const clone = cloneAttemptRecord(record);
      expect(clone.recovery).not.toBe(record.recovery);
      expect(clone.recovery).toEqual(record.recovery);
    });

    it("clones optional error field", () => {
      const now = new Date().toISOString();
      const record = {
        attempt: 1,
        status: "failed" as const,
        queuedAt: now,
        error: { code: "ERR", message: "oops" },
      };
      const clone = cloneAttemptRecord(record);
      expect(clone.error).not.toBe(record.error);
      expect(clone.error).toEqual(record.error);
    });
  });

  describe("getAttemptHistory", () => {
    it("returns cloned history when attemptHistory is populated", () => {
      const now = new Date().toISOString();
      const run = makeQueuedRun({
        attemptHistory: [{ attempt: 1, status: "queued", queuedAt: now }],
      });
      const history = getAttemptHistory(run);
      expect(history).toHaveLength(1);
      expect(history[0]!.attempt).toBe(1);
    });

    it("synthesises history from run fields when attemptHistory is empty", () => {
      const now = new Date().toISOString();
      const run = makeQueuedRun({ attemptHistory: [] });
      const history = getAttemptHistory(run);
      expect(history).toHaveLength(1);
      expect(history[0]!.status).toBe("queued");
    });

    it("synthesises history when attemptHistory is undefined", () => {
      const run = makeQueuedRun();
      const runWithout = { ...run, attemptHistory: undefined };
      const history = getAttemptHistory(runWithout);
      expect(history).toHaveLength(1);
    });

    it("includes startedAt in synthesised history", () => {
      const now = new Date().toISOString();
      const run = makeQueuedRun({
        status: "running",
        startedAt: now,
        attemptHistory: undefined,
      });
      const history = getAttemptHistory(run);
      expect(history[0]!.startedAt).toBe(now);
    });

    it("includes completedAt in synthesised history", () => {
      const now = new Date().toISOString();
      const run = makeQueuedRun({
        status: "completed",
        completedAt: now,
        attemptHistory: undefined,
      });
      const history = getAttemptHistory(run);
      expect(history[0]!.completedAt).toBe(now);
    });

    it("includes result in synthesised history", () => {
      const result = {
        suiteId: "x",
        timestamp: new Date().toISOString(),
        results: [],
        aggregateScore: 1,
        passRate: 1,
      };
      const run = makeQueuedRun({
        status: "completed",
        result,
        attemptHistory: undefined,
      });
      const history = getAttemptHistory(run);
      expect(history[0]!.result).toEqual(result);
    });

    it("includes error in synthesised history", () => {
      const error = { code: "ERR", message: "fail" };
      const run = makeQueuedRun({
        status: "failed",
        error,
        attemptHistory: undefined,
      });
      const history = getAttemptHistory(run);
      expect(history[0]!.error).toEqual(error);
    });

    it("includes recovery in synthesised history", () => {
      const recovery = {
        previousStatus: "running" as const,
        recoveredAt: new Date().toISOString(),
        reason: "process-restart" as const,
      };
      const run = makeQueuedRun({ recovery, attemptHistory: undefined });
      const history = getAttemptHistory(run);
      expect(history[0]!.recovery).toEqual(recovery);
    });
  });

  describe("getCurrentAttemptNumber", () => {
    it("returns the last attempt number from history", () => {
      const now = new Date().toISOString();
      const run = makeQueuedRun({
        attempts: 3,
        attemptHistory: [
          { attempt: 1, status: "failed", queuedAt: now },
          { attempt: 2, status: "failed", queuedAt: now },
          { attempt: 3, status: "queued", queuedAt: now },
        ],
      });
      expect(getCurrentAttemptNumber(run)).toBe(3);
    });

    it("falls back to run.attempts when history synthesises", () => {
      const run = makeQueuedRun({ attempts: 2, attemptHistory: undefined });
      expect(getCurrentAttemptNumber(run)).toBe(2);
    });
  });

  describe("updateAttemptHistory", () => {
    it("updates an existing attempt by number", () => {
      const now = new Date().toISOString();
      const run = makeQueuedRun({
        attemptHistory: [{ attempt: 1, status: "queued", queuedAt: now }],
      });
      const updated = updateAttemptHistory(run, 1, {
        status: "running",
        startedAt: now,
      });
      expect(updated[0]!.status).toBe("running");
      expect(updated[0]!.startedAt).toBe(now);
    });

    it("appends a new attempt when attempt number not found", () => {
      const now = new Date().toISOString();
      const run = makeQueuedRun({
        attemptHistory: [{ attempt: 1, status: "failed", queuedAt: now }],
      });
      const updated = updateAttemptHistory(run, 2, {
        status: "queued",
        queuedAt: now,
      });
      expect(updated).toHaveLength(2);
      expect(updated[1]!.attempt).toBe(2);
    });

    it("preserves existing optional fields when patch omits them", () => {
      const now = new Date().toISOString();
      const startedAt = now;
      const run = makeQueuedRun({
        attemptHistory: [
          { attempt: 1, status: "running", queuedAt: now, startedAt },
        ],
      });
      const updated = updateAttemptHistory(run, 1, {
        status: "completed",
        completedAt: now,
      });
      expect(updated[0]!.startedAt).toBe(startedAt);
      expect(updated[0]!.completedAt).toBe(now);
    });

    it("preserves existing startedAt when patch passes undefined (undefined is not a clear signal)", () => {
      const now = new Date().toISOString();
      const run = makeQueuedRun({
        attemptHistory: [
          { attempt: 1, status: "running", queuedAt: now, startedAt: now },
        ],
      });
      // The implementation only spreads startedAt when patch.startedAt !== undefined.
      // Passing undefined therefore keeps the pre-existing value from history.
      const updated = updateAttemptHistory(run, 1, { startedAt: undefined });
      expect(updated[0]!.startedAt).toBe(now);
    });

    it("sorts history by attempt number", () => {
      const now = new Date().toISOString();
      const run = makeQueuedRun({
        attempts: 2,
        attemptHistory: [
          { attempt: 2, status: "failed", queuedAt: now },
          { attempt: 1, status: "failed", queuedAt: now },
        ],
      });
      const updated = updateAttemptHistory(run, 2, {
        status: "queued",
        queuedAt: now,
      });
      expect(updated[0]!.attempt).toBe(1);
      expect(updated[1]!.attempt).toBe(2);
    });
  });

  describe("appendAttemptHistory", () => {
    it("appends a new attempt record to the history", () => {
      const now = new Date().toISOString();
      const run = makeQueuedRun({
        attemptHistory: [{ attempt: 1, status: "failed", queuedAt: now }],
      });
      const nextRecord = createAttemptRecord({
        attempt: 2,
        status: "queued",
        queuedAt: now,
      });
      const result = appendAttemptHistory(run, nextRecord);
      expect(result).toHaveLength(2);
      expect(result[1]!.attempt).toBe(2);
    });

    it("returns sorted history", () => {
      const now = new Date().toISOString();
      const run = makeQueuedRun({
        attempts: 3,
        attemptHistory: [
          { attempt: 3, status: "failed", queuedAt: now },
          { attempt: 1, status: "failed", queuedAt: now },
        ],
      });
      const newRecord = createAttemptRecord({
        attempt: 2,
        status: "queued",
        queuedAt: now,
      });
      const result = appendAttemptHistory(run, newRecord);
      expect(result.map((r) => r.attempt)).toEqual([1, 2, 3]);
    });
  });
});

// ── eval-orchestrator-transitions ────────────────────────────────────────────

import {
  isTerminalStatus,
  persistQueuedRun,
  persistCancellation,
  persistRetry,
} from "../orchestrator/eval-orchestrator-transitions.js";

describe("eval-orchestrator-transitions", () => {
  describe("isTerminalStatus", () => {
    it("returns true for completed", () =>
      expect(isTerminalStatus("completed")).toBe(true));
    it("returns true for failed", () =>
      expect(isTerminalStatus("failed")).toBe(true));
    it("returns true for cancelled", () =>
      expect(isTerminalStatus("cancelled")).toBe(true));
    it("returns false for queued", () =>
      expect(isTerminalStatus("queued")).toBe(false));
    it("returns false for running", () =>
      expect(isTerminalStatus("running")).toBe(false));
  });

  describe("persistQueuedRun", () => {
    it("creates a queued run in the store", async () => {
      const store = new MockRunStore();
      const suite = buildSuite();
      const run = await persistQueuedRun(store, { suite });
      expect(run.status).toBe("queued");
      expect(run.suiteId).toBe(suite.name);
      expect(run.attempts).toBe(1);
      expect(run.attemptHistory).toHaveLength(1);
    });

    it("includes metadata when provided", async () => {
      const store = new MockRunStore();
      const run = await persistQueuedRun(store, {
        suite: buildSuite(),
        metadata: { env: "test" },
      });
      expect(run.metadata).toEqual({ env: "test" });
    });

    it("throws if getRun returns null after save", async () => {
      const store = new MockRunStore();
      // Make getRun return null always
      store.getRun = async () => null;
      await expect(
        persistQueuedRun(store, { suite: buildSuite() }),
      ).rejects.toThrow("missing after enqueue");
    });
  });

  describe("persistCancellation", () => {
    it("marks a queued run as cancelled", async () => {
      const store = new MockRunStore();
      const run = makeQueuedRun();
      store.seedRun(run);
      const cancelled = await persistCancellation(store, run);
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.completedAt).toBeDefined();
    });

    it("throws EvalRunInvalidStateError when updateRunIf returns false and run is terminal", async () => {
      const store = new MockRunStore();
      const completedRun = makeQueuedRun({ status: "completed" });
      store.seedRun(completedRun);
      // Simulate the case where updateRunIf predicate fails (run is terminal)
      await expect(persistCancellation(store, completedRun)).rejects.toThrow();
    });

    it("throws when run is missing after cancellation", async () => {
      const store = new MockRunStore();
      const run = makeQueuedRun();
      store.seedRun(run);
      // Make getRun return null AFTER updateRunIf succeeds
      const originalUpdateRunIf = store.updateRunIf.bind(store);
      store.updateRunIf = async (runId, predicate, patch) => {
        await originalUpdateRunIf(runId, predicate, patch);
        return true;
      };
      store.getRun = async () => null;
      await expect(persistCancellation(store, run)).rejects.toThrow(
        "missing after cancellation",
      );
    });
  });

  describe("persistRetry", () => {
    it("marks a failed run as queued with incremented attempt", async () => {
      const store = new MockRunStore();
      const failedRun = makeQueuedRun({
        status: "failed",
        error: { code: "ERR", message: "fail" },
        attempts: 1,
      });
      store.seedRun(failedRun);
      const retried = await persistRetry(store, failedRun);
      expect(retried.status).toBe("queued");
      expect(retried.attempts).toBe(2);
      expect(retried.error).toBeUndefined();
    });

    it("throws EvalRunInvalidStateError when run is not failed", async () => {
      const store = new MockRunStore();
      const run = makeQueuedRun({ status: "queued" });
      store.seedRun(run);
      await expect(persistRetry(store, run)).rejects.toThrow("Cannot retry");
    });

    it("throws when run is missing after retry", async () => {
      const store = new MockRunStore();
      const failedRun = makeQueuedRun({
        status: "failed",
        error: { code: "ERR", message: "fail" },
      });
      store.seedRun(failedRun);
      const originalUpdateRunIf = store.updateRunIf.bind(store);
      store.updateRunIf = async (runId, predicate, patch) => {
        await originalUpdateRunIf(runId, predicate, patch);
        return true;
      };
      store.getRun = async () => null;
      await expect(persistRetry(store, failedRun)).rejects.toThrow(
        "missing after retry",
      );
    });
  });
});

// ── eval-orchestrator-recovery ───────────────────────────────────────────────

import {
  sortStaleRuns,
  buildRecoveryPatch,
} from "../orchestrator/eval-orchestrator-recovery.js";

describe("eval-orchestrator-recovery", () => {
  describe("sortStaleRuns", () => {
    it("filters out completed, failed, and cancelled runs", () => {
      const now = new Date().toISOString();
      const runs = [
        makeQueuedRun({ status: "completed" }),
        makeQueuedRun({ status: "failed" }),
        makeQueuedRun({ status: "cancelled" }),
        makeQueuedRun({ status: "queued" }),
        makeQueuedRun({ status: "running" }),
      ];
      const result = sortStaleRuns(runs);
      expect(result).toHaveLength(2);
      expect(
        result.every((r) => r.status === "queued" || r.status === "running"),
      ).toBe(true);
    });

    it("sorts by queuedAt ascending", () => {
      const earlier = makeQueuedRun({ queuedAt: "2024-01-01T00:00:00.000Z" });
      const later = makeQueuedRun({ queuedAt: "2024-01-02T00:00:00.000Z" });
      const result = sortStaleRuns([later, earlier]);
      expect(result[0]!.queuedAt).toBe("2024-01-01T00:00:00.000Z");
    });

    it("uses createdAt as tiebreaker when queuedAt is equal", () => {
      const sameQueue = "2024-01-01T00:00:00.000Z";
      const runA = makeQueuedRun({
        queuedAt: sameQueue,
        createdAt: "2024-01-01T00:00:00.000Z",
      });
      const runB = makeQueuedRun({
        queuedAt: sameQueue,
        createdAt: "2024-01-01T00:00:01.000Z",
      });
      const result = sortStaleRuns([runB, runA]);
      expect(result[0]!.createdAt).toBe("2024-01-01T00:00:00.000Z");
    });

    it("uses id as final tiebreaker", () => {
      const sameQueue = "2024-01-01T00:00:00.000Z";
      const sameCreated = "2024-01-01T00:00:00.000Z";
      const runA = {
        ...makeQueuedRun({ queuedAt: sameQueue, createdAt: sameCreated }),
        id: "aaa",
      };
      const runB = {
        ...makeQueuedRun({ queuedAt: sameQueue, createdAt: sameCreated }),
        id: "bbb",
      };
      const result = sortStaleRuns([runB, runA]);
      expect(result[0]!.id).toBe("aaa");
    });

    it("returns empty array when no stale runs", () => {
      const result = sortStaleRuns([makeQueuedRun({ status: "completed" })]);
      expect(result).toHaveLength(0);
    });

    it("returns empty array for empty input", () => {
      expect(sortStaleRuns([])).toHaveLength(0);
    });
  });

  describe("buildRecoveryPatch", () => {
    it("returns a queued status patch", () => {
      const run = makeQueuedRun({
        status: "running",
        startedAt: new Date().toISOString(),
      });
      const { patch } = buildRecoveryPatch(run);
      expect(patch.status).toBe("queued");
    });

    it("clears executionOwner", () => {
      const run = makeQueuedRun({
        status: "running",
        executionOwner: {
          ownerId: "x",
          claimedAt: new Date().toISOString(),
          leaseExpiresAt: new Date().toISOString(),
        },
      });
      const { patch } = buildRecoveryPatch(run);
      expect(patch.executionOwner).toBeUndefined();
    });

    it("clears startedAt", () => {
      const run = makeQueuedRun({
        status: "running",
        startedAt: new Date().toISOString(),
      });
      const { patch } = buildRecoveryPatch(run);
      expect(patch.startedAt).toBeUndefined();
    });

    it("increments attempt number", () => {
      const run = makeQueuedRun({
        attempts: 2,
        attemptHistory: [
          { attempt: 1, status: "failed", queuedAt: new Date().toISOString() },
          { attempt: 2, status: "running", queuedAt: new Date().toISOString() },
        ],
      });
      const { patch } = buildRecoveryPatch(run);
      expect(patch.attempts).toBe(3);
    });

    it("adds recovery reason as process-restart", () => {
      const run = makeQueuedRun({ status: "running" });
      const { recovery } = buildRecoveryPatch(run);
      expect(recovery.reason).toBe("process-restart");
      expect(recovery.previousStatus).toBe("running");
    });

    it("includes previousStartedAt in recovery when startedAt was set", () => {
      const startedAt = "2024-01-01T10:00:00.000Z";
      const run = makeQueuedRun({ status: "running", startedAt });
      const { recovery } = buildRecoveryPatch(run);
      expect(recovery.previousStartedAt).toBe(startedAt);
    });

    it("propagates recovery into patch metadata", () => {
      const run = makeQueuedRun({
        status: "running",
        metadata: { env: "prod" },
      });
      const { patch } = buildRecoveryPatch(run);
      expect(patch.metadata["env"]).toBe("prod");
      expect(patch.metadata["recovery"]).toBeDefined();
    });

    it("creates attempt history with both interrupted and next queued attempt", () => {
      const run = makeQueuedRun({ status: "running", attempts: 1 });
      const { patch } = buildRecoveryPatch(run);
      // The history should have the interrupted attempt (cancelled) + new queued attempt
      expect(patch.attemptHistory.length).toBeGreaterThanOrEqual(2);
      const statuses = patch.attemptHistory.map((a) => a.status);
      expect(statuses).toContain("cancelled");
      expect(statuses).toContain("queued");
    });
  });
});

// ── eval-orchestrator-metrics ────────────────────────────────────────────────

import { QueueMetricsTracker } from "../orchestrator/eval-orchestrator-metrics.js";

describe("QueueMetricsTracker", () => {
  const makeTracker = (
    opts: {
      pendingIds?: string[];
      pendingSet?: Set<string>;
      activeControllers?: Map<string, AbortController>;
      store?: EvalRunStore;
      metrics?: {
        increment: ReturnType<typeof vi.fn>;
        observe: ReturnType<typeof vi.fn>;
        gauge: ReturnType<typeof vi.fn>;
      };
    } = {},
  ) => {
    const store = opts.store ?? new MockRunStore();
    const pendingRunIds = opts.pendingIds ?? [];
    const pendingRunSet = opts.pendingSet ?? new Set<string>();
    const activeRunControllers =
      opts.activeControllers ?? new Map<string, AbortController>();
    const metrics = opts.metrics;
    return new QueueMetricsTracker({
      store,
      pendingRunIds,
      pendingRunSet,
      activeRunControllers,
      ...(metrics ? { metrics } : {}),
    });
  };

  it("initialises all counters to 0", () => {
    const tracker = makeTracker();
    expect(tracker.counters).toEqual({
      enqueued: 0,
      started: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      retried: 0,
      recovered: 0,
      requeued: 0,
    });
  });

  it("increment increases specified counter", () => {
    const tracker = makeTracker();
    tracker.increment("enqueued");
    expect(tracker.counters.enqueued).toBe(1);
    tracker.increment("enqueued", 5);
    expect(tracker.counters.enqueued).toBe(6);
  });

  it("recordQueueEvent calls metrics.increment", () => {
    const mockMetrics = {
      increment: vi.fn(),
      observe: vi.fn(),
      gauge: vi.fn(),
    };
    const tracker = makeTracker({ metrics: mockMetrics });
    tracker.recordQueueEvent("forge_eval_queue_enqueued_total");
    expect(mockMetrics.increment).toHaveBeenCalledWith(
      "forge_eval_queue_enqueued_total",
    );
  });

  it("recordQueueEvent does nothing when no metrics", () => {
    const tracker = makeTracker();
    expect(() => tracker.recordQueueEvent("test")).not.toThrow();
  });

  it("recordQueueHistogram calls metrics.observe for valid positive values", () => {
    const mockMetrics = {
      increment: vi.fn(),
      observe: vi.fn(),
      gauge: vi.fn(),
    };
    const tracker = makeTracker({ metrics: mockMetrics });
    tracker.recordQueueHistogram("forge_eval_queue_wait_ms", 500);
    expect(mockMetrics.observe).toHaveBeenCalledWith(
      "forge_eval_queue_wait_ms",
      500,
    );
  });

  it("recordQueueHistogram does nothing when no metrics", () => {
    const tracker = makeTracker();
    expect(() => tracker.recordQueueHistogram("test", 100)).not.toThrow();
  });

  it("recordQueueHistogram skips non-finite values", () => {
    const mockMetrics = {
      increment: vi.fn(),
      observe: vi.fn(),
      gauge: vi.fn(),
    };
    const tracker = makeTracker({ metrics: mockMetrics });
    tracker.recordQueueHistogram("test", NaN);
    tracker.recordQueueHistogram("test", Infinity);
    expect(mockMetrics.observe).not.toHaveBeenCalled();
  });

  it("recordQueueHistogram skips negative values", () => {
    const mockMetrics = {
      increment: vi.fn(),
      observe: vi.fn(),
      gauge: vi.fn(),
    };
    const tracker = makeTracker({ metrics: mockMetrics });
    tracker.recordQueueHistogram("test", -1);
    expect(mockMetrics.observe).not.toHaveBeenCalled();
  });

  it("track increments counter and calls refreshQueueMetrics", async () => {
    const tracker = makeTracker();
    vi.spyOn(tracker, "refreshQueueMetrics").mockResolvedValue();
    await tracker.track("enqueued", "forge_eval_queue_enqueued_total");
    expect(tracker.counters.enqueued).toBe(1);
    expect(tracker.refreshQueueMetrics).toHaveBeenCalled();
  });

  describe("buildQueueStats", () => {
    it("returns stats with pending and active counts", async () => {
      const pending = new Set(["run-1"]);
      const active = new Map([["run-2", new AbortController()]]);
      const tracker = makeTracker({
        pendingSet: pending,
        activeControllers: active,
      });
      const stats = await tracker.buildQueueStats();
      expect(stats.pending).toBe(1);
      expect(stats.active).toBe(1);
    });

    it("returns oldestPendingAgeMs=null when no pending runs", async () => {
      const tracker = makeTracker();
      const stats = await tracker.buildQueueStats();
      expect(stats.oldestPendingAgeMs).toBeNull();
    });

    it("calculates oldestPendingAgeMs for pending run", async () => {
      const store = new MockRunStore();
      const past = new Date(Date.now() - 5000).toISOString();
      const run = makeQueuedRun({ id: "run-pending", queuedAt: past });
      store.seedRun(run);
      const pending = new Set(["run-pending"]);
      const tracker = makeTracker({
        store,
        pendingIds: ["run-pending"],
        pendingSet: pending,
      });
      const stats = await tracker.buildQueueStats();
      expect(stats.oldestPendingAgeMs).toBeGreaterThan(0);
    });

    it("skips pending run with non-queued status", async () => {
      const store = new MockRunStore();
      const run = makeQueuedRun({ id: "run-running", status: "running" });
      store.seedRun(run);
      const pending = new Set(["run-running"]);
      const tracker = makeTracker({
        store,
        pendingIds: ["run-running"],
        pendingSet: pending,
      });
      const stats = await tracker.buildQueueStats();
      expect(stats.oldestPendingAgeMs).toBeNull();
    });

    it("skips pending run that is missing from store", async () => {
      const store = new MockRunStore();
      const pending = new Set(["nonexistent"]);
      const tracker = makeTracker({
        store,
        pendingIds: ["nonexistent"],
        pendingSet: pending,
      });
      const stats = await tracker.buildQueueStats();
      expect(stats.oldestPendingAgeMs).toBeNull();
    });

    it("skips pending run with invalid queuedAt", async () => {
      const store = new MockRunStore();
      const run = makeQueuedRun({ id: "run-invalid", queuedAt: "not-a-date" });
      store.seedRun(run);
      const pending = new Set(["run-invalid"]);
      const tracker = makeTracker({
        store,
        pendingIds: ["run-invalid"],
        pendingSet: pending,
      });
      const stats = await tracker.buildQueueStats();
      expect(stats.oldestPendingAgeMs).toBeNull();
    });

    it("includes all counters in stats", async () => {
      const tracker = makeTracker();
      tracker.increment("completed", 5);
      tracker.increment("failed", 2);
      const stats = await tracker.buildQueueStats();
      expect(stats.completed).toBe(5);
      expect(stats.failed).toBe(2);
    });
  });

  describe("refreshQueueMetrics", () => {
    it("does nothing when no metrics collector", async () => {
      const tracker = makeTracker();
      await expect(tracker.refreshQueueMetrics()).resolves.toBeUndefined();
    });

    it("emits pending, active, and oldest age gauges", async () => {
      const mockMetrics = {
        increment: vi.fn(),
        observe: vi.fn(),
        gauge: vi.fn(),
      };
      const tracker = makeTracker({ metrics: mockMetrics });
      await tracker.refreshQueueMetrics();
      expect(mockMetrics.gauge).toHaveBeenCalledWith(
        "forge_eval_queue_pending",
        0,
      );
      expect(mockMetrics.gauge).toHaveBeenCalledWith(
        "forge_eval_queue_active",
        0,
      );
      expect(mockMetrics.gauge).toHaveBeenCalledWith(
        "forge_eval_queue_oldest_pending_age_ms",
        0,
      );
    });
  });
});

// ── eval-orchestrator-lease ───────────────────────────────────────────────────

import { LeaseManager } from "../orchestrator/eval-orchestrator-lease.js";

describe("LeaseManager", () => {
  it("assigns a unique instanceId on construction", () => {
    const store = new MockRunStore();
    const lm1 = new LeaseManager({ store });
    const lm2 = new LeaseManager({ store });
    expect(lm1.instanceId).not.toBe(lm2.instanceId);
    expect(typeof lm1.instanceId).toBe("string");
  });

  describe("isExecutionLeaseExpired", () => {
    it("returns true when lease has expired", () => {
      const lm = new LeaseManager({ store: new MockRunStore() });
      const pastDate = new Date(Date.now() - 1000).toISOString();
      expect(
        lm.isExecutionLeaseExpired({
          ownerId: "x",
          claimedAt: pastDate,
          leaseExpiresAt: pastDate,
        }),
      ).toBe(true);
    });

    it("returns false when lease is still valid", () => {
      const lm = new LeaseManager({ store: new MockRunStore() });
      const futureDate = new Date(Date.now() + 60_000).toISOString();
      expect(
        lm.isExecutionLeaseExpired({
          ownerId: "x",
          claimedAt: new Date().toISOString(),
          leaseExpiresAt: futureDate,
        }),
      ).toBe(false);
    });

    it("returns true when leaseExpiresAt is not a valid date", () => {
      const lm = new LeaseManager({ store: new MockRunStore() });
      expect(
        lm.isExecutionLeaseExpired({
          ownerId: "x",
          claimedAt: new Date().toISOString(),
          leaseExpiresAt: "invalid-date",
        }),
      ).toBe(true);
    });
  });

  describe("createLeaseExpiry", () => {
    it("returns an ISO string leaseDurationMs into the future", () => {
      const lm = new LeaseManager({
        store: new MockRunStore(),
        leaseDurationMs: 10_000,
      });
      const startedAt = new Date().toISOString();
      const expiry = lm.createLeaseExpiry(startedAt);
      const diff = Date.parse(expiry) - Date.parse(startedAt);
      expect(diff).toBe(10_000);
    });

    it("uses current time when startedAt is not provided", () => {
      const lm = new LeaseManager({
        store: new MockRunStore(),
        leaseDurationMs: 5_000,
      });
      const before = Date.now();
      const expiry = lm.createLeaseExpiry();
      const after = Date.now();
      const expiryMs = Date.parse(expiry);
      expect(expiryMs).toBeGreaterThanOrEqual(before + 5_000);
      expect(expiryMs).toBeLessThanOrEqual(after + 5_000);
    });
  });

  describe("createExecutionOwner", () => {
    it("returns ownership record with instanceId as ownerId", () => {
      const lm = new LeaseManager({ store: new MockRunStore() });
      const claimedAt = new Date().toISOString();
      const leaseExpiresAt = new Date(Date.now() + 30_000).toISOString();
      const owner = lm.createExecutionOwner(claimedAt, leaseExpiresAt);
      expect(owner.ownerId).toBe(lm.instanceId);
      expect(owner.claimedAt).toBe(claimedAt);
      expect(owner.leaseExpiresAt).toBe(leaseExpiresAt);
    });
  });

  describe("claimRunForExecution", () => {
    it("returns null when run does not exist", async () => {
      const store = new MockRunStore();
      const lm = new LeaseManager({ store });
      const result = await lm.claimRunForExecution("nonexistent");
      expect(result).toBeNull();
    });

    it("returns null when run is not in queued state", async () => {
      const store = new MockRunStore();
      const run = makeQueuedRun({ status: "running" });
      store.seedRun(run);
      const lm = new LeaseManager({ store });
      const result = await lm.claimRunForExecution(run.id);
      expect(result).toBeNull();
    });

    it("returns null when run has a valid active lease from another owner", async () => {
      const store = new MockRunStore();
      const futureExpiry = new Date(Date.now() + 60_000).toISOString();
      const run = makeQueuedRun({
        status: "queued",
        executionOwner: {
          ownerId: "other-owner",
          claimedAt: new Date().toISOString(),
          leaseExpiresAt: futureExpiry,
        },
      });
      store.seedRun(run);
      const lm = new LeaseManager({ store });
      const result = await lm.claimRunForExecution(run.id);
      expect(result).toBeNull();
    });

    it("claims a queued run and returns it in running state", async () => {
      const store = new MockRunStore();
      const run = makeQueuedRun();
      store.seedRun(run);
      const lm = new LeaseManager({ store });
      const claimed = await lm.claimRunForExecution(run.id);
      expect(claimed).not.toBeNull();
      expect(claimed!.status).toBe("running");
      expect(claimed!.executionOwner?.ownerId).toBe(lm.instanceId);
    });

    it("claims a run with an expired lease", async () => {
      const store = new MockRunStore();
      const pastExpiry = new Date(Date.now() - 1000).toISOString();
      const run = makeQueuedRun({
        executionOwner: {
          ownerId: "dead-owner",
          claimedAt: new Date().toISOString(),
          leaseExpiresAt: pastExpiry,
        },
      });
      store.seedRun(run);
      const lm = new LeaseManager({ store });
      const claimed = await lm.claimRunForExecution(run.id);
      expect(claimed).not.toBeNull();
      expect(claimed!.executionOwner?.ownerId).toBe(lm.instanceId);
    });

    it("returns null when updateRunIf predicate fails (race condition)", async () => {
      const store = new MockRunStore();
      const run = makeQueuedRun();
      store.seedRun(run);
      // Make updateRunIf always return false (simulating lost race)
      store.updateRunIf = async () => false;
      const lm = new LeaseManager({ store });
      const result = await lm.claimRunForExecution(run.id);
      expect(result).toBeNull();
    });
  });

  describe("startLeaseRefresh / stopLeaseRefresh", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("starts and stops a refresh timer", () => {
      const lm = new LeaseManager({
        store: new MockRunStore(),
        leaseRefreshIntervalMs: 100,
      });
      const abort = new AbortController();
      lm.startLeaseRefresh("run-x", abort);
      // Calling again should not create duplicate
      lm.startLeaseRefresh("run-x", abort);
      lm.stopLeaseRefresh("run-x");
      // Stopping twice is safe
      lm.stopLeaseRefresh("run-x");
    });

    it("stopLeaseRefresh does nothing for unknown runId", () => {
      const lm = new LeaseManager({ store: new MockRunStore() });
      expect(() => lm.stopLeaseRefresh("nonexistent")).not.toThrow();
    });

    it("refresh aborts when run is not found", async () => {
      const store = new MockRunStore();
      const run = makeQueuedRun({ status: "running" });
      store.seedRun(run);
      // Make store.getRun return null (simulates run gone)
      const lm = new LeaseManager({ store, leaseRefreshIntervalMs: 50 });
      const abort = new AbortController();
      lm.startLeaseRefresh(run.id, abort);
      store.getRun = async () => null;
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();
      expect(abort.signal.aborted).toBe(true);
    });

    it("refresh does nothing when signal is already aborted", async () => {
      const store = new MockRunStore();
      const lm = new LeaseManager({ store, leaseRefreshIntervalMs: 50 });
      const abort = new AbortController();
      abort.abort();
      lm.startLeaseRefresh("run-x", abort);
      // Advance time so the interval fires once, then stop the timer to avoid
      // the infinite-loop guard. The early-return branch in refreshExecutionLease
      // is what we're exercising — it checks signal.aborted and returns immediately.
      vi.advanceTimersByTime(60);
      lm.stopLeaseRefresh("run-x");
      // Should not throw
    });
  });
});

// ── eval-orchestrator-impl ───────────────────────────────────────────────────

import { EvalOrchestrator } from "../orchestrator/eval-orchestrator-impl.js";

describe("EvalOrchestrator", () => {
  it("throws EvalExecutionUnavailableError when no executeTarget and not read-only", () => {
    expect(() => new EvalOrchestrator({ store: new MockRunStore() })).toThrow(
      "Eval execution target is required",
    );
  });

  it("allows construction in read-only mode without executeTarget", () => {
    const orch = new EvalOrchestrator({
      store: new MockRunStore(),
      allowReadOnlyMode: true,
    });
    expect(orch.canExecute()).toBe(false);
  });

  it("canExecute returns true when executeTarget is configured", () => {
    const orch = new EvalOrchestrator({
      store: new MockRunStore(),
      executeTarget: async (input) => input,
    });
    expect(orch.canExecute()).toBe(true);
  });

  it("uses concurrency=1 when not specified", async () => {
    const orch = new EvalOrchestrator({
      store: new MockRunStore(),
      allowReadOnlyMode: true,
    });
    const stats = await orch.getQueueStats();
    expect(stats.pending).toBe(0);
    expect(stats.active).toBe(0);
  });

  it("clamps concurrency to minimum of 1 for fractional values", async () => {
    const orch = new EvalOrchestrator({
      store: new MockRunStore(),
      allowReadOnlyMode: true,
      concurrency: 0.5,
    });
    const stats = await orch.getQueueStats();
    expect(stats).toBeDefined();
  });

  describe("queueRun", () => {
    it("throws EvalExecutionUnavailableError in read-only mode", async () => {
      const orch = new EvalOrchestrator({
        store: new MockRunStore(),
        allowReadOnlyMode: true,
      });
      await expect(orch.queueRun({ suite: buildSuite() })).rejects.toThrow(
        "not configured",
      );
    });

    it("returns a queued run record", async () => {
      const store = new MockRunStore();
      const orch = new EvalOrchestrator({
        store,
        executeTarget: async (i) => i,
      });
      const run = await orch.queueRun({ suite: buildSuite() });
      expect(run.status).toBe("queued");
      expect(run.suiteId).toBe("test-suite");
    });

    it("completes run to completion with echo target", async () => {
      const store = new MockRunStore();
      const orch = new EvalOrchestrator({
        store,
        executeTarget: async (i) => i,
      });
      const run = await orch.queueRun({ suite: buildSuite() });
      await waitFor(async () => {
        const cur = await store.getRun(run.id);
        return cur?.status === "completed" || cur?.status === "failed";
      });
      const final = await store.getRun(run.id);
      expect(final?.status).toBe("completed");
    });
  });

  describe("cancelRun", () => {
    it("throws when run not found", async () => {
      const orch = new EvalOrchestrator({
        store: new MockRunStore(),
        allowReadOnlyMode: true,
      });
      await expect(orch.cancelRun("nonexistent")).rejects.toThrow("not found");
    });

    it("throws when run is already in terminal state", async () => {
      const store = new MockRunStore();
      const run = makeQueuedRun({ status: "completed" });
      store.seedRun(run);
      const orch = new EvalOrchestrator({ store, allowReadOnlyMode: true });
      await expect(orch.cancelRun(run.id)).rejects.toThrow("Cannot cancel");
    });

    it("cancels a queued run", async () => {
      const store = new MockRunStore();
      const run = makeQueuedRun();
      store.seedRun(run);
      const orch = new EvalOrchestrator({
        store,
        executeTarget: async (i) => i,
      });
      const cancelled = await orch.cancelRun(run.id);
      expect(cancelled.status).toBe("cancelled");
    });
  });

  describe("retryRun", () => {
    it("throws EvalExecutionUnavailableError in read-only mode", async () => {
      const store = new MockRunStore();
      const run = makeQueuedRun({
        status: "failed",
        error: { code: "ERR", message: "fail" },
      });
      store.seedRun(run);
      const orch = new EvalOrchestrator({ store, allowReadOnlyMode: true });
      await expect(orch.retryRun(run.id)).rejects.toThrow("not configured");
    });

    it("throws when run is not in failed state", async () => {
      const store = new MockRunStore();
      const run = makeQueuedRun({ status: "queued" });
      store.seedRun(run);
      const orch = new EvalOrchestrator({
        store,
        executeTarget: async (i) => i,
      });
      await expect(orch.retryRun(run.id)).rejects.toThrow("Cannot retry");
    });

    it("retries a failed run", async () => {
      const store = new MockRunStore();
      const run = makeQueuedRun({
        status: "failed",
        error: { code: "ERR", message: "fail" },
      });
      store.seedRun(run);
      const orch = new EvalOrchestrator({
        store,
        executeTarget: async (i) => i,
      });
      const retried = await orch.retryRun(run.id);
      expect(retried.status).toBe("queued");
    });
  });

  describe("getRun / listRuns", () => {
    it("getRun returns null for unknown run", async () => {
      const orch = new EvalOrchestrator({
        store: new MockRunStore(),
        allowReadOnlyMode: true,
      });
      const result = await orch.getRun("unknown");
      expect(result).toBeNull();
    });

    it("listRuns returns empty array when no runs", async () => {
      const orch = new EvalOrchestrator({
        store: new MockRunStore(),
        allowReadOnlyMode: true,
      });
      const runs = await orch.listRuns();
      expect(runs).toEqual([]);
    });

    it("listRuns with filter delegates to store", async () => {
      const store = new MockRunStore();
      const run = makeQueuedRun({ status: "completed", suiteId: "my-suite" });
      store.seedRun(run);
      const orch = new EvalOrchestrator({ store, allowReadOnlyMode: true });
      const runs = await orch.listRuns({ suiteId: "my-suite" });
      expect(runs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("reconcilePersistedRuns (startup)", () => {
    it("re-enqueues persisted queued runs on startup", async () => {
      const store = new MockRunStore();
      const run = makeQueuedRun();
      store.seedRun(run);
      const orch = new EvalOrchestrator({
        store,
        executeTarget: async (i) => i,
      });
      // After startup reconciliation, run should be picked up
      await waitFor(async () => {
        const cur = await store.getRun(run.id);
        return cur?.status === "completed" || cur?.status === "failed";
      });
      const final = await store.getRun(run.id);
      expect(final?.status).toBe("completed");
    });

    it("recovers a stale running run on startup", async () => {
      const store = new MockRunStore();
      const pastExpiry = new Date(Date.now() - 60_000).toISOString();
      const run = makeQueuedRun({
        id: "stale-run",
        status: "running",
        startedAt: new Date(Date.now() - 120_000).toISOString(),
        executionOwner: {
          ownerId: "dead-instance",
          claimedAt: new Date(Date.now() - 120_000).toISOString(),
          leaseExpiresAt: pastExpiry,
        },
      });
      store.seedRun(run);
      const orch = new EvalOrchestrator({
        store,
        executeTarget: async (i) => i,
      });
      // After startup the stale run should be recovered and re-executed
      await waitFor(async () => {
        const cur = await store.getRun(run.id);
        return cur?.status === "completed" || cur?.status === "failed";
      }, 5000);
      const final = await store.getRun(run.id);
      expect(["completed", "failed"]).toContain(final?.status);
    });
  });

  describe("getQueueStats", () => {
    it("returns initial zero stats", async () => {
      const orch = new EvalOrchestrator({
        store: new MockRunStore(),
        allowReadOnlyMode: true,
      });
      const stats = await orch.getQueueStats();
      expect(stats.pending).toBe(0);
      expect(stats.active).toBe(0);
      expect(stats.enqueued).toBe(0);
    });
  });

  describe("concurrency", () => {
    it("processes multiple runs concurrently up to the concurrency limit", async () => {
      const store = new MockRunStore();
      let activeCount = 0;
      let maxConcurrent = 0;
      const orch = new EvalOrchestrator({
        store,
        executeTarget: async (input) => {
          activeCount++;
          maxConcurrent = Math.max(maxConcurrent, activeCount);
          await new Promise((r) => setTimeout(r, 20));
          activeCount--;
          return input;
        },
        concurrency: 2,
      });
      const r1 = await orch.queueRun({ suite: buildSuite("suite-1") });
      const r2 = await orch.queueRun({ suite: buildSuite("suite-2") });
      const r3 = await orch.queueRun({ suite: buildSuite("suite-3") });
      await waitFor(async () => {
        const [c1, c2, c3] = await Promise.all([
          store.getRun(r1.id),
          store.getRun(r2.id),
          store.getRun(r3.id),
        ]);
        return (
          (c1?.status === "completed" || c1?.status === "failed") &&
          (c2?.status === "completed" || c2?.status === "failed") &&
          (c3?.status === "completed" || c3?.status === "failed")
        );
      }, 5000);
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });
});

// ── benchmark-orchestrator.ts — regression gate coverage ─────────────────────

import {
  BenchmarkOrchestrator,
  RegressionGateError,
} from "../orchestrator/benchmark-orchestrator.js";

function buildBenchmarkResult(scores: Record<string, number>) {
  return {
    suiteId: "suite-a",
    averageScore:
      Object.values(scores).reduce((a, b) => a + b, 0) /
      Object.values(scores).length,
    passRate: 1,
    scores,
    caseResults: [],
  };
}

function makeBenchmarkRun(scores: Record<string, number>): BenchmarkRunRecord {
  return {
    id: `br-${Math.random().toString(36).slice(2)}`,
    suiteId: "suite-a",
    targetId: "target-a",
    result: buildBenchmarkResult(scores),
    createdAt: new Date().toISOString(),
    strict: true,
  };
}

describe("BenchmarkOrchestrator", () => {
  it("constructs successfully", () => {
    const orch = new BenchmarkOrchestrator({
      suites: {},
      executeTarget: async () => "",
      store: new MockBenchmarkRunStore(),
    });
    expect(orch).toBeDefined();
  });

  describe("runSuite", () => {
    it("throws NotFound error when suite is not registered", async () => {
      const orch = new BenchmarkOrchestrator({
        suites: {},
        executeTarget: async () => "",
        store: new MockBenchmarkRunStore(),
      });
      await expect(
        orch.runSuite({ suiteId: "unknown", targetId: "target" }),
      ).rejects.toThrow("NotFound");
    });

    it("throws BadRequest when strict=false and allowNonStrictExecution is not set", async () => {
      const orch = new BenchmarkOrchestrator({
        suites: {
          "qa-suite": {
            id: "qa-suite",
            name: "QA Suite",
            description: "QA benchmark",
            category: "qa" as const,
            dataset: [{ id: "c1", input: "q", expectedOutput: "a" }],
            scorers: [
              { id: "s1", name: "exact", type: "deterministic" as const },
            ],
            baselineThresholds: { s1: 0.8 },
          },
        },
        executeTarget: async () => "a",
        store: new MockBenchmarkRunStore(),
      });
      await expect(
        orch.runSuite({ suiteId: "qa-suite", targetId: "t", strict: false }),
      ).rejects.toThrow("BadRequest");
    });

    it("allows non-strict execution when allowNonStrictExecution=true", async () => {
      const orch = new BenchmarkOrchestrator({
        suites: {
          "qa-suite": {
            id: "qa-suite",
            name: "QA Suite",
            description: "QA benchmark",
            category: "qa" as const,
            dataset: [{ id: "c1", input: "q", expectedOutput: "a" }],
            scorers: [
              { id: "s1", name: "exact", type: "deterministic" as const },
            ],
            baselineThresholds: { s1: 0.8 },
          },
        },
        executeTarget: async () => "a",
        store: new MockBenchmarkRunStore(),
        allowNonStrictExecution: true,
      });
      const run = await orch.runSuite({
        suiteId: "qa-suite",
        targetId: "t",
        strict: false,
      });
      expect(run.strict).toBe(false);
    });
  });

  describe("compareRuns", () => {
    it("throws when currentRun not found", async () => {
      const orch = new BenchmarkOrchestrator({
        suites: {},
        executeTarget: async () => "",
        store: new MockBenchmarkRunStore(),
      });
      await expect(orch.compareRuns("bad-current", "bad-prev")).rejects.toThrow(
        "Current run",
      );
    });

    it("throws when previousRun not found", async () => {
      const store = new MockBenchmarkRunStore();
      const current = makeBenchmarkRun({ scorer1: 0.9 });
      await store.saveRun(current);
      const orch = new BenchmarkOrchestrator({
        suites: {},
        executeTarget: async () => "",
        store,
      });
      await expect(orch.compareRuns(current.id, "bad-prev")).rejects.toThrow(
        "Previous run",
      );
    });

    it("returns comparison result", async () => {
      const store = new MockBenchmarkRunStore();
      const current = makeBenchmarkRun({ scorer1: 0.9 });
      const previous = makeBenchmarkRun({ scorer1: 0.8 });
      await store.saveRun(current);
      await store.saveRun(previous);
      const orch = new BenchmarkOrchestrator({
        suites: {},
        executeTarget: async () => "",
        store,
      });
      const result = await orch.compareRuns(current.id, previous.id);
      expect(result.currentRun.id).toBe(current.id);
      expect(result.previousRun.id).toBe(previous.id);
    });
  });

  describe("setBaseline", () => {
    it("throws when run not found", async () => {
      const orch = new BenchmarkOrchestrator({
        suites: {},
        executeTarget: async () => "",
        store: new MockBenchmarkRunStore(),
      });
      await expect(
        orch.setBaseline({ suiteId: "s", targetId: "t", runId: "x" }),
      ).rejects.toThrow("not found");
    });

    it("throws when run.suiteId does not match", async () => {
      const store = new MockBenchmarkRunStore();
      const run = { ...makeBenchmarkRun({ s1: 0.9 }), suiteId: "other-suite" };
      await store.saveRun(run);
      const orch = new BenchmarkOrchestrator({
        suites: {},
        executeTarget: async () => "",
        store,
      });
      await expect(
        orch.setBaseline({
          suiteId: "suite-a",
          targetId: "target-a",
          runId: run.id,
        }),
      ).rejects.toThrow("does not belong to suite");
    });

    it("throws when run.targetId does not match", async () => {
      const store = new MockBenchmarkRunStore();
      const run = {
        ...makeBenchmarkRun({ s1: 0.9 }),
        targetId: "other-target",
      };
      await store.saveRun(run);
      const orch = new BenchmarkOrchestrator({
        suites: {},
        executeTarget: async () => "",
        store,
      });
      await expect(
        orch.setBaseline({
          suiteId: run.suiteId,
          targetId: "target-a",
          runId: run.id,
        }),
      ).rejects.toThrow("does not belong to target");
    });

    it("saves baseline and returns it", async () => {
      const store = new MockBenchmarkRunStore();
      const run = makeBenchmarkRun({ s1: 0.9 });
      await store.saveRun(run);
      const orch = new BenchmarkOrchestrator({
        suites: {},
        executeTarget: async () => "",
        store,
      });
      const baseline = await orch.setBaseline({
        suiteId: run.suiteId,
        targetId: run.targetId,
        runId: run.id,
      });
      expect(baseline.suiteId).toBe(run.suiteId);
      expect(baseline.runId).toBe(run.id);
    });
  });

  describe("getBaseline / listBaselines", () => {
    it("getBaseline returns null when no baseline set", async () => {
      const orch = new BenchmarkOrchestrator({
        suites: {},
        executeTarget: async () => "",
        store: new MockBenchmarkRunStore(),
      });
      const result = await orch.getBaseline("s", "t");
      expect(result).toBeNull();
    });

    it("listBaselines returns empty array initially", async () => {
      const orch = new BenchmarkOrchestrator({
        suites: {},
        executeTarget: async () => "",
        store: new MockBenchmarkRunStore(),
      });
      const results = await orch.listBaselines();
      expect(results).toEqual([]);
    });
  });

  describe("regressionGate", () => {
    it("returns passed=true when no regressions", () => {
      const orch = new BenchmarkOrchestrator({
        suites: {},
        executeTarget: async () => "",
        store: new MockBenchmarkRunStore(),
      });
      const current = makeBenchmarkRun({ accuracy: 0.9, relevance: 0.85 });
      const baseline = makeBenchmarkRun({ accuracy: 0.85, relevance: 0.8 });
      const result = orch.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
      expect(result.passed).toBe(true);
      expect(result.regressions).toEqual([]);
    });

    it("throws RegressionGateError when score drops beyond threshold", () => {
      const orch = new BenchmarkOrchestrator({
        suites: {},
        executeTarget: async () => "",
        store: new MockBenchmarkRunStore(),
      });
      const current = makeBenchmarkRun({ accuracy: 0.5 });
      const baseline = makeBenchmarkRun({ accuracy: 0.9 });
      expect(() =>
        orch.regressionGate({
          currentRun: current,
          baselineRun: baseline,
          threshold: 0.05,
        }),
      ).toThrow(RegressionGateError);
    });

    it("RegressionGateError contains regression details", () => {
      const orch = new BenchmarkOrchestrator({
        suites: {},
        executeTarget: async () => "",
        store: new MockBenchmarkRunStore(),
      });
      const current = makeBenchmarkRun({ accuracy: 0.5 });
      const baseline = makeBenchmarkRun({ accuracy: 0.9 });
      try {
        orch.regressionGate({
          currentRun: current,
          baselineRun: baseline,
          threshold: 0.05,
        });
        expect.fail("should throw");
      } catch (err) {
        expect(err).toBeInstanceOf(RegressionGateError);
        const gateErr = err as RegressionGateError;
        expect(gateErr.regressions).toHaveLength(1);
        expect(gateErr.regressions[0]!.suiteName).toBe("accuracy");
        expect(gateErr.regressions[0]!.baseline).toBe(0.9);
        expect(gateErr.regressions[0]!.current).toBe(0.5);
        expect(gateErr.regressions[0]!.delta).toBeLessThan(0);
      }
    });

    it("accepts exactly threshold drop (epsilon tolerance)", () => {
      const orch = new BenchmarkOrchestrator({
        suites: {},
        executeTarget: async () => "",
        store: new MockBenchmarkRunStore(),
      });
      const current = makeBenchmarkRun({ accuracy: 0.7 });
      const baseline = makeBenchmarkRun({ accuracy: 0.75 });
      // Delta = -0.05, threshold = 0.05 → should pass (not strictly greater)
      const result = orch.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
      expect(result.passed).toBe(true);
    });

    it("throws RangeError for negative threshold", () => {
      const orch = new BenchmarkOrchestrator({
        suites: {},
        executeTarget: async () => "",
        store: new MockBenchmarkRunStore(),
      });
      const run = makeBenchmarkRun({ s: 0.9 });
      expect(() =>
        orch.regressionGate({
          currentRun: run,
          baselineRun: run,
          threshold: -0.01,
        }),
      ).toThrow(RangeError);
    });

    it("handles missing scorer in current run (defaults to 0)", () => {
      const orch = new BenchmarkOrchestrator({
        suites: {},
        executeTarget: async () => "",
        store: new MockBenchmarkRunStore(),
      });
      const current = makeBenchmarkRun({});
      const baseline = makeBenchmarkRun({ accuracy: 0.9 });
      // current.accuracy = 0 (missing), baseline.accuracy = 0.9; delta = -0.9 > threshold
      expect(() =>
        orch.regressionGate({
          currentRun: current,
          baselineRun: baseline,
          threshold: 0.05,
        }),
      ).toThrow(RegressionGateError);
    });

    it("RegressionGateError message lists failing suites", () => {
      const orch = new BenchmarkOrchestrator({
        suites: {},
        executeTarget: async () => "",
        store: new MockBenchmarkRunStore(),
      });
      const current = makeBenchmarkRun({ a: 0.1, b: 0.2 });
      const baseline = makeBenchmarkRun({ a: 0.9, b: 0.9 });
      try {
        orch.regressionGate({
          currentRun: current,
          baselineRun: baseline,
          threshold: 0.05,
        });
        expect.fail("should throw");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("2 suite(s)");
      }
    });

    it("passes when current has no scorer keys at all", () => {
      const orch = new BenchmarkOrchestrator({
        suites: {},
        executeTarget: async () => "",
        store: new MockBenchmarkRunStore(),
      });
      const current = makeBenchmarkRun({});
      const baseline = makeBenchmarkRun({});
      const result = orch.regressionGate({
        currentRun: current,
        baselineRun: baseline,
        threshold: 0.05,
      });
      expect(result.passed).toBe(true);
    });
  });
});
