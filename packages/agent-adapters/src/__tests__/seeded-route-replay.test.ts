import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DeterministicRouteSelectionAdmissionError,
  replayRouteSelectionReceipt,
  selectExecutionRouteWithReceipt,
  type RouteSelectionReceipt,
} from "../registry/deterministic-candidate-selector.js";
import {
  replayCandidate,
  replayPolicy,
  REPLAY_DECIDED_AT,
  SEEDED_ROUTE_REPLAY_SCENARIOS,
} from "./fixtures/seeded-route-replay-scenarios.js";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "seeded-route-replay-receipts.json",
);

/** Serialization used for every byte comparison and for the committed file. */
function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function recordAllScenarios(): Record<string, RouteSelectionReceipt> {
  const recorded: Record<string, RouteSelectionReceipt> = {};
  for (const scenario of SEEDED_ROUTE_REPLAY_SCENARIOS) {
    recorded[scenario.name] = selectExecutionRouteWithReceipt(
      scenario.policy,
      scenario.options,
    );
  }
  return recorded;
}

// Set DZUP_RECORD_ROUTE_REPLAY_FIXTURE=1 to deliberately rewrite the fixture.
// It is never set in CI, so an unintended change in the seeded pick fails here
// instead of quietly rebaselining itself.
if (process.env.DZUP_RECORD_ROUTE_REPLAY_FIXTURE === "1") {
  writeFileSync(FIXTURE_PATH, serialize(recordAllScenarios()), "utf8");
}

const committedBytes = readFileSync(FIXTURE_PATH, "utf8");
const committed = JSON.parse(committedBytes) as Record<
  string,
  RouteSelectionReceipt
>;

describe("seeded route selection replay fixtures", () => {
  it("reproduces every committed receipt byte for byte", () => {
    expect(serialize(recordAllScenarios())).toBe(committedBytes);
  });

  it("covers every scenario and nothing else", () => {
    expect(Object.keys(committed).sort()).toEqual(
      SEEDED_ROUTE_REPLAY_SCENARIOS.map((scenario) => scenario.name).sort(),
    );
  });

  it.each(
    SEEDED_ROUTE_REPLAY_SCENARIOS.map(
      (scenario) => [scenario.name, scenario] as const,
    ),
  )("replays %s from the receipt alone", (_name, scenario) => {
    const recorded = committed[scenario.name] as RouteSelectionReceipt;

    // The receipt carries decidedAt, seed and routing key, so nothing but the
    // policy and the receipt is needed to reproduce the decision.
    const replayed = replayRouteSelectionReceipt(scenario.policy, recorded);

    expect(serialize(replayed)).toBe(serialize(recorded));
  });

  it("keeps the seed load-bearing for the weighted draw", () => {
    const seed0 = committed["weighted-seed-0"] as RouteSelectionReceipt;
    const seed2 = committed["weighted-seed-2"] as RouteSelectionReceipt;

    // Same policy, same candidates, same eligibility — only the seed differs.
    expect(seed0.decision.eligibleCandidateIds).toEqual(
      seed2.decision.eligibleCandidateIds,
    );
    expect(seed0.seed).not.toBe(seed2.seed);
    expect(seed0.decision.selectedCandidateId).not.toBe(
      seed2.decision.selectedCandidateId,
    );
  });

  it("does not let the weighted pick collapse onto the first eligible candidate", () => {
    const seed0 = committed["weighted-seed-0"] as RouteSelectionReceipt;

    // A draw that ignored the seed and returned eligible[0] would still satisfy
    // "deterministic", so the fixture pins a winner that is not eligible[0].
    expect(seed0.decision.selectedCandidateId).not.toBe(
      seed0.decision.eligibleCandidateIds[0],
    );
  });

  it("routes two different keys to two different candidates under one seed", () => {
    const tenant42 = committed["hash-tenant-42"] as RouteSelectionReceipt;
    const tenant99 = committed["hash-tenant-99"] as RouteSelectionReceipt;

    expect(tenant42.seed).toBe(tenant99.seed);
    expect(tenant42.routingKey).not.toBe(tenant99.routingKey);
    expect(tenant42.decision.selectedCandidateId).not.toBe(
      tenant99.decision.selectedCandidateId,
    );
  });

  it("records no seed, key or weights for an unseeded strategy", () => {
    const baseline = committed["rule-baseline"] as RouteSelectionReceipt;

    expect(baseline.seed).toBeNull();
    expect(baseline.routingKey).toBeNull();
    expect(baseline.candidateWeights).toBeNull();
  });

  it.each([
    {
      name: "weighted without a seed",
      scenario: "weighted-seed-0",
      options: { decidedAt: "2026-07-12T12:00:00.000Z" },
      code: "SEEDED_STRATEGY_REQUIRES_SEED",
    },
    {
      name: "hash without a seed",
      scenario: "hash-tenant-42",
      options: {
        decidedAt: "2026-07-12T12:00:00.000Z",
        routingKey: "tenant-42",
      },
      code: "SEEDED_STRATEGY_REQUIRES_SEED",
    },
    {
      name: "hash without a routing key",
      scenario: "hash-tenant-42",
      options: {
        decidedAt: "2026-07-12T12:00:00.000Z",
        seed: "seed-alpha",
      },
      code: "HASH_STRATEGY_REQUIRES_ROUTING_KEY",
    },
    // An empty string is a *present* input, so it has to be denied separately
    // from an absent one: a guard that only checked for undefined would leave
    // an empty seed or key silently steering the draw.
    {
      name: "weighted with an empty seed",
      scenario: "weighted-seed-0",
      options: { decidedAt: "2026-07-12T12:00:00.000Z", seed: "" },
      code: "SEEDED_STRATEGY_REQUIRES_SEED",
    },
    {
      name: "hash with an empty seed",
      scenario: "hash-tenant-42",
      options: {
        decidedAt: "2026-07-12T12:00:00.000Z",
        seed: "",
        routingKey: "tenant-42",
      },
      code: "SEEDED_STRATEGY_REQUIRES_SEED",
    },
    {
      name: "hash with an empty routing key",
      scenario: "hash-tenant-42",
      options: {
        decidedAt: "2026-07-12T12:00:00.000Z",
        seed: "seed-alpha",
        routingKey: "",
      },
      code: "HASH_STRATEGY_REQUIRES_ROUTING_KEY",
    },
  ] as const)("fails closed for $name", ({ scenario, options, code }) => {
    const definition = SEEDED_ROUTE_REPLAY_SCENARIOS.find(
      (item) => item.name === scenario,
    );
    expect(definition).toBeDefined();

    expect(() =>
      selectExecutionRouteWithReceipt(definition!.policy, options),
    ).toThrow(
      expect.objectContaining<
        Partial<DeterministicRouteSelectionAdmissionError>
      >({
        name: "DeterministicRouteSelectionAdmissionError",
        code,
      }),
    );
  });

  // Every case below is a *valid* weighted policy except for the one weight
  // under test, so a passing case cannot be explained by an unrelated denial.
  it.each([
    {
      name: "a candidate declaring no weight",
      tags: undefined,
      code: "WEIGHTED_STRATEGY_REQUIRES_CANDIDATE_WEIGHT",
    },
    {
      name: "a candidate declaring two weights",
      tags: ["route-weight:2", "route-weight:5"],
      code: "WEIGHTED_STRATEGY_REQUIRES_CANDIDATE_WEIGHT",
    },
    {
      name: "a negative weight",
      tags: ["route-weight:-3"],
      code: "WEIGHTED_STRATEGY_INVALID_CANDIDATE_WEIGHT",
    },
    {
      name: "a zero weight",
      tags: ["route-weight:0"],
      code: "WEIGHTED_STRATEGY_INVALID_CANDIDATE_WEIGHT",
    },
    {
      name: "a non-numeric weight",
      tags: ["route-weight:heavy"],
      code: "WEIGHTED_STRATEGY_INVALID_CANDIDATE_WEIGHT",
    },
    {
      name: "an empty weight",
      tags: ["route-weight:"],
      code: "WEIGHTED_STRATEGY_INVALID_CANDIDATE_WEIGHT",
    },
    {
      name: "a fractional weight",
      tags: ["route-weight:1.5"],
      code: "WEIGHTED_STRATEGY_INVALID_CANDIDATE_WEIGHT",
    },
    {
      name: "an infinite weight",
      tags: ["route-weight:Infinity"],
      code: "WEIGHTED_STRATEGY_INVALID_CANDIDATE_WEIGHT",
    },
  ] as const)("denies a weighted policy carrying $name", ({ tags, code }) => {
    const policy = replayPolicy(
      [
        replayCandidate("alpha:sdk", { tags: ["route-weight:1"] }),
        replayCandidate(
          "bravo:sdk",
          tags === undefined ? {} : { tags: [...tags] },
        ),
        replayCandidate("charlie:sdk", { tags: ["route-weight:6"] }),
      ],
      { strategy: "weighted" },
    );

    expect(() =>
      selectExecutionRouteWithReceipt(policy, {
        decidedAt: REPLAY_DECIDED_AT,
        seed: "seed-0",
      }),
    ).toThrow(
      expect.objectContaining<
        Partial<DeterministicRouteSelectionAdmissionError>
      >({
        name: "DeterministicRouteSelectionAdmissionError",
        code,
      }),
    );
  });

  it("admits the control policy those weight cases mutate", () => {
    // Holds the guard's other dimensions accepting: only the weight under test
    // above differs from this policy, which must select successfully.
    const policy = replayPolicy(
      [
        replayCandidate("alpha:sdk", { tags: ["route-weight:1"] }),
        replayCandidate("bravo:sdk", { tags: ["route-weight:3"] }),
        replayCandidate("charlie:sdk", { tags: ["route-weight:6"] }),
      ],
      { strategy: "weighted" },
    );

    expect(
      selectExecutionRouteWithReceipt(policy, {
        decidedAt: REPLAY_DECIDED_AT,
        seed: "seed-0",
      }).decision.selectedCandidateId,
    ).not.toBeNull();
  });

  it("never draws an ineligible candidate, however heavily it is weighted", () => {
    // bravo carries 50x the weight of both eligible candidates combined, so a
    // draw that ran over the declared set instead of the eligible subset would
    // land on it almost immediately. Its weight is the control: the test only
    // means something because bravo would otherwise dominate.
    const policy = replayPolicy(
      [
        replayCandidate("alpha:sdk", { tags: ["route-weight:1"] }),
        replayCandidate("bravo:sdk", {
          tags: ["route-weight:100"],
          authAvailable: false,
        }),
        replayCandidate("charlie:sdk", { tags: ["route-weight:1"] }),
      ],
      { strategy: "weighted" },
    );

    for (let index = 0; index < 200; index++) {
      const { decision } = selectExecutionRouteWithReceipt(policy, {
        decidedAt: REPLAY_DECIDED_AT,
        seed: `seed-${index}`,
      });

      expect(decision.eligibleCandidateIds).toEqual([
        "alpha:sdk",
        "charlie:sdk",
      ]);
      expect(decision.selectedCandidateId).not.toBe("bravo:sdk");
      expect(decision.eligibleCandidateIds).toContain(
        decision.selectedCandidateId,
      );
    }
  });

  it("draws in proportion to the declared weights", () => {
    // Pins proportionality, not just determinism: a draw that treated every
    // candidate as equally weighted stays perfectly deterministic and would
    // pass every fixture above, but cannot reproduce these shares.
    const policy = replayPolicy(
      [
        replayCandidate("alpha:sdk", { tags: ["route-weight:1"] }),
        replayCandidate("bravo:sdk", { tags: ["route-weight:3"] }),
        replayCandidate("charlie:sdk", { tags: ["route-weight:6"] }),
      ],
      { strategy: "weighted" },
    );

    const draws = 1000;
    const counts: Record<string, number> = {
      "alpha:sdk": 0,
      "bravo:sdk": 0,
      "charlie:sdk": 0,
    };
    for (let index = 0; index < draws; index++) {
      const { decision } = selectExecutionRouteWithReceipt(policy, {
        decidedAt: REPLAY_DECIDED_AT,
        seed: `seed-${index}`,
      });
      counts[decision.selectedCandidateId as string] += 1;
    }

    // The draw is a pure function of fixed seeds, so these shares are exact and
    // reproducible; the tolerance covers hash spread, not run-to-run variance.
    expect(counts["alpha:sdk"] / draws).toBeCloseTo(0.1, 1);
    expect(counts["bravo:sdk"] / draws).toBeCloseTo(0.3, 1);
    expect(counts["charlie:sdk"] / draws).toBeCloseTo(0.6, 1);
  });

  it("advances the round-robin rotation instead of repeating the cursor's candidate", () => {
    const first = committed["round-robin-first"] as RouteSelectionReceipt;
    const second = committed[
      "round-robin-after-alpha"
    ] as RouteSelectionReceipt;
    const third = committed["round-robin-wraps"] as RouteSelectionReceipt;

    // Canonical id order, not declaration order (the fixture declares
    // charlie/alpha/bravo), drives the rotation.
    expect(first.roundRobinCursor).toBeNull();
    expect(first.decision.selectedCandidateId).toBe("alpha:sdk");
    expect(second.roundRobinCursor).toBe("alpha:sdk");
    expect(second.decision.selectedCandidateId).toBe("bravo:sdk");
    expect(third.roundRobinCursor).toBe("charlie:sdk");
    expect(third.decision.selectedCandidateId).toBe("alpha:sdk");
  });

  it("records the deadline verdict each committed scenario earned", () => {
    const within = committed["deadline-within"] as RouteSelectionReceipt;
    const breached = committed[
      "deadline-exceeded-ordered-fallback"
    ] as RouteSelectionReceipt;
    const denied = committed[
      "deadline-exceeded-no-fallback"
    ] as RouteSelectionReceipt;
    const unmeasured = committed["round-robin-first"] as RouteSelectionReceipt;

    // Only the measured latency differs between `within` and `breached`: 25ms
    // against a 25ms budget is compliant, 26ms is not.
    expect(within.deadlineOutcome).toBe("within");
    expect(within.strategyElapsedMs).toBe(25);
    expect(within.selectionDeadlineMs).toBe(25);
    expect(breached.deadlineOutcome).toBe("exceeded");
    expect(breached.strategyElapsedMs).toBe(26);

    // A scenario that declared no elapsed time is recorded as unevaluated, not
    // as having met a budget nobody measured.
    expect(unmeasured.deadlineOutcome).toBe("not-evaluated");
    expect(unmeasured.strategyElapsedMs).toBeNull();
    expect(unmeasured.selectionDeadlineMs).toBeNull();

    expect(denied.deadlineOutcome).toBe("exceeded");
    expect(denied.decision.selectedCandidateId).toBeNull();
  });

  it("commits a deadline fallback pick that no other ordering rule produces", () => {
    const within = committed["deadline-within"] as RouteSelectionReceipt;
    const breached = committed[
      "deadline-exceeded-ordered-fallback"
    ] as RouteSelectionReceipt;

    // The scenario declares candidates charlie/alpha/bravo with preference
    // order bravo/charlie/alpha, so the three candidate orderings disagree.
    expect(breached.decision.selectedCandidateId).toBe("bravo:sdk");
    // ...not the input-order head,
    expect(breached.decision.selectedCandidateId).not.toBe("charlie:sdk");
    // ...not the canonical-id head,
    expect(breached.decision.selectedCandidateId).not.toBe("alpha:sdk");
    // ...and not the pick the round-robin strategy itself would have made.
    expect(within.decision.selectedCandidateId).toBe("charlie:sdk");
    expect(breached.decision.selectedCandidateId).not.toBe(
      within.decision.selectedCandidateId,
    );
  });

  it("cycles a full rotation by feeding each receipt's pick back as the cursor", () => {
    const policy = replayPolicy(
      [
        replayCandidate("charlie:sdk"),
        replayCandidate("alpha:sdk"),
        replayCandidate("bravo:sdk"),
      ],
      { strategy: "round-robin" },
    );

    const seen: (string | null)[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 6; index++) {
      const receipt = selectExecutionRouteWithReceipt(policy, {
        decidedAt: REPLAY_DECIDED_AT,
        ...(cursor === undefined ? {} : { roundRobinCursor: cursor }),
      });
      seen.push(receipt.decision.selectedCandidateId);
      cursor = receipt.decision.selectedCandidateId ?? undefined;
    }

    expect(seen).toEqual([
      "alpha:sdk",
      "bravo:sdk",
      "charlie:sdk",
      "alpha:sdk",
      "bravo:sdk",
      "charlie:sdk",
    ]);
  });

  it("keeps round-robin a pure function of its inputs: no hidden rotation state", () => {
    const policy = replayPolicy(
      [
        replayCandidate("alpha:sdk"),
        replayCandidate("bravo:sdk"),
        replayCandidate("charlie:sdk"),
      ],
      { strategy: "round-robin" },
    );
    const options = {
      decidedAt: REPLAY_DECIDED_AT,
      roundRobinCursor: "alpha:sdk",
    };

    // A module- or instance-level cursor would advance between these calls;
    // identical inputs must produce byte-identical receipts every time.
    const receipts = [
      selectExecutionRouteWithReceipt(policy, options),
      selectExecutionRouteWithReceipt(policy, options),
      selectExecutionRouteWithReceipt(policy, options),
    ].map((receipt) => serialize(receipt));

    expect(receipts[1]).toBe(receipts[0]);
    expect(receipts[2]).toBe(receipts[0]);
    expect(
      (JSON.parse(receipts[0] as string) as RouteSelectionReceipt).decision
        .selectedCandidateId,
    ).toBe("bravo:sdk");
  });

  it.each([
    // An empty cursor is a *present* input, denied separately from an absent
    // one, exactly like an empty seed.
    {
      name: "an empty cursor",
      cursor: "",
      code: "ROUND_ROBIN_STRATEGY_INVALID_CURSOR",
    },
    {
      name: "a cursor naming no declared candidate",
      cursor: "ghost:sdk",
      code: "ROUND_ROBIN_STRATEGY_UNKNOWN_CURSOR_CANDIDATE",
    },
  ] as const)("fails closed for $name", ({ cursor, code }) => {
    const policy = replayPolicy(
      [replayCandidate("alpha:sdk"), replayCandidate("bravo:sdk")],
      { strategy: "round-robin" },
    );

    expect(() =>
      selectExecutionRouteWithReceipt(policy, {
        decidedAt: REPLAY_DECIDED_AT,
        roundRobinCursor: cursor,
      }),
    ).toThrow(
      expect.objectContaining<
        Partial<DeterministicRouteSelectionAdmissionError>
      >({
        name: "DeterministicRouteSelectionAdmissionError",
        code,
      }),
    );
  });

  it("records a null round-robin cursor for every non-round-robin strategy", () => {
    for (const name of [
      "weighted-seed-0",
      "hash-tenant-42",
      "rule-baseline",
    ] as const) {
      expect(
        (committed[name] as RouteSelectionReceipt).roundRobinCursor,
      ).toBeNull();
    }
  });

  it("denies a weighted policy that declares no candidates at all", () => {
    expect(() =>
      selectExecutionRouteWithReceipt(
        replayPolicy([], { strategy: "weighted" }),
        {
          decidedAt: REPLAY_DECIDED_AT,
          seed: "seed-0",
        },
      ),
    ).toThrow(
      expect.objectContaining<
        Partial<DeterministicRouteSelectionAdmissionError>
      >({
        name: "DeterministicRouteSelectionAdmissionError",
        code: "WEIGHTED_STRATEGY_REQUIRES_POSITIVE_WEIGHT_SUM",
      }),
    );
  });
});
