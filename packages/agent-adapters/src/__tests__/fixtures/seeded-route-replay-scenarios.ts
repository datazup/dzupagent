import type {
  ExecutionRouteCandidate,
  ExecutionRoutePolicy,
} from "@dzupagent/runtime-contracts";

import type { DeterministicRouteSelectionOptions } from "../../registry/deterministic-candidate-selector.js";

/**
 * Replay scenarios for the seeded route strategies.
 *
 * These definitions are the *inputs* half of the replay fixture. The recorded
 * outputs live beside them in `seeded-route-replay-receipts.json`, which is
 * regenerated only by deliberately rewriting it: the spec compares the freshly
 * computed receipts against the committed bytes, so any drift in the seeded
 * pick — including a pick that stops reading the seed — fails the suite.
 */

export const REPLAY_DECIDED_AT = "2026-07-12T12:00:00.000Z";

export function replayCandidate(
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

export function replayPolicy(
  candidates: readonly ExecutionRouteCandidate[],
  overrides: Partial<ExecutionRoutePolicy> = {},
): ExecutionRoutePolicy {
  return {
    id: "route-policy",
    requestId: "request-1",
    strategy: "rule",
    candidates,
    hardConstraints: [],
    preferenceOrder: candidates.map((item) => item.id),
    fallback: "ordered-compatible",
    maxSelectionLatencyMs: 25,
    ...overrides,
  };
}

/** Weights 1 / 3 / 6 make every candidate reachable and none of them a default. */
const WEIGHTED_CANDIDATES = [
  replayCandidate("alpha:sdk", { tags: ["route-weight:1"] }),
  replayCandidate("bravo:sdk", { tags: ["route-weight:3"] }),
  replayCandidate("charlie:sdk", { tags: ["route-weight:6"] }),
];

const HASH_CANDIDATES = [
  replayCandidate("alpha:sdk"),
  replayCandidate("bravo:sdk"),
  replayCandidate("charlie:sdk"),
];

/** Declared out of canonical order so rotation order cannot be input order. */
const ROUND_ROBIN_CANDIDATES = [
  replayCandidate("charlie:sdk"),
  replayCandidate("alpha:sdk"),
  replayCandidate("bravo:sdk"),
];

/**
 * Preference order for the deadline scenarios, chosen to disagree with BOTH
 * the input order (charlie first) and canonical id order (alpha first), so the
 * recorded fallback pick can only have come from the declared preference chain.
 */
const DEADLINE_PREFERENCE_ORDER = ["bravo:sdk", "charlie:sdk", "alpha:sdk"];

export interface SeededRouteReplayScenario {
  readonly name: string;
  readonly policy: ExecutionRoutePolicy;
  readonly options: DeterministicRouteSelectionOptions;
  /** Why this scenario exists — what a regression here would mean. */
  readonly proves: string;
}

export const SEEDED_ROUTE_REPLAY_SCENARIOS: readonly SeededRouteReplayScenario[] =
  [
    {
      name: "weighted-seed-0",
      policy: replayPolicy(WEIGHTED_CANDIDATES, { strategy: "weighted" }),
      options: { decidedAt: REPLAY_DECIDED_AT, seed: "seed-0" },
      proves:
        "a recorded seed reproduces the weighted pick; the winner is not the first eligible candidate",
    },
    {
      name: "weighted-seed-2",
      policy: replayPolicy(WEIGHTED_CANDIDATES, { strategy: "weighted" }),
      options: { decidedAt: REPLAY_DECIDED_AT, seed: "seed-2" },
      proves:
        "the same policy under a different seed lands on a different candidate, so the seed is load-bearing",
    },
    {
      name: "weighted-excludes-ineligible",
      policy: replayPolicy(
        [
          replayCandidate("alpha:sdk", { tags: ["route-weight:1"] }),
          replayCandidate("bravo:sdk", {
            tags: ["route-weight:3"],
            authAvailable: false,
          }),
          replayCandidate("charlie:sdk", { tags: ["route-weight:6"] }),
        ],
        { strategy: "weighted" },
      ),
      options: { decidedAt: REPLAY_DECIDED_AT, seed: "seed-0" },
      proves:
        "an ineligible candidate is rejected by the full eligibility pass and never enters the draw",
    },
    {
      name: "hash-tenant-42",
      policy: replayPolicy(HASH_CANDIDATES, { strategy: "hash" }),
      options: {
        decidedAt: REPLAY_DECIDED_AT,
        seed: "seed-alpha",
        routingKey: "tenant-42",
      },
      proves: "a routing key reproduces its candidate exactly",
    },
    {
      name: "hash-tenant-99",
      policy: replayPolicy(HASH_CANDIDATES, { strategy: "hash" }),
      options: {
        decidedAt: REPLAY_DECIDED_AT,
        seed: "seed-alpha",
        routingKey: "tenant-99",
      },
      proves:
        "a different routing key under the same seed reaches a different candidate",
    },
    {
      name: "rule-baseline",
      policy: replayPolicy(HASH_CANDIDATES),
      options: { decidedAt: REPLAY_DECIDED_AT },
      proves:
        "an unseeded strategy still produces a receipt, with null seed, key and weights",
    },
    {
      name: "round-robin-first",
      policy: replayPolicy(ROUND_ROBIN_CANDIDATES, { strategy: "round-robin" }),
      options: { decidedAt: REPLAY_DECIDED_AT },
      proves:
        "an absent cursor starts the rotation at the first candidate in canonical id order, recording a null cursor",
    },
    {
      name: "round-robin-after-alpha",
      policy: replayPolicy(ROUND_ROBIN_CANDIDATES, { strategy: "round-robin" }),
      options: { decidedAt: REPLAY_DECIDED_AT, roundRobinCursor: "alpha:sdk" },
      proves:
        "a receipt-carried cursor advances the rotation to the canonical successor instead of repeating the cursor's candidate",
    },
    {
      name: "round-robin-wraps",
      policy: replayPolicy(ROUND_ROBIN_CANDIDATES, { strategy: "round-robin" }),
      options: {
        decidedAt: REPLAY_DECIDED_AT,
        roundRobinCursor: "charlie:sdk",
      },
      proves:
        "a cursor at the canonical end wraps the rotation back to the first eligible candidate",
    },
    {
      name: "round-robin-skips-ineligible",
      policy: replayPolicy(
        [
          replayCandidate("alpha:sdk"),
          replayCandidate("bravo:sdk", { authAvailable: false }),
          replayCandidate("charlie:sdk"),
        ],
        { strategy: "round-robin" },
      ),
      options: { decidedAt: REPLAY_DECIDED_AT, roundRobinCursor: "alpha:sdk" },
      proves:
        "an ineligible candidate is skipped by the successor rule: the rotation lands on the next eligible candidate",
    },
    {
      name: "round-robin-cursor-ineligible",
      policy: replayPolicy(
        [
          replayCandidate("alpha:sdk"),
          replayCandidate("bravo:sdk", { authAvailable: false }),
          replayCandidate("charlie:sdk"),
        ],
        { strategy: "round-robin" },
      ),
      options: { decidedAt: REPLAY_DECIDED_AT, roundRobinCursor: "bravo:sdk" },
      proves:
        "a cursor naming a declared-but-now-ineligible candidate is re-derived deterministically: its canonical successor among the eligible set wins",
    },
    {
      name: "deadline-within",
      policy: replayPolicy(ROUND_ROBIN_CANDIDATES, {
        strategy: "round-robin",
        preferenceOrder: DEADLINE_PREFERENCE_ORDER,
      }),
      options: {
        decidedAt: REPLAY_DECIDED_AT,
        roundRobinCursor: "bravo:sdk",
        strategyElapsedMs: 25,
      },
      proves:
        "an elapsed time exactly at the declared budget is within it, so the strategy's own pick stands and the receipt records the measured latency",
    },
    {
      name: "deadline-exceeded-ordered-fallback",
      policy: replayPolicy(ROUND_ROBIN_CANDIDATES, {
        strategy: "round-robin",
        preferenceOrder: DEADLINE_PREFERENCE_ORDER,
      }),
      options: {
        decidedAt: REPLAY_DECIDED_AT,
        roundRobinCursor: "bravo:sdk",
        strategyElapsedMs: 26,
      },
      proves:
        "one millisecond past the budget discards the strategy pick for the ordered-compatible chain head, which is neither the input-order nor the canonical-id head",
    },
    {
      name: "deadline-exceeded-no-fallback",
      policy: replayPolicy(ROUND_ROBIN_CANDIDATES, {
        strategy: "round-robin",
        preferenceOrder: DEADLINE_PREFERENCE_ORDER,
        fallback: "none",
      }),
      options: {
        decidedAt: REPLAY_DECIDED_AT,
        roundRobinCursor: "bravo:sdk",
        strategyElapsedMs: 26,
      },
      proves:
        "a breached deadline under a policy declaring no fallback selects nothing, and the breach is still recorded as a replayable receipt rather than an exception",
    },
  ];
