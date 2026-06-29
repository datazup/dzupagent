// @ts-nocheck
/**
 * W31-C — HITL-kit: escalation policy deep coverage.
 *
 * All escalation infrastructure is self-contained test code — no changes to
 * production source.  The escalation engine is built on top of the real
 * InMemoryApprovalStateStore + ApprovalGate so every integration path is
 * exercised against the production primitives.
 *
 * Coverage targets
 *   - Escalation chain: level 1 → level 2 → level 3 on consecutive timeouts
 *   - SLA tracking: deadline computed from creation time; time-remaining math
 *   - SLA breach detection + callback
 *   - Notification routing: each level delivers to the correct notifier (mocked)
 *   - Policy configuration: maxLevels, per-level timeout, per-level notifier
 *   - Early resolution: approval at level 2 stops chain before level 3
 *   - Rejection at any level propagates immediately; no further escalation
 *   - Policy validation: negative timeout, empty levels → error at setup
 *   - Cooldown between escalation steps
 *   - Escalation metadata: who, when, which level — all recorded
 *   - Concurrent escalations: two independent requests never interfere
 *   - Request-level policy override of global policy
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ApprovalGate,
  ApprovalTimeoutError,
  InMemoryApprovalStateStore,
  type ApprovalOutcome,
  type ApprovalStateStore,
} from "../index.js";

// ============================================================================
// Self-contained Escalation Engine
// ============================================================================

/** Notifier interface — one implementation per channel (email, Slack, etc.). */
interface EscalationNotifier {
  notify(event: EscalationEvent): Promise<void>;
}

interface EscalationEvent {
  runId: string;
  approvalId: string;
  level: number;
  approvers: string[];
  reason: string;
  notifiedAt: Date;
}

interface EscalationLevel {
  /** Human-readable label, e.g. "team-lead", "vp-eng". */
  name: string;
  /** Approver identifiers at this level. */
  approvers: string[];
  /** How long (ms) to wait before escalating to next level. */
  timeoutMs: number;
  /** Notifier to invoke when this level activates. */
  notifier: EscalationNotifier;
  /** Optional minimum cooldown (ms) that must elapse before this level fires. */
  cooldownMs?: number;
}

interface EscalationPolicy {
  levels: EscalationLevel[];
  /** Total SLA deadline in ms from request creation. */
  slaMs: number;
  /** Called when the SLA deadline is breached (all levels exhausted / timed out). */
  onSlaBreach?: (runId: string, approvalId: string) => void;
}

/** Validates a policy at construction time; throws descriptive errors. */
function validatePolicy(policy: EscalationPolicy): void {
  if (!policy.levels || policy.levels.length === 0) {
    throw new Error("EscalationPolicy must have at least one level");
  }
  for (let i = 0; i < policy.levels.length; i++) {
    const lvl = policy.levels[i];
    if (!lvl.name || lvl.name.trim() === "") {
      throw new Error(`Level ${i}: name must be a non-empty string`);
    }
    if (!lvl.approvers || lvl.approvers.length === 0) {
      throw new Error(`Level ${i} (${lvl.name}): approvers must be non-empty`);
    }
    if (typeof lvl.timeoutMs !== "number" || lvl.timeoutMs <= 0) {
      throw new Error(
        `Level ${i} (${lvl.name}): timeoutMs must be a positive number`
      );
    }
    if (lvl.cooldownMs !== undefined && lvl.cooldownMs < 0) {
      throw new Error(
        `Level ${i} (${lvl.name}): cooldownMs must be non-negative`
      );
    }
    if (!lvl.notifier || typeof lvl.notifier.notify !== "function") {
      throw new Error(
        `Level ${i} (${lvl.name}): notifier must implement notify()`
      );
    }
  }
  if (typeof policy.slaMs !== "number" || policy.slaMs <= 0) {
    throw new Error("EscalationPolicy.slaMs must be a positive number");
  }
}

// ---------------------------------------------------------------------------
// Metadata log entry
// ---------------------------------------------------------------------------

interface EscalationRecord {
  runId: string;
  approvalId: string;
  level: number;
  levelName: string;
  approvers: string[];
  notifiedAt: Date;
}

interface ResolutionRecord {
  runId: string;
  approvalId: string;
  decision: "granted" | "rejected";
  resolvedAtLevel: number;
  resolvedBy?: string;
  reason?: string;
  resolvedAt: Date;
}

// ---------------------------------------------------------------------------
// EscalationEngine
// ---------------------------------------------------------------------------

/**
 * Drives an escalation chain for a single approval request.
 *
 * Interacts only with InMemoryApprovalStateStore for persistence so that
 * the full store contract is exercised.
 */
class EscalationEngine {
  private readonly escalationLog: EscalationRecord[] = [];
  private readonly resolutionLog: ResolutionRecord[] = [];
  private slaBreach = false;
  private createdAt: Date | null = null;

  constructor(
    private readonly store: InMemoryApprovalStateStore,
    private readonly policy: EscalationPolicy
  ) {
    validatePolicy(policy);
  }

  /** Start an escalation chain; returns the final outcome. */
  async run(
    runId: string,
    approvalId: string,
    payload: unknown,
    overridePolicy?: Partial<EscalationPolicy>
  ): Promise<ApprovalOutcome> {
    const effective: EscalationPolicy = overridePolicy
      ? { ...this.policy, ...overridePolicy }
      : this.policy;

    this.createdAt = new Date();
    await this.store.createPending(runId, approvalId, payload);

    const slaTimer = setTimeout(() => {
      this.slaBreach = true;
      effective.onSlaBreach?.(runId, approvalId);
    }, effective.slaMs);

    try {
      return await this.runChain(runId, approvalId, approvalId, effective, 0);
    } finally {
      clearTimeout(slaTimer);
    }
  }

  private async runChain(
    runId: string,
    baseApprovalId: string,
    currentApprovalId: string,
    policy: EscalationPolicy,
    levelIndex: number
  ): Promise<ApprovalOutcome> {
    if (levelIndex >= policy.levels.length) {
      // All levels exhausted → treat as SLA breach
      this.slaBreach = true;
      policy.onSlaBreach?.(runId, baseApprovalId);
      throw new ApprovalTimeoutError(runId, baseApprovalId, policy.slaMs);
    }

    const level = policy.levels[levelIndex];

    // Cooldown: wait the minimum time before firing this level
    if (level.cooldownMs && level.cooldownMs > 0) {
      await new Promise<void>((res) => setTimeout(res, level.cooldownMs));
    }

    // Notify
    const event: EscalationEvent = {
      runId,
      approvalId: currentApprovalId,
      level: levelIndex + 1,
      approvers: level.approvers,
      reason:
        levelIndex === 0
          ? "Initial escalation"
          : `Level ${levelIndex} timed out`,
      notifiedAt: new Date(),
    };
    await level.notifier.notify(event);

    // Record metadata — first entry uses baseApprovalId for easy lookup
    this.escalationLog.push({
      runId,
      approvalId: levelIndex === 0 ? baseApprovalId : currentApprovalId,
      level: levelIndex + 1,
      levelName: level.name,
      approvers: level.approvers,
      notifiedAt: event.notifiedAt,
    });

    // Poll this level
    try {
      const outcome = await this.store.poll(
        runId,
        currentApprovalId,
        level.timeoutMs
      );
      this.resolutionLog.push({
        runId,
        approvalId: currentApprovalId,
        decision: outcome.decision,
        resolvedAtLevel: levelIndex + 1,
        resolvedAt: new Date(),
        reason: outcome.reason,
      });
      return outcome;
    } catch (err) {
      if (err instanceof ApprovalTimeoutError) {
        // Escalate to next level — key always suffixed from the BASE approvalId
        // so tests can predict "ap1::lvl2", "ap1::lvl3" regardless of depth.
        const nextApprovalId = `${baseApprovalId}::lvl${levelIndex + 2}`;
        await this.store.createPending(runId, nextApprovalId, null);
        return this.runChain(
          runId,
          baseApprovalId,
          nextApprovalId,
          policy,
          levelIndex + 1
        );
      }
      throw err;
    }
  }

  /** SLA calculation helpers. */
  slaDeadline(runId: string): Date | null {
    if (!this.createdAt) return null;
    return new Date(this.createdAt.getTime() + this.policy.slaMs);
  }

  timeRemainingMs(): number | null {
    if (!this.createdAt) return null;
    const deadline = this.createdAt.getTime() + this.policy.slaMs;
    return Math.max(0, deadline - Date.now());
  }

  isSlaBreach(): boolean {
    return this.slaBreach;
  }

  getEscalationLog(): readonly EscalationRecord[] {
    return this.escalationLog;
  }

  getResolutionLog(): readonly ResolutionRecord[] {
    return this.resolutionLog;
  }
}

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function makeNotifier(): EscalationNotifier & {
  calls: EscalationEvent[];
} {
  const calls: EscalationEvent[] = [];
  return {
    calls,
    async notify(event) {
      calls.push(event);
    },
  };
}

function makePolicy(
  overrides: Partial<EscalationPolicy> & {
    levelOverrides?: Partial<EscalationLevel>[];
  } = {}
): {
  policy: EscalationPolicy;
  notifiers: ReturnType<typeof makeNotifier>[];
} {
  const n1 = makeNotifier();
  const n2 = makeNotifier();
  const n3 = makeNotifier();
  const notifiers = [n1, n2, n3];

  const defaultLevels: EscalationLevel[] = [
    {
      name: "team-lead",
      approvers: ["alice"],
      timeoutMs: 50,
      notifier: n1,
    },
    {
      name: "manager",
      approvers: ["bob"],
      timeoutMs: 50,
      notifier: n2,
    },
    {
      name: "vp-eng",
      approvers: ["charlie"],
      timeoutMs: 50,
      notifier: n3,
    },
  ];

  const levels = defaultLevels.map((lvl, i) => ({
    ...lvl,
    ...(overrides.levelOverrides?.[i] ?? {}),
  }));

  const policy: EscalationPolicy = {
    levels,
    slaMs: overrides.slaMs ?? 500,
    onSlaBreach: overrides.onSlaBreach,
  };

  return { policy, notifiers };
}

// ============================================================================
// Tests
// ============================================================================

describe("EscalationPolicy — policy validation", () => {
  it("throws when levels array is empty", () => {
    const { policy, notifiers } = makePolicy();
    const store = new InMemoryApprovalStateStore();
    expect(
      () =>
        new EscalationEngine(store, {
          ...policy,
          levels: [],
        })
    ).toThrow("at least one level");
  });

  it("throws when a level has negative timeoutMs", () => {
    const { policy } = makePolicy({ levelOverrides: [{ timeoutMs: -1 }] });
    const store = new InMemoryApprovalStateStore();
    expect(() => new EscalationEngine(store, policy)).toThrow(
      "timeoutMs must be a positive number"
    );
  });

  it("throws when a level has zero timeoutMs", () => {
    const { policy } = makePolicy({ levelOverrides: [{ timeoutMs: 0 }] });
    const store = new InMemoryApprovalStateStore();
    expect(() => new EscalationEngine(store, policy)).toThrow(
      "timeoutMs must be a positive number"
    );
  });

  it("throws when a level has an empty approvers list", () => {
    const { policy } = makePolicy({ levelOverrides: [{ approvers: [] }] });
    const store = new InMemoryApprovalStateStore();
    expect(() => new EscalationEngine(store, policy)).toThrow(
      "approvers must be non-empty"
    );
  });

  it("throws when a level name is empty string", () => {
    const { policy } = makePolicy({ levelOverrides: [{ name: "" }] });
    const store = new InMemoryApprovalStateStore();
    expect(() => new EscalationEngine(store, policy)).toThrow(
      "name must be a non-empty string"
    );
  });

  it("throws when a level name is whitespace-only", () => {
    const { policy } = makePolicy({ levelOverrides: [{ name: "   " }] });
    const store = new InMemoryApprovalStateStore();
    expect(() => new EscalationEngine(store, policy)).toThrow(
      "name must be a non-empty string"
    );
  });

  it("throws when slaMs is zero", () => {
    const { policy } = makePolicy({ slaMs: 0 });
    const store = new InMemoryApprovalStateStore();
    expect(() => new EscalationEngine(store, policy)).toThrow(
      "slaMs must be a positive number"
    );
  });

  it("throws when slaMs is negative", () => {
    const { policy } = makePolicy({ slaMs: -100 });
    const store = new InMemoryApprovalStateStore();
    expect(() => new EscalationEngine(store, policy)).toThrow(
      "slaMs must be a positive number"
    );
  });

  it("throws when a level has a negative cooldownMs", () => {
    const { policy } = makePolicy({
      levelOverrides: [{ cooldownMs: -5 }],
    });
    const store = new InMemoryApprovalStateStore();
    expect(() => new EscalationEngine(store, policy)).toThrow(
      "cooldownMs must be non-negative"
    );
  });

  it("throws when a notifier is missing", () => {
    const { policy } = makePolicy();
    const store = new InMemoryApprovalStateStore();
    const badPolicy = {
      ...policy,
      levels: [
        {
          ...policy.levels[0],
          notifier: null as unknown as EscalationNotifier,
        },
      ],
    };
    expect(() => new EscalationEngine(store, badPolicy)).toThrow(
      "notifier must implement notify()"
    );
  });

  it("accepts a valid two-level policy without throwing", () => {
    const { policy } = makePolicy();
    const store = new InMemoryApprovalStateStore();
    const twoLevelPolicy = { ...policy, levels: policy.levels.slice(0, 2) };
    expect(() => new EscalationEngine(store, twoLevelPolicy)).not.toThrow();
  });

  it("accepts a zero cooldownMs (no cooldown) without throwing", () => {
    const { policy } = makePolicy({ levelOverrides: [{ cooldownMs: 0 }] });
    const store = new InMemoryApprovalStateStore();
    expect(() => new EscalationEngine(store, policy)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("EscalationPolicy — level 1 approval (no escalation)", () => {
  let store: InMemoryApprovalStateStore;
  let engine: EscalationEngine;
  let notifiers: ReturnType<typeof makeNotifier>[];

  beforeEach(() => {
    store = new InMemoryApprovalStateStore();
    const built = makePolicy({
      levelOverrides: [
        { timeoutMs: 5_000 }, // long — should not time out
        { timeoutMs: 5_000 },
        { timeoutMs: 5_000 },
      ],
    });
    notifiers = built.notifiers;
    engine = new EscalationEngine(store, built.policy);
  });

  afterEach(() => {
    store.clear();
  });

  it("resolves immediately when level 1 approves", async () => {
    const runPromise = engine.run("r1", "ap1", { action: "deploy" });
    await Promise.resolve(); // allow createPending microtask
    await store.grant("r1", "ap1", { approvedBy: "alice" });
    const outcome = await runPromise;
    expect(outcome.decision).toBe("granted");
  });

  it("notifies only level 1 notifier when approved at level 1", async () => {
    const runPromise = engine.run("r1", "ap1", null);
    await Promise.resolve();
    await store.grant("r1", "ap1");
    await runPromise;
    expect(notifiers[0].calls).toHaveLength(1);
    expect(notifiers[1].calls).toHaveLength(0);
    expect(notifiers[2].calls).toHaveLength(0);
  });

  it("records escalation log entry for level 1", async () => {
    const runPromise = engine.run("r1", "ap1", null);
    await Promise.resolve();
    await store.grant("r1", "ap1");
    await runPromise;
    const log = engine.getEscalationLog();
    expect(log).toHaveLength(1);
    expect(log[0].level).toBe(1);
    expect(log[0].levelName).toBe("team-lead");
    expect(log[0].approvers).toContain("alice");
  });

  it("records resolution log with level 1 and granted decision", async () => {
    const runPromise = engine.run("r1", "ap1", null);
    await Promise.resolve();
    await store.grant("r1", "ap1");
    await runPromise;
    const res = engine.getResolutionLog();
    expect(res).toHaveLength(1);
    expect(res[0].decision).toBe("granted");
    expect(res[0].resolvedAtLevel).toBe(1);
  });

  it("rejection at level 1 is final — outcome is rejected", async () => {
    const runPromise = engine.run("r1", "ap1", null);
    await Promise.resolve();
    await store.reject("r1", "ap1", "security risk");
    const outcome = await runPromise;
    expect(outcome.decision).toBe("rejected");
    expect(outcome.reason).toBe("security risk");
  });

  it("rejection at level 1 does not escalate — notifier 2 stays silent", async () => {
    const runPromise = engine.run("r1", "ap1", null);
    await Promise.resolve();
    await store.reject("r1", "ap1", "no");
    await runPromise;
    expect(notifiers[1].calls).toHaveLength(0);
  });

  it("notifier receives correct event shape at level 1", async () => {
    const runPromise = engine.run("r1", "ap1", null);
    await Promise.resolve();
    await store.grant("r1", "ap1");
    await runPromise;
    const evt = notifiers[0].calls[0];
    expect(evt.runId).toBe("r1");
    expect(evt.approvalId).toBe("ap1");
    expect(evt.level).toBe(1);
    expect(evt.approvers).toEqual(["alice"]);
    expect(evt.notifiedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------

describe("EscalationPolicy — escalation chain (level 1 → 2 → 3)", () => {
  let store: InMemoryApprovalStateStore;
  let engine: EscalationEngine;
  let notifiers: ReturnType<typeof makeNotifier>[];

  beforeEach(() => {
    store = new InMemoryApprovalStateStore();
    const built = makePolicy();
    notifiers = built.notifiers;
    engine = new EscalationEngine(store, built.policy);
  });

  afterEach(() => {
    store.clear();
  });

  it("escalates to level 2 when level 1 times out", async () => {
    const runPromise = engine.run("r1", "ap1", null);
    // Level 1 will time out (timeoutMs=50); level 2 key = "ap1::lvl2"
    // Grant level 2 after it has been created.
    await new Promise<void>((res) => setTimeout(res, 80));
    await store.grant("r1", "ap1::lvl2");
    const outcome = await runPromise;
    expect(outcome.decision).toBe("granted");
    expect(notifiers[0].calls).toHaveLength(1);
    expect(notifiers[1].calls).toHaveLength(1);
    expect(notifiers[2].calls).toHaveLength(0);
  });

  it("level 2 notifier receives level=2 in the event", async () => {
    const runPromise = engine.run("r1", "ap1", null);
    await new Promise<void>((res) => setTimeout(res, 80));
    await store.grant("r1", "ap1::lvl2");
    await runPromise;
    expect(notifiers[1].calls[0].level).toBe(2);
    expect(notifiers[1].calls[0].approvers).toEqual(["bob"]);
  });

  it("escalates to level 3 when level 1 and 2 both time out", async () => {
    // Use a dedicated engine so level 3 has a long timeout (no race on grant)
    const localStore = new InMemoryApprovalStateStore();
    const { policy: localPolicy, notifiers: localNotifiers } = makePolicy({
      levelOverrides: [
        { timeoutMs: 50 },
        { timeoutMs: 50 },
        { timeoutMs: 5_000 }, // level 3 stays open until we grant it
      ],
    });
    const localEngine = new EscalationEngine(localStore, localPolicy);
    const runPromise = localEngine.run("r1", "ap1", null);
    // Level 1 expires at ~50ms, level 2 expires at ~100ms, level 3 opens ~100ms
    await new Promise<void>((res) => setTimeout(res, 160));
    await localStore.grant("r1", "ap1::lvl3");
    const outcome = await runPromise;
    localStore.clear();
    expect(outcome.decision).toBe("granted");
    expect(localNotifiers[0].calls).toHaveLength(1);
    expect(localNotifiers[1].calls).toHaveLength(1);
    expect(localNotifiers[2].calls).toHaveLength(1);
  });

  it("level 3 notifier event has level=3 and correct approvers", async () => {
    const localStore = new InMemoryApprovalStateStore();
    const { policy: localPolicy, notifiers: localNotifiers } = makePolicy({
      levelOverrides: [
        { timeoutMs: 50 },
        { timeoutMs: 50 },
        { timeoutMs: 5_000 },
      ],
    });
    const localEngine = new EscalationEngine(localStore, localPolicy);
    const runPromise = localEngine.run("r1", "ap1", null);
    await new Promise<void>((res) => setTimeout(res, 160));
    await localStore.grant("r1", "ap1::lvl3");
    await runPromise;
    localStore.clear();
    const evt = localNotifiers[2].calls[0];
    expect(evt.level).toBe(3);
    expect(evt.approvers).toEqual(["charlie"]);
  });

  it("throws ApprovalTimeoutError when all three levels time out", async () => {
    await expect(engine.run("r1", "ap1", null)).rejects.toBeInstanceOf(
      ApprovalTimeoutError
    );
  });

  it("escalation log has three entries after full chain timeout", async () => {
    await expect(engine.run("r1", "ap1", null)).rejects.toBeInstanceOf(
      ApprovalTimeoutError
    );
    expect(engine.getEscalationLog()).toHaveLength(3);
  });

  it("escalation log entries have ascending level numbers", async () => {
    await expect(engine.run("r1", "ap1", null)).rejects.toBeInstanceOf(
      ApprovalTimeoutError
    );
    const log = engine.getEscalationLog();
    expect(log.map((e) => e.level)).toEqual([1, 2, 3]);
  });

  it("escalation log records the correct levelName for each entry", async () => {
    await expect(engine.run("r1", "ap1", null)).rejects.toBeInstanceOf(
      ApprovalTimeoutError
    );
    const log = engine.getEscalationLog();
    expect(log[0].levelName).toBe("team-lead");
    expect(log[1].levelName).toBe("manager");
    expect(log[2].levelName).toBe("vp-eng");
  });

  it("rejection at level 2 does not escalate to level 3", async () => {
    const runPromise = engine.run("r1", "ap1", null);
    await new Promise<void>((res) => setTimeout(res, 80));
    await store.reject("r1", "ap1::lvl2", "manager said no");
    const outcome = await runPromise;
    expect(outcome.decision).toBe("rejected");
    expect(notifiers[2].calls).toHaveLength(0);
  });

  it("resolution log records resolvedAtLevel=2 when level 2 grants", async () => {
    const runPromise = engine.run("r1", "ap1", null);
    await new Promise<void>((res) => setTimeout(res, 80));
    await store.grant("r1", "ap1::lvl2");
    await runPromise;
    const res = engine.getResolutionLog();
    expect(res[0].resolvedAtLevel).toBe(2);
  });

  it("resolution log records resolvedAtLevel=3 when level 3 grants", async () => {
    const localStore = new InMemoryApprovalStateStore();
    const { policy: localPolicy } = makePolicy({
      levelOverrides: [
        { timeoutMs: 50 },
        { timeoutMs: 50 },
        { timeoutMs: 5_000 },
      ],
    });
    const localEngine = new EscalationEngine(localStore, localPolicy);
    const runPromise = localEngine.run("r1", "ap1", null);
    await new Promise<void>((res) => setTimeout(res, 160));
    await localStore.grant("r1", "ap1::lvl3");
    await runPromise;
    localStore.clear();
    expect(localEngine.getResolutionLog()[0].resolvedAtLevel).toBe(3);
  });
});

// ---------------------------------------------------------------------------

describe("EscalationPolicy — SLA tracking", () => {
  let store: InMemoryApprovalStateStore;

  afterEach(() => {
    store?.clear();
  });

  it("slaDeadline returns null before run() is called", () => {
    store = new InMemoryApprovalStateStore();
    const { policy } = makePolicy({ slaMs: 300 });
    const engine = new EscalationEngine(store, policy);
    expect(engine.slaDeadline("r1")).toBeNull();
  });

  it("slaDeadline is approximately createdAt + slaMs", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy } = makePolicy({
      slaMs: 200,
      levelOverrides: [{ timeoutMs: 5_000 }],
    });
    const engine = new EscalationEngine(store, policy);
    const before = Date.now();
    const runPromise = engine.run("r1", "ap1", null);
    await Promise.resolve();
    const deadline = engine.slaDeadline("r1")!;
    expect(deadline).toBeInstanceOf(Date);
    expect(deadline.getTime()).toBeGreaterThanOrEqual(before + 200 - 5);
    expect(deadline.getTime()).toBeLessThanOrEqual(Date.now() + 200 + 10);
    await store.grant("r1", "ap1");
    await runPromise;
  });

  it("timeRemainingMs returns null before run() is called", () => {
    store = new InMemoryApprovalStateStore();
    const { policy } = makePolicy();
    const engine = new EscalationEngine(store, policy);
    expect(engine.timeRemainingMs()).toBeNull();
  });

  it("timeRemainingMs returns a positive value shortly after run starts", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy } = makePolicy({
      slaMs: 500,
      levelOverrides: [{ timeoutMs: 5_000 }],
    });
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap1", null);
    await Promise.resolve();
    const remaining = engine.timeRemainingMs()!;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(500);
    await store.grant("r1", "ap1");
    await runPromise;
  });

  it("timeRemainingMs returns 0 after SLA period has elapsed", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy } = makePolicy({
      slaMs: 30,
      levelOverrides: [{ timeoutMs: 5_000 }],
    });
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap1", null);
    await new Promise<void>((res) => setTimeout(res, 60));
    expect(engine.timeRemainingMs()!).toBe(0);
    await store.grant("r1", "ap1");
    await runPromise;
  });
});

// ---------------------------------------------------------------------------

describe("EscalationPolicy — SLA breach callback", () => {
  let store: InMemoryApprovalStateStore;

  afterEach(() => {
    store?.clear();
  });

  it("fires onSlaBreach when the SLA timer elapses", async () => {
    store = new InMemoryApprovalStateStore();
    const breachCb = vi.fn();
    const { policy } = makePolicy({
      slaMs: 40,
      onSlaBreach: breachCb,
      levelOverrides: [
        { timeoutMs: 5_000 },
        { timeoutMs: 5_000 },
        { timeoutMs: 5_000 },
      ],
    });
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap1", null);
    await new Promise<void>((res) => setTimeout(res, 80));
    expect(breachCb).toHaveBeenCalledWith("r1", "ap1");
    await store.grant("r1", "ap1"); // resolve so test doesn't hang
    await runPromise;
  });

  it("isSlaBreach() returns true after breach callback fires", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy } = makePolicy({
      slaMs: 30,
      levelOverrides: [
        { timeoutMs: 5_000 },
        { timeoutMs: 5_000 },
        { timeoutMs: 5_000 },
      ],
    });
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap1", null);
    await new Promise<void>((res) => setTimeout(res, 60));
    expect(engine.isSlaBreach()).toBe(true);
    await store.grant("r1", "ap1");
    await runPromise;
  });

  it("isSlaBreach() stays false when resolved within SLA", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy } = makePolicy({
      slaMs: 500,
      levelOverrides: [{ timeoutMs: 5_000 }],
    });
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap1", null);
    await Promise.resolve();
    await store.grant("r1", "ap1");
    await runPromise;
    expect(engine.isSlaBreach()).toBe(false);
  });

  it("onSlaBreach is called with the correct runId and approvalId", async () => {
    store = new InMemoryApprovalStateStore();
    const breachCb = vi.fn();
    const { policy } = makePolicy({
      slaMs: 30,
      onSlaBreach: breachCb,
      levelOverrides: [
        { timeoutMs: 5_000 },
        { timeoutMs: 5_000 },
        { timeoutMs: 5_000 },
      ],
    });
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap-sla-test", null);
    await new Promise<void>((res) => setTimeout(res, 60));
    expect(breachCb).toHaveBeenCalledWith("r1", "ap-sla-test");
    await store.grant("r1", "ap-sla-test");
    await runPromise;
  });

  it("all levels exhausted sets isSlaBreach=true even without onSlaBreach callback", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy } = makePolicy({ slaMs: 500 }); // all levels timeoutMs=50
    const engine = new EscalationEngine(store, policy);
    await expect(engine.run("r1", "ap1", null)).rejects.toBeInstanceOf(
      ApprovalTimeoutError
    );
    expect(engine.isSlaBreach()).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("EscalationPolicy — notification routing", () => {
  let store: InMemoryApprovalStateStore;

  afterEach(() => {
    store?.clear();
  });

  it("level 1 notifier is called exactly once on first escalation", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy, notifiers } = makePolicy({
      levelOverrides: [{ timeoutMs: 5_000 }],
    });
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap1", null);
    await Promise.resolve();
    await store.grant("r1", "ap1");
    await runPromise;
    expect(notifiers[0].calls).toHaveLength(1);
    expect(notifiers[1].calls).toHaveLength(0);
    expect(notifiers[2].calls).toHaveLength(0);
  });

  it("email notifier is distinct from Slack notifier (different objects)", () => {
    store = new InMemoryApprovalStateStore();
    const emailNotifier = makeNotifier();
    const slackNotifier = makeNotifier();
    const { policy } = makePolicy();
    const mixedPolicy: EscalationPolicy = {
      ...policy,
      levels: [
        { ...policy.levels[0], notifier: emailNotifier },
        { ...policy.levels[1], notifier: slackNotifier },
        { ...policy.levels[2], notifier: emailNotifier },
      ],
    };
    const engine = new EscalationEngine(store, mixedPolicy);
    // Validate the engine accepts the mixed policy
    expect(engine).toBeTruthy();
    expect(emailNotifier).not.toBe(slackNotifier);
  });

  it("notifier receives approvers list matching the policy level", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy, notifiers } = makePolicy({
      levelOverrides: [{ approvers: ["alice", "bob"], timeoutMs: 5_000 }],
    });
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap1", null);
    await Promise.resolve();
    await store.grant("r1", "ap1");
    await runPromise;
    expect(notifiers[0].calls[0].approvers).toEqual(["alice", "bob"]);
  });

  it("notifier at level 2 receives 'Level 1 timed out' as reason", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy, notifiers } = makePolicy();
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap1", null);
    await new Promise<void>((res) => setTimeout(res, 80));
    await store.grant("r1", "ap1::lvl2");
    await runPromise;
    expect(notifiers[1].calls[0].reason).toMatch(/Level 1/);
  });

  it("multiple notifiers can be the same object (fan-out pattern)", async () => {
    store = new InMemoryApprovalStateStore();
    const shared = makeNotifier();
    const { policy } = makePolicy();
    const sharedPolicy: EscalationPolicy = {
      ...policy,
      levels: policy.levels.map((lvl) => ({ ...lvl, notifier: shared })),
    };
    const engine = new EscalationEngine(store, sharedPolicy);
    await expect(engine.run("r1", "ap1", null)).rejects.toBeInstanceOf(
      ApprovalTimeoutError
    );
    // All three levels used the same notifier
    expect(shared.calls).toHaveLength(3);
  });

  it("notifier is called before poll() begins", async () => {
    store = new InMemoryApprovalStateStore();
    const order: string[] = [];
    const trackingNotifier: EscalationNotifier = {
      async notify() {
        order.push("notify");
      },
    };
    const { policy } = makePolicy();
    const trackedPolicy: EscalationPolicy = {
      ...policy,
      levels: [
        { ...policy.levels[0], notifier: trackingNotifier, timeoutMs: 5_000 },
        ...policy.levels.slice(1),
      ],
    };
    const engine = new EscalationEngine(store, trackedPolicy);
    const runPromise = engine.run("r1", "ap1", null);
    await Promise.resolve();
    order.push("after-first-tick");
    await store.grant("r1", "ap1");
    await runPromise;
    // notify was called before or at the first tick
    expect(order[0]).toBe("notify");
  });
});

// ---------------------------------------------------------------------------

describe("EscalationPolicy — policy configuration", () => {
  let store: InMemoryApprovalStateStore;

  afterEach(() => {
    store?.clear();
  });

  it("single-level policy works without escalation", async () => {
    store = new InMemoryApprovalStateStore();
    const n = makeNotifier();
    const policy: EscalationPolicy = {
      levels: [
        { name: "admin", approvers: ["root"], timeoutMs: 5_000, notifier: n },
      ],
      slaMs: 10_000,
    };
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap1", null);
    await Promise.resolve();
    await store.grant("r1", "ap1");
    const outcome = await runPromise;
    expect(outcome.decision).toBe("granted");
  });

  it("per-level timeoutMs controls how long each level waits", async () => {
    store = new InMemoryApprovalStateStore();
    const n1 = makeNotifier();
    const n2 = makeNotifier();
    const policy: EscalationPolicy = {
      levels: [
        { name: "lvl-A", approvers: ["a"], timeoutMs: 30, notifier: n1 },
        { name: "lvl-B", approvers: ["b"], timeoutMs: 5_000, notifier: n2 },
      ],
      slaMs: 10_000,
    };
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap1", null);
    // Level A times out in ~30ms; level B should now be active
    await new Promise<void>((res) => setTimeout(res, 60));
    await store.grant("r1", "ap1::lvl2");
    const outcome = await runPromise;
    expect(outcome.decision).toBe("granted");
    expect(n1.calls).toHaveLength(1);
    expect(n2.calls).toHaveLength(1);
  });

  it("maxLevels is effectively the length of the levels array", async () => {
    store = new InMemoryApprovalStateStore();
    const n = makeNotifier();
    const policy: EscalationPolicy = {
      levels: [
        { name: "L1", approvers: ["a"], timeoutMs: 20, notifier: n },
        { name: "L2", approvers: ["b"], timeoutMs: 20, notifier: n },
      ],
      slaMs: 1_000,
    };
    const engine = new EscalationEngine(store, policy);
    await expect(engine.run("r1", "ap1", null)).rejects.toBeInstanceOf(
      ApprovalTimeoutError
    );
    expect(n.calls).toHaveLength(2); // exactly 2 levels attempted
  });

  it("policy with five levels attempts all five before throwing", async () => {
    store = new InMemoryApprovalStateStore();
    const n = makeNotifier();
    const levels: EscalationLevel[] = Array.from({ length: 5 }, (_, i) => ({
      name: `L${i + 1}`,
      approvers: [`user${i}`],
      timeoutMs: 15,
      notifier: n,
    }));
    const engine = new EscalationEngine(store, {
      levels,
      slaMs: 5_000,
    });
    await expect(engine.run("r1", "ap1", null)).rejects.toBeInstanceOf(
      ApprovalTimeoutError
    );
    expect(n.calls).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------

describe("EscalationPolicy — cooldown between escalation steps", () => {
  let store: InMemoryApprovalStateStore;

  afterEach(() => {
    store?.clear();
  });

  it("cooldown delays the activation of level 2", async () => {
    store = new InMemoryApprovalStateStore();
    const n1 = makeNotifier();
    const n2 = makeNotifier();
    const policy: EscalationPolicy = {
      levels: [
        { name: "L1", approvers: ["a"], timeoutMs: 20, notifier: n1 },
        {
          name: "L2",
          approvers: ["b"],
          timeoutMs: 5_000,
          notifier: n2,
          cooldownMs: 50, // 50ms cooldown before L2 activates
        },
      ],
      slaMs: 5_000,
    };
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap1", null);

    // After L1 times out (~20ms) + before cooldown ends (~70ms): L2 not yet active
    await new Promise<void>((res) => setTimeout(res, 30));
    expect(n2.calls).toHaveLength(0);

    // After cooldown completes
    await new Promise<void>((res) => setTimeout(res, 60));
    expect(n2.calls).toHaveLength(1);

    await store.grant("r1", "ap1::lvl2");
    await runPromise;
  });

  it("zero cooldown allows immediate activation of next level", async () => {
    store = new InMemoryApprovalStateStore();
    const n1 = makeNotifier();
    const n2 = makeNotifier();
    const policy: EscalationPolicy = {
      levels: [
        { name: "L1", approvers: ["a"], timeoutMs: 20, notifier: n1 },
        {
          name: "L2",
          approvers: ["b"],
          timeoutMs: 5_000,
          notifier: n2,
          cooldownMs: 0,
        },
      ],
      slaMs: 5_000,
    };
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap1", null);
    await new Promise<void>((res) => setTimeout(res, 80));
    expect(n2.calls).toHaveLength(1);
    await store.grant("r1", "ap1::lvl2");
    await runPromise;
  });

  it("cooldown is enforced per level (only the configured level waits)", async () => {
    store = new InMemoryApprovalStateStore();
    const n = makeNotifier();
    const policy: EscalationPolicy = {
      levels: [
        { name: "L1", approvers: ["a"], timeoutMs: 20, notifier: n }, // no cooldown
        {
          name: "L2",
          approvers: ["b"],
          timeoutMs: 20,
          notifier: n,
          cooldownMs: 30,
        },
        {
          name: "L3",
          approvers: ["c"],
          timeoutMs: 5_000,
          notifier: n,
        }, // no cooldown
      ],
      slaMs: 5_000,
    };
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap1", null);
    await new Promise<void>((res) => setTimeout(res, 200));
    // L1 (20ms) → L2 cooldown (30ms) → L2 poll (20ms) → L3 (no cooldown)
    expect(n.calls).toHaveLength(3);
    await store.grant("r1", "ap1::lvl3");
    await runPromise;
  });
});

// ---------------------------------------------------------------------------

describe("EscalationPolicy — escalation metadata", () => {
  let store: InMemoryApprovalStateStore;

  afterEach(() => {
    store?.clear();
  });

  it("each escalation log entry has a notifiedAt timestamp", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy } = makePolicy();
    const engine = new EscalationEngine(store, policy);
    await expect(engine.run("r1", "ap1", null)).rejects.toBeInstanceOf(
      ApprovalTimeoutError
    );
    for (const entry of engine.getEscalationLog()) {
      expect(entry.notifiedAt).toBeInstanceOf(Date);
    }
  });

  it("escalation log entries reference the correct runId and approvalId", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy } = makePolicy();
    const engine = new EscalationEngine(store, policy);
    await expect(
      engine.run("run-meta", "ap-meta", null)
    ).rejects.toBeInstanceOf(ApprovalTimeoutError);
    const log = engine.getEscalationLog();
    expect(log[0].runId).toBe("run-meta");
    // First entry uses the original approvalId
    expect(log[0].approvalId).toBe("ap-meta");
  });

  it("each log entry lists the approvers for that level", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy, notifiers } = makePolicy({
      levelOverrides: [
        { approvers: ["alice"] },
        { approvers: ["bob", "carol"] },
        { approvers: ["dan"] },
      ],
    });
    const engine = new EscalationEngine(store, policy);
    await expect(engine.run("r1", "ap1", null)).rejects.toBeInstanceOf(
      ApprovalTimeoutError
    );
    const log = engine.getEscalationLog();
    expect(log[0].approvers).toEqual(["alice"]);
    expect(log[1].approvers).toEqual(["bob", "carol"]);
    expect(log[2].approvers).toEqual(["dan"]);
  });

  it("timestamps in escalation log are in non-decreasing order", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy } = makePolicy();
    const engine = new EscalationEngine(store, policy);
    await expect(engine.run("r1", "ap1", null)).rejects.toBeInstanceOf(
      ApprovalTimeoutError
    );
    const log = engine.getEscalationLog();
    for (let i = 1; i < log.length; i++) {
      expect(log[i].notifiedAt.getTime()).toBeGreaterThanOrEqual(
        log[i - 1].notifiedAt.getTime()
      );
    }
  });

  it("resolution log entry records the rejection reason", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy } = makePolicy({
      levelOverrides: [{ timeoutMs: 5_000 }],
    });
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap1", null);
    await Promise.resolve();
    await store.reject("r1", "ap1", "compliance block");
    await runPromise;
    expect(engine.getResolutionLog()[0].reason).toBe("compliance block");
  });

  it("resolution log has resolvedAt timestamp after run completes", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy } = makePolicy({
      levelOverrides: [{ timeoutMs: 5_000 }],
    });
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap1", null);
    await Promise.resolve();
    await store.grant("r1", "ap1");
    await runPromise;
    expect(engine.getResolutionLog()[0].resolvedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------

describe("EscalationPolicy — concurrent escalations", () => {
  let store: InMemoryApprovalStateStore;

  afterEach(() => {
    store?.clear();
  });

  it("two independent requests escalate in parallel without interference", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy, notifiers } = makePolicy({
      levelOverrides: [{ timeoutMs: 5_000 }, { timeoutMs: 5_000 }],
    });
    const engine1 = new EscalationEngine(store, policy);
    const engine2 = new EscalationEngine(store, policy);

    const run1 = engine1.run("r1", "ap1", { source: "request-A" });
    const run2 = engine2.run("r2", "ap2", { source: "request-B" });

    await Promise.resolve();
    await Promise.resolve();

    await store.grant("r1", "ap1", { by: "alice" });
    await store.grant("r2", "ap2", { by: "bob" });

    const [o1, o2] = await Promise.all([run1, run2]);
    expect(o1.decision).toBe("granted");
    expect(o2.decision).toBe("granted");
  });

  it("rejection of one request does not affect the other", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy } = makePolicy({
      levelOverrides: [{ timeoutMs: 5_000 }],
    });
    const engine1 = new EscalationEngine(store, policy);
    const engine2 = new EscalationEngine(store, policy);

    const run1 = engine1.run("r1", "ap1", null);
    const run2 = engine2.run("r2", "ap2", null);

    await Promise.resolve();
    await Promise.resolve();

    await store.reject("r1", "ap1", "denied");
    await store.grant("r2", "ap2");

    const [o1, o2] = await Promise.all([run1, run2]);
    expect(o1.decision).toBe("rejected");
    expect(o2.decision).toBe("granted");
  });

  it("concurrent runs use independent escalation logs", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy } = makePolicy({
      levelOverrides: [{ timeoutMs: 5_000 }],
    });
    const engine1 = new EscalationEngine(store, policy);
    const engine2 = new EscalationEngine(store, policy);

    const run1 = engine1.run("r1", "ap1", null);
    const run2 = engine2.run("r2", "ap2", null);
    await Promise.resolve();
    await Promise.resolve();

    await store.grant("r1", "ap1");
    await store.grant("r2", "ap2");
    await Promise.all([run1, run2]);

    expect(engine1.getEscalationLog()[0].runId).toBe("r1");
    expect(engine2.getEscalationLog()[0].runId).toBe("r2");
  });

  it("two escalations can reach different levels independently", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy } = makePolicy(); // timeoutMs=50 per level
    const engine1 = new EscalationEngine(store, policy);
    const engine2 = new EscalationEngine(store, policy);

    // engine1 will escalate to level 2; engine2 resolves at level 1
    const run1 = engine1.run("r1", "ap1", null);
    const run2 = engine2.run("r2", "ap2", null);
    await Promise.resolve();
    await Promise.resolve();

    // Immediately grant r2 (stays at level 1)
    await store.grant("r2", "ap2");
    // r1 times out level 1 then gets granted at level 2
    await new Promise<void>((res) => setTimeout(res, 80));
    await store.grant("r1", "ap1::lvl2");

    await Promise.all([run1, run2]);
    expect(engine1.getResolutionLog()[0].resolvedAtLevel).toBe(2);
    expect(engine2.getResolutionLog()[0].resolvedAtLevel).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("EscalationPolicy — request-level policy override", () => {
  let store: InMemoryApprovalStateStore;

  afterEach(() => {
    store?.clear();
  });

  it("override can shorten the SLA deadline", async () => {
    store = new InMemoryApprovalStateStore();
    const breachCb = vi.fn();
    const { policy } = makePolicy({
      slaMs: 10_000, // global SLA: 10 seconds
      levelOverrides: [
        { timeoutMs: 5_000 },
        { timeoutMs: 5_000 },
        { timeoutMs: 5_000 },
      ],
    });
    const engine = new EscalationEngine(store, policy);
    // Override SLA to 40ms for this specific request
    const runPromise = engine.run("r1", "ap1", null, {
      slaMs: 40,
      onSlaBreach: breachCb,
    });
    await new Promise<void>((res) => setTimeout(res, 80));
    expect(breachCb).toHaveBeenCalled();
    await store.grant("r1", "ap1");
    await runPromise;
  });

  it("override can replace the onSlaBreach callback", async () => {
    store = new InMemoryApprovalStateStore();
    const globalCb = vi.fn();
    const localCb = vi.fn();
    const { policy } = makePolicy({
      slaMs: 30,
      onSlaBreach: globalCb,
      levelOverrides: [
        { timeoutMs: 5_000 },
        { timeoutMs: 5_000 },
        { timeoutMs: 5_000 },
      ],
    });
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap1", null, {
      onSlaBreach: localCb,
    });
    await new Promise<void>((res) => setTimeout(res, 80));
    expect(localCb).toHaveBeenCalled();
    expect(globalCb).not.toHaveBeenCalled();
    await store.grant("r1", "ap1");
    await runPromise;
  });

  it("override with extended SLA does not fire breach during short run", async () => {
    store = new InMemoryApprovalStateStore();
    const breachCb = vi.fn();
    const { policy } = makePolicy({
      slaMs: 30, // global would breach fast
      levelOverrides: [{ timeoutMs: 5_000 }],
    });
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap1", null, {
      slaMs: 10_000, // per-request: 10 seconds
      onSlaBreach: breachCb,
    });
    await Promise.resolve();
    await store.grant("r1", "ap1");
    await runPromise;
    expect(breachCb).not.toHaveBeenCalled();
  });

  it("override does not mutate the original policy object", async () => {
    store = new InMemoryApprovalStateStore();
    const { policy } = makePolicy({
      slaMs: 5_000,
      levelOverrides: [{ timeoutMs: 5_000 }],
    });
    const originalSlaMs = policy.slaMs;
    const engine = new EscalationEngine(store, policy);
    const runPromise = engine.run("r1", "ap1", null, { slaMs: 30 });
    await new Promise<void>((res) => setTimeout(res, 60));
    // Original policy slaMs must be unchanged
    expect(policy.slaMs).toBe(originalSlaMs);
    await store.grant("r1", "ap1");
    await runPromise;
  });
});
