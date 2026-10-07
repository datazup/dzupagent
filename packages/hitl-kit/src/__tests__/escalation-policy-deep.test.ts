/**
 * EscalationEngine — ordered approver chain with per-level timeouts.
 *
 * Contract: DZA-HITL-escalation-20261007-R1 (workspace-docs
 * repos/dzupagent/docs/planning/dza-hitl-escalation-20261007-r1/ADMISSION.md).
 * Tests run against the exported symbols only; the clock is injected.
 */
import { describe, it, expect } from "vitest";
import {
  ApproverNotActiveError,
  EscalationEngine,
  InvalidEscalationPolicyError,
  validateEscalationPolicy,
  type EscalationEvent,
  type EscalationPolicy,
} from "../index.js";

const CHAIN: EscalationPolicy = {
  levels: [
    { approvers: ["lead"], timeoutMs: 1_000 },
    { approvers: ["manager", "deputy"], timeoutMs: 2_000 },
    { approvers: ["director"], timeoutMs: 4_000 },
  ],
};

function harness(policy: EscalationPolicy = CHAIN, start = 10_000) {
  let clock = start;
  const events: EscalationEvent[] = [];
  const engine = new EscalationEngine(policy, {
    now: () => clock,
    onEvent: (e) => events.push(e),
  });
  return {
    engine,
    events,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe("EscalationEngine — start", () => {
  it("starts level 0 at construction and emits level_started", () => {
    const { engine, events } = harness();
    expect(engine.state).toEqual({ status: "pending", level: 0, deadline: 11_000 });
    expect(events).toEqual([
      { type: "level_started", level: 0, approvers: ["lead"], at: 10_000, deadline: 11_000 },
    ]);
  });

  it("defaults the clock to Date.now", () => {
    const before = Date.now();
    const engine = new EscalationEngine(CHAIN);
    const after = Date.now();
    expect(engine.state.deadline).toBeGreaterThanOrEqual(before + 1_000);
    expect(engine.state.deadline).toBeLessThanOrEqual(after + 1_000);
  });
});

describe("EscalationEngine — timeouts and escalation", () => {
  it("stays on the level before its deadline", () => {
    const { engine, events, advance } = harness();
    advance(999);
    expect(engine.tick()).toEqual({ status: "pending", level: 0, deadline: 11_000 });
    expect(events).toHaveLength(1);
  });

  it("escalates to the next level exactly at the deadline", () => {
    const { engine, events, advance } = harness();
    advance(1_000);
    expect(engine.tick()).toEqual({ status: "pending", level: 1, deadline: 13_000 });
    expect(events.slice(1)).toEqual([
      { type: "level_timed_out", level: 0, at: 11_000 },
      {
        type: "level_started",
        level: 1,
        approvers: ["manager", "deputy"],
        at: 11_000,
        deadline: 13_000,
      },
    ]);
  });

  it("starts each escalated level at the previous deadline, catching up on a late tick", () => {
    const { engine, events, advance } = harness();
    advance(3_500); // past level 0 (11_000) and level 1 (13_000)
    expect(engine.tick()).toEqual({ status: "pending", level: 2, deadline: 17_000 });
    expect(events.map((e) => e.type)).toEqual([
      "level_started",
      "level_timed_out",
      "level_started",
      "level_timed_out",
      "level_started",
    ]);
  });

  it("rejects by default when the chain is exhausted", () => {
    const { engine, events, advance } = harness();
    advance(7_000);
    expect(engine.tick()).toEqual({
      status: "rejected",
      level: 2,
      deadline: 17_000,
      resolvedBy: { kind: "exhausted" },
    });
    expect(events.slice(-2)).toEqual([
      { type: "level_timed_out", level: 2, at: 17_000 },
      { type: "exhausted", action: "reject", decision: "rejected", at: 17_000 },
    ]);
  });

  it("grants on exhaustion only when onExhausted is 'approve'", () => {
    const { engine, events, advance } = harness({
      levels: [{ approvers: ["lead"], timeoutMs: 1_000 }],
      onExhausted: "approve",
    });
    advance(1_000);
    expect(engine.tick()).toMatchObject({ status: "granted", resolvedBy: { kind: "exhausted" } });
    expect(events.at(-1)).toEqual({
      type: "exhausted",
      action: "approve",
      decision: "granted",
      at: 11_000,
    });
  });

  it("emits nothing on ticks after resolution", () => {
    const { engine, events, advance } = harness();
    advance(7_000);
    engine.tick();
    const count = events.length;
    advance(60_000);
    expect(engine.tick().status).toBe("rejected");
    expect(events).toHaveLength(count);
  });
});

describe("EscalationEngine — decisions", () => {
  it("resolves when an active-level approver grants", () => {
    const { engine, events, advance } = harness();
    advance(500);
    expect(engine.decide("lead", "granted", "looks fine")).toEqual({
      status: "granted",
      level: 0,
      deadline: 11_000,
      resolvedBy: { kind: "approver", approverId: "lead" },
    });
    expect(events.at(-1)).toEqual({
      type: "decided",
      level: 0,
      approverId: "lead",
      decision: "granted",
      reason: "looks fine",
      at: 10_500,
    });
  });

  it("resolves when an active-level approver rejects", () => {
    const { engine, advance } = harness();
    advance(1_000);
    expect(engine.decide("deputy", "rejected")).toMatchObject({
      status: "rejected",
      level: 1,
      resolvedBy: { kind: "approver", approverId: "deputy" },
    });
  });

  it("omits reason from the event when none is given", () => {
    const { engine, events } = harness();
    engine.decide("lead", "granted");
    expect(events.at(-1)).not.toHaveProperty("reason");
  });

  it("first decision wins; later decisions are ignored without events", () => {
    const { engine, events } = harness({
      levels: [{ approvers: ["a", "b"], timeoutMs: 1_000 }],
    });
    engine.decide("a", "rejected");
    const count = events.length;
    expect(engine.decide("b", "granted")).toMatchObject({
      status: "rejected",
      resolvedBy: { kind: "approver", approverId: "a" },
    });
    expect(events).toHaveLength(count);
  });

  it("rejects a decision from an approver not on the active level", () => {
    const { engine } = harness();
    expect(() => engine.decide("manager", "granted")).toThrow(ApproverNotActiveError);
    expect(() => engine.decide("stranger", "granted")).toThrow(ApproverNotActiveError);
    expect(engine.state.status).toBe("pending");
  });

  it("an earlier level loses authority once escalated", () => {
    const { engine, advance } = harness();
    advance(1_000);
    expect(() => engine.decide("lead", "granted")).toThrow(ApproverNotActiveError);
    expect(engine.state).toMatchObject({ status: "pending", level: 1 });
  });

  it("applies elapsed deadlines before accepting a late decision", () => {
    const { engine, events, advance } = harness();
    advance(1_200); // lead's deadline passed, no tick yet
    expect(() => engine.decide("lead", "granted")).toThrow(ApproverNotActiveError);
    expect(events.map((e) => e.type)).toContain("level_timed_out");
  });

  it("a decision after exhaustion is a no-op", () => {
    const { engine, advance } = harness();
    advance(7_000);
    expect(engine.decide("director", "granted")).toMatchObject({
      status: "rejected",
      resolvedBy: { kind: "exhausted" },
    });
  });

  it("returns state snapshots that callers cannot mutate", () => {
    const { engine } = harness();
    const snapshot = engine.state;
    snapshot.status = "granted";
    expect(engine.state.status).toBe("pending");
  });
});

describe("EscalationEngine — policy validation", () => {
  const bad: Array<[string, unknown]> = [
    ["empty levels", { levels: [] }],
    ["empty approvers", { levels: [{ approvers: [], timeoutMs: 1 }] }],
    ["blank approver", { levels: [{ approvers: [" "], timeoutMs: 1 }] }],
    ["duplicate approver in a level", { levels: [{ approvers: ["a", "a"], timeoutMs: 1 }] }],
    ["zero timeout", { levels: [{ approvers: ["a"], timeoutMs: 0 }] }],
    ["negative timeout", { levels: [{ approvers: ["a"], timeoutMs: -5 }] }],
    ["fractional timeout", { levels: [{ approvers: ["a"], timeoutMs: 1.5 }] }],
    ["non-finite timeout", { levels: [{ approvers: ["a"], timeoutMs: Infinity }] }],
    [
      "unknown onExhausted",
      { levels: [{ approvers: ["a"], timeoutMs: 1 }], onExhausted: "escalate" },
    ],
  ];

  it.each(bad)("rejects %s", (_label, policy) => {
    expect(() => validateEscalationPolicy(policy as EscalationPolicy)).toThrow(
      InvalidEscalationPolicyError
    );
    expect(() => new EscalationEngine(policy as EscalationPolicy)).toThrow(
      /^Invalid escalation policy: /
    );
  });

  it("allows the same approver on different levels", () => {
    expect(() =>
      validateEscalationPolicy({
        levels: [
          { approvers: ["a"], timeoutMs: 1 },
          { approvers: ["a", "b"], timeoutMs: 1 },
        ],
      })
    ).not.toThrow();
  });
});
