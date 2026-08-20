import { describe, expect, it, vi } from "vitest";
import type {
  ExecutionRouteCandidate,
  ExecutionRoutePolicy,
} from "@dzupagent/runtime-contracts";

import {
  replayRouteSelectionReceipt,
  selectExecutionRoute,
  selectExecutionRouteWithReceipt,
  type DeterministicRouteSelectionOptions,
} from "../registry/deterministic-candidate-selector.js";
import { ROUTE_DEADLINE_FAILURE_CODES } from "../registry/route-deadline-strategy.js";

/**
 * Explicit strategy deadline and deterministic deadline fallback.
 *
 * The fixture below is built so that three candidate orderings DISAGREE:
 *
 *   input order      charlie, alpha, bravo   (declaration order)
 *   canonical id     alpha,   bravo, charlie
 *   preference order bravo,   charlie, alpha (the policy's declared chain)
 *
 * The ordered-compatible fallback head is therefore `bravo:sdk` and nothing
 * else. A fallback that read the input array would pick `charlie:sdk`; one that
 * read canonical id order would pick `alpha:sdk`. Both are distinguishable from
 * the correct answer, which is what makes these specs able to fail.
 *
 * The strategy is `round-robin` with a cursor of `bravo:sdk`, whose successor
 * in canonical id order is `charlie:sdk` — deliberately NOT the fallback head —
 * so a deadline breach visibly diverts the pick instead of coincidentally
 * agreeing with it.
 */

const DECIDED_AT = "2026-07-12T12:00:00.000Z";
const BUDGET_MS = 25;
const CURSOR = "bravo:sdk";

/** Fully accepting candidate: only the deadline dimension may decide. */
function candidate(
  id: string,
  overrides: Partial<ExecutionRouteCandidate> = {},
): ExecutionRouteCandidate {
  return {
    id,
    provider: "codex",
    backend: "sdk",
    model: "codex-1",
    profileRef: "work",
    authSourceRef: "codex-subscription",
    authAvailable: true,
    backendAvailable: true,
    modelAvailable: true,
    health: { status: "healthy" },
    capabilities: ["tools", "reasoning"],
    costClass: "low",
    privacyClass: "provider",
    locality: "remote",
    accessClass: "subscription",
    policyCompatible: true,
    ...overrides,
  };
}

/** Declared out of canonical order so no ordering can be read off the input. */
const DEADLINE_CANDIDATES = [
  candidate("charlie:sdk"),
  candidate("alpha:sdk"),
  candidate("bravo:sdk"),
];

/** Disagrees with both input order and canonical id order, by construction. */
const PREFERENCE_ORDER = ["bravo:sdk", "charlie:sdk", "alpha:sdk"];

const INPUT_ORDER_HEAD = "charlie:sdk";
const CANONICAL_ID_HEAD = "alpha:sdk";
const PREFERENCE_HEAD = "bravo:sdk";

/** The pick the round-robin strategy makes when the deadline is met. */
const STRATEGY_PICK = "charlie:sdk";

function policy(
  overrides: Partial<ExecutionRoutePolicy> = {},
): ExecutionRoutePolicy {
  return {
    id: "route-policy",
    requestId: "request-1",
    strategy: "round-robin",
    candidates: DEADLINE_CANDIDATES,
    hardConstraints: [],
    preferenceOrder: PREFERENCE_ORDER,
    fallback: "ordered-compatible",
    maxSelectionLatencyMs: BUDGET_MS,
    ...overrides,
  };
}

function options(
  overrides: Partial<DeterministicRouteSelectionOptions> = {},
): DeterministicRouteSelectionOptions {
  return { decidedAt: DECIDED_AT, roundRobinCursor: CURSOR, ...overrides };
}

describe("route selection deadline fixture", () => {
  it("keeps input order, canonical id order and preference order distinct", () => {
    // If this ever agrees, every fallback-ordering spec below silently stops
    // being able to tell the three rules apart.
    expect(DEADLINE_CANDIDATES[0]?.id).toBe(INPUT_ORDER_HEAD);
    expect([...DEADLINE_CANDIDATES].map((item) => item.id).sort()[0]).toBe(
      CANONICAL_ID_HEAD,
    );
    expect(PREFERENCE_ORDER[0]).toBe(PREFERENCE_HEAD);
    expect(
      new Set([INPUT_ORDER_HEAD, CANONICAL_ID_HEAD, PREFERENCE_HEAD]).size,
    ).toBe(3);
  });

  it("makes the strategy pick differ from the fallback head", () => {
    // Without this the "breach diverts the pick" specs would pass even if the
    // deadline did nothing at all.
    expect(STRATEGY_PICK).not.toBe(PREFERENCE_HEAD);
  });
});

describe("explicit strategy deadline", () => {
  it("records not-evaluated and honours the strategy pick when no elapsed time is declared", () => {
    const receipt = selectExecutionRouteWithReceipt(
      policy(),
      options({ strategyElapsedMs: undefined }),
    );

    expect(receipt.deadlineOutcome).toBe("not-evaluated");
    expect(receipt.strategyElapsedMs).toBeNull();
    expect(receipt.selectionDeadlineMs).toBeNull();
    expect(receipt.decision.selectedCandidateId).toBe(STRATEGY_PICK);
  });

  it("treats an elapsed time exactly at the declared budget as within it", () => {
    const receipt = selectExecutionRouteWithReceipt(
      policy(),
      options({ strategyElapsedMs: BUDGET_MS }),
    );

    // The budget is a MAXIMUM latency: spending exactly it is compliant.
    expect(receipt.deadlineOutcome).toBe("within");
    expect(receipt.decision.selectedCandidateId).toBe(STRATEGY_PICK);
  });

  it("breaches the deadline one millisecond past the declared budget", () => {
    const receipt = selectExecutionRouteWithReceipt(
      policy(),
      options({ strategyElapsedMs: BUDGET_MS + 1 }),
    );

    expect(receipt.deadlineOutcome).toBe("exceeded");
    expect(receipt.decision.selectedCandidateId).toBe(PREFERENCE_HEAD);
  });

  it("records the measured elapsed time and the declared budget it was compared against", () => {
    const receipt = selectExecutionRouteWithReceipt(
      policy(),
      options({ strategyElapsedMs: 40 }),
    );

    expect(receipt.strategyElapsedMs).toBe(40);
    expect(receipt.selectionDeadlineMs).toBe(BUDGET_MS);
  });

  it("keeps the measured elapsed time load-bearing across the boundary", () => {
    const met = selectExecutionRoute(
      policy(),
      options({ strategyElapsedMs: BUDGET_MS }),
    );
    const breached = selectExecutionRoute(
      policy(),
      options({ strategyElapsedMs: BUDGET_MS + 1 }),
    );

    // One millisecond of measured latency, and nothing else, changes the pick.
    expect(met.selectedCandidateId).not.toBe(breached.selectedCandidateId);
  });

  it("names the breach and the fallback in the reasoning summary", () => {
    const decision = selectExecutionRoute(
      policy(),
      options({ strategyElapsedMs: 40 }),
    );

    expect(decision.reasoningSummary).toBe(
      "Round robin exceeded its 25ms selection deadline at 40ms; ordered-compatible fallback selected bravo:sdk; 0 candidate(s) rejected",
    );
  });

  it("keeps the declared strategy on the decision after a breach", () => {
    const decision = selectExecutionRoute(
      policy(),
      options({ strategyElapsedMs: 40 }),
    );

    // The receipt's deadlineOutcome, not a rewritten strategy, records that the
    // pick came from the fallback.
    expect(decision.strategy).toBe("round-robin");
  });
});

describe("deterministic deadline fallback", () => {
  it("selects the preference-order head, not the input-order head", () => {
    const decision = selectExecutionRoute(
      policy(),
      options({ strategyElapsedMs: 40 }),
    );

    expect(decision.selectedCandidateId).toBe(PREFERENCE_HEAD);
    expect(decision.selectedCandidateId).not.toBe(INPUT_ORDER_HEAD);
    expect(decision.selectedCandidateId).not.toBe(CANONICAL_ID_HEAD);
  });

  it("is unmoved by re-declaring the candidates in a different order", () => {
    const reversed = selectExecutionRoute(
      policy({ candidates: [...DEADLINE_CANDIDATES].reverse() }),
      options({ strategyElapsedMs: 40 }),
    );

    expect(reversed.selectedCandidateId).toBe(PREFERENCE_HEAD);
  });

  it("diverts away from the strategy's own pick on a breach", () => {
    const met = selectExecutionRoute(
      policy(),
      options({ strategyElapsedMs: 10 }),
    );
    const breached = selectExecutionRoute(
      policy(),
      options({ strategyElapsedMs: 40 }),
    );

    expect(met.selectedCandidateId).toBe(STRATEGY_PICK);
    expect(breached.selectedCandidateId).toBe(PREFERENCE_HEAD);
  });

  it("ignores the round-robin cursor once the deadline is breached", () => {
    // Every cursor lands on the same fallback head: the late strategy is not
    // consulted at all, rather than being consulted with a different cursor.
    for (const cursor of ["alpha:sdk", "bravo:sdk", "charlie:sdk"]) {
      const decision = selectExecutionRoute(
        policy(),
        options({ roundRobinCursor: cursor, strategyElapsedMs: 40 }),
      );
      expect(decision.selectedCandidateId).toBe(PREFERENCE_HEAD);
    }
  });

  it("selects nothing when the policy declares no fallback", () => {
    const decision = selectExecutionRoute(
      policy({ fallback: "none" }),
      options({ strategyElapsedMs: 40 }),
    );

    // Fail closed: a breached deadline with no declared fallback dispatches
    // nothing, and the breach stays on the record instead of throwing.
    expect(decision.selectedCandidateId).toBeNull();
    expect(decision.fallbackCandidateIds).toEqual([]);
    expect(decision.reasoningSummary).toBe(
      "Round robin exceeded its 25ms selection deadline at 40ms; no fallback candidate was available, so nothing was selected; 0 candidate(s) rejected",
    );
  });

  it("still selects the strategy pick under a no-fallback policy that met its deadline", () => {
    const decision = selectExecutionRoute(
      policy({ fallback: "none" }),
      options({ strategyElapsedMs: 10 }),
    );

    // Holds the fallback dimension at "none" while varying only the deadline,
    // so the null above is caused by the breach and not by the fallback value.
    expect(decision.selectedCandidateId).toBe(STRATEGY_PICK);
  });

  it("selects nothing when a breach leaves no eligible candidate", () => {
    const decision = selectExecutionRoute(
      policy({
        candidates: DEADLINE_CANDIDATES.map((item) => ({
          ...item,
          authAvailable: false,
        })),
      }),
      options({ strategyElapsedMs: 40 }),
    );

    expect(decision.eligibleCandidateIds).toEqual([]);
    expect(decision.selectedCandidateId).toBeNull();
  });

  it("lists the remaining chain behind the fallback pick", () => {
    const decision = selectExecutionRoute(
      policy(),
      options({ strategyElapsedMs: 40 }),
    );

    expect(decision.fallbackCandidateIds).toEqual(["charlie:sdk", "alpha:sdk"]);
  });

  it("skips an ineligible preference head and takes the next eligible one", () => {
    const decision = selectExecutionRoute(
      policy({
        candidates: [
          candidate("charlie:sdk"),
          candidate("alpha:sdk"),
          candidate("bravo:sdk", { authAvailable: false }),
        ],
      }),
      options({ strategyElapsedMs: 40 }),
    );

    // bravo is the preference head but is not eligible, so the chain head is
    // the next preferred *eligible* candidate.
    expect(decision.selectedCandidateId).toBe("charlie:sdk");
  });
});

describe("deadline admission fails closed", () => {
  const REJECTIONS = [
    {
      name: "a fractional elapsed time",
      policy: policy(),
      options: options({ strategyElapsedMs: 25.5 }),
      code: "ROUTE_DEADLINE_INVALID_ELAPSED",
      path: "options.strategyElapsedMs",
    },
    {
      name: "NaN as an elapsed time",
      policy: policy(),
      options: options({ strategyElapsedMs: Number.NaN }),
      code: "ROUTE_DEADLINE_INVALID_ELAPSED",
      path: "options.strategyElapsedMs",
    },
    {
      name: "an infinite elapsed time",
      policy: policy(),
      options: options({ strategyElapsedMs: Number.POSITIVE_INFINITY }),
      code: "ROUTE_DEADLINE_INVALID_ELAPSED",
      path: "options.strategyElapsedMs",
    },
    {
      name: "a numeric string elapsed time, without coercing it",
      policy: policy(),
      options: options({
        strategyElapsedMs: "26" as unknown as number,
      }),
      code: "ROUTE_DEADLINE_INVALID_ELAPSED",
      path: "options.strategyElapsedMs",
    },
    {
      name: "a negative elapsed time",
      policy: policy(),
      options: options({ strategyElapsedMs: -1 }),
      code: "ROUTE_DEADLINE_NEGATIVE_ELAPSED",
      path: "options.strategyElapsedMs",
    },
    {
      name: "a zero budget",
      policy: policy({ maxSelectionLatencyMs: 0 }),
      options: options({ strategyElapsedMs: 10 }),
      code: "ROUTE_DEADLINE_INVALID_BUDGET",
      path: "policy.maxSelectionLatencyMs",
    },
    {
      name: "a fractional budget",
      policy: policy({ maxSelectionLatencyMs: 2.5 }),
      options: options({ strategyElapsedMs: 10 }),
      code: "ROUTE_DEADLINE_INVALID_BUDGET",
      path: "policy.maxSelectionLatencyMs",
    },
    {
      name: "an undeclared fallback on a breached deadline",
      policy: policy({
        fallback: "cheapest" as unknown as ExecutionRoutePolicy["fallback"],
      }),
      options: options({ strategyElapsedMs: 40 }),
      code: "ROUTE_DEADLINE_UNDECLARED_FALLBACK",
      path: "policy.fallback",
    },
  ] as const;

  it.each(REJECTIONS.map((entry) => [entry.name, entry] as const))(
    "rejects %s",
    (_name, entry) => {
      expect(() => selectExecutionRoute(entry.policy, entry.options)).toThrow(
        expect.objectContaining({
          name: "DeterministicRouteSelectionAdmissionError",
          code: entry.code,
          path: entry.path,
        }),
      );
    },
  );

  it("reaches every declared deadline rejection code", () => {
    // Literal list, pinned two-way against the exported set: deleting a guard
    // shrinks the exported set and reddens this, instead of quietly removing a
    // row from a table that derives its own cases.
    const expected = [
      "ROUTE_DEADLINE_INVALID_BUDGET",
      "ROUTE_DEADLINE_INVALID_ELAPSED",
      "ROUTE_DEADLINE_NEGATIVE_ELAPSED",
      "ROUTE_DEADLINE_UNDECLARED_FALLBACK",
    ];

    expect([...ROUTE_DEADLINE_FAILURE_CODES].sort()).toEqual(expected);
    expect([...new Set(REJECTIONS.map((entry) => entry.code))].sort()).toEqual(
      expected,
    );
  });

  it("does not evaluate the budget when no elapsed time is declared", () => {
    // Keeps the deadline strictly additive: a caller that predates it is
    // unaffected even by a budget that could never be met.
    const decision = selectExecutionRoute(
      policy({ maxSelectionLatencyMs: 0 }),
      options({ strategyElapsedMs: undefined }),
    );

    expect(decision.selectedCandidateId).toBe(STRATEGY_PICK);
  });

  it("tolerates an undeclared fallback while the deadline is met", () => {
    // Scoped exactly as documented: the fallback value is only authority once a
    // breach makes it decide something.
    const decision = selectExecutionRoute(
      policy({
        fallback: "cheapest" as unknown as ExecutionRoutePolicy["fallback"],
      }),
      options({ strategyElapsedMs: 10 }),
    );

    expect(decision.selectedCandidateId).toBe(STRATEGY_PICK);
  });
});

describe("deadline replay purity", () => {
  it("replays a breached decision from the receipt alone", () => {
    const recorded = selectExecutionRouteWithReceipt(
      policy(),
      options({ strategyElapsedMs: 40 }),
    );

    const replayed = replayRouteSelectionReceipt(policy(), recorded);

    expect(replayed).toEqual(recorded);
    expect(replayed.deadlineOutcome).toBe("exceeded");
    // A replay that failed to feed the recorded elapsed time back would fall to
    // "not-evaluated" and re-select the strategy pick.
    expect(replayed.decision.selectedCandidateId).toBe(PREFERENCE_HEAD);
  });

  it("replays a breached decision with no clock available", () => {
    const recorded = selectExecutionRouteWithReceipt(
      policy(),
      options({ strategyElapsedMs: 40 }),
    );

    const clockReads: string[] = [];
    const RealDate = globalThis.Date;
    const realPerformanceNow = globalThis.performance.now;

    function TrapDate(): never {
      clockReads.push("new Date");
      throw new Error("replay read a clock");
    }
    TrapDate.now = (): never => {
      clockReads.push("Date.now");
      throw new Error("replay read a clock");
    };

    vi.stubGlobal("Date", TrapDate);
    globalThis.performance.now = (): never => {
      clockReads.push("performance.now");
      throw new Error("replay read a clock");
    };

    let replayed;
    try {
      replayed = replayRouteSelectionReceipt(policy(), recorded);
    } finally {
      vi.unstubAllGlobals();
      globalThis.performance.now = realPerformanceNow;
      expect(globalThis.Date).toBe(RealDate);
    }

    expect(clockReads).toEqual([]);
    expect(replayed).toEqual(recorded);
  });

  it("records no deadline state for a decision that declared none", () => {
    const receipt = selectExecutionRouteWithReceipt(policy(), options());

    expect(receipt.strategyElapsedMs).toBeNull();
    expect(receipt.selectionDeadlineMs).toBeNull();
    expect(receipt.deadlineOutcome).toBe("not-evaluated");
  });

  it("carries exactly the declared receipt fields", () => {
    const receipt = selectExecutionRouteWithReceipt(
      policy(),
      options({ strategyElapsedMs: 40 }),
    );

    // Literal key list: dropping the deadline outcome (or any other recorded
    // input) from the receipt fails here rather than only where it is read.
    expect(Object.keys(receipt).sort()).toEqual([
      "candidateWeights",
      "deadlineOutcome",
      "decision",
      "roundRobinCursor",
      "routingKey",
      "schema",
      "seed",
      "selectionDeadlineMs",
      "strategyElapsedMs",
    ]);
  });

  it("hands the next rotation a cursor derived from the fallback pick", () => {
    const breached = selectExecutionRouteWithReceipt(
      policy(),
      options({ strategyElapsedMs: 40 }),
    );
    const nextCursor = breached.decision.selectedCandidateId;
    expect(nextCursor).toBe(PREFERENCE_HEAD);

    const next = selectExecutionRouteWithReceipt(
      policy(),
      options({ roundRobinCursor: nextCursor as string, strategyElapsedMs: 5 }),
    );

    // Rotation resumes deterministically from the fallback pick: the canonical
    // successor of bravo:sdk.
    expect(next.deadlineOutcome).toBe("within");
    expect(next.decision.selectedCandidateId).toBe("charlie:sdk");
  });

  it("agrees across repeated calls separated in real time", () => {
    const first = selectExecutionRouteWithReceipt(
      policy(),
      options({ strategyElapsedMs: 40 }),
    );
    const busyUntil = Date.now() + 5;
    while (Date.now() < busyUntil) {
      /* burn real wall-clock time between the two decisions */
    }
    const second = selectExecutionRouteWithReceipt(
      policy(),
      options({ strategyElapsedMs: 40 }),
    );

    expect(second).toEqual(first);
  });
});
