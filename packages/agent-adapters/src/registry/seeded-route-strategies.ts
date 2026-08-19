import type {
  ExecutionRouteCandidate,
  ExecutionRoutePolicy,
} from "@dzupagent/runtime-contracts";

/**
 * Seeded route-strategy primitives.
 *
 * Every function here is a pure function of its arguments: no clock, no
 * `Math.random`, no ambient state. The seed and the routing key are inputs
 * supplied by the host and recorded in the selection receipt, so replaying a
 * receipt against the same policy reproduces the identical decision.
 *
 * The module deliberately never throws: each guard returns a typed failure so
 * the selector owns the single admission-error vocabulary and this module stays
 * free of a dependency cycle back onto the selector.
 */

/**
 * Candidate weights travel on the shipped `ExecutionRouteCandidate.tags`
 * vocabulary as `route-weight:<positive integer>`. The canonical route-policy
 * contract carries no weight field and lives in another package, so the tag
 * channel is the additive, contract-compatible way to express weights.
 */
export const ROUTE_WEIGHT_TAG_PREFIX = "route-weight:";

/** Strategies whose decision consumes a recorded seed. */
export type SeededRouteStrategy = "weighted" | "hash";

export type SeededRouteStrategyFailureCode =
  | "SEEDED_STRATEGY_REQUIRES_SEED"
  | "WEIGHTED_STRATEGY_REQUIRES_CANDIDATE_WEIGHT"
  | "WEIGHTED_STRATEGY_INVALID_CANDIDATE_WEIGHT"
  | "WEIGHTED_STRATEGY_REQUIRES_POSITIVE_WEIGHT_SUM"
  | "HASH_STRATEGY_REQUIRES_ROUTING_KEY";

export interface SeededRouteStrategyFailure {
  readonly code: SeededRouteStrategyFailureCode;
  readonly message: string;
}

export type SeededRouteStrategyResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: SeededRouteStrategyFailure };

/** Field separator for digest inputs; never occurs inside candidate ids. */
const FIELD_SEPARATOR = "\u001f";
/** Record separator between per-candidate digest segments. */
const RECORD_SEPARATOR = "\u001e";

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a, 32-bit. Chosen because it is fully specified, allocation-free and
 * identical on every platform, so a digest recorded in a receipt today
 * reproduces byte-for-byte on replay. It is not a cryptographic hash and is
 * never used as one.
 */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** Reads the single `route-weight:` tag off a candidate, failing closed. */
export function readCandidateWeight(
  candidate: ExecutionRouteCandidate,
): SeededRouteStrategyResult<number> {
  const declarations = (candidate.tags ?? []).filter((tag) =>
    tag.startsWith(ROUTE_WEIGHT_TAG_PREFIX),
  );
  if (declarations.length !== 1) {
    return failure(
      "WEIGHTED_STRATEGY_REQUIRES_CANDIDATE_WEIGHT",
      `Weighted route candidate "${candidate.id}" must declare exactly one ${ROUTE_WEIGHT_TAG_PREFIX}<n> tag; found ${declarations.length}`,
    );
  }

  const raw = (declarations[0] as string).slice(ROUTE_WEIGHT_TAG_PREFIX.length);
  const weight = Number(raw);
  if (!Number.isSafeInteger(weight) || weight < 1) {
    return failure(
      "WEIGHTED_STRATEGY_INVALID_CANDIDATE_WEIGHT",
      `Weighted route candidate "${candidate.id}" declares weight "${raw}", which is not a safe positive integer`,
    );
  }
  return { ok: true, value: weight };
}

/**
 * Reads every candidate weight for a weighted policy.
 *
 * Weights are validated across the declared candidate set — not the eligible
 * subset — so an invalid weight fails admission before any candidate is
 * evaluated, exactly like the other policy-admission guards.
 */
export function readPolicyCandidateWeights(
  policy: ExecutionRoutePolicy,
): SeededRouteStrategyResult<ReadonlyMap<string, number>> {
  const weights = new Map<string, number>();
  let total = 0;
  for (const candidate of policy.candidates) {
    const read = readCandidateWeight(candidate);
    if (!read.ok) return read;
    weights.set(candidate.id, read.value);
    total += read.value;
  }
  if (total <= 0) {
    return failure(
      "WEIGHTED_STRATEGY_REQUIRES_POSITIVE_WEIGHT_SUM",
      `Weighted route strategy requires a positive total candidate weight; received ${total} across ${policy.candidates.length} candidate(s)`,
    );
  }
  return { ok: true, value: weights };
}

/** Rejects a missing or blank seed for the strategies whose pick consumes one. */
export function requireSeed(
  strategy: SeededRouteStrategy,
  seed: string | undefined,
): SeededRouteStrategyResult<string> {
  if (seed === undefined || seed.length === 0) {
    return failure(
      "SEEDED_STRATEGY_REQUIRES_SEED",
      `Route strategy "${strategy}" requires a non-empty seed so the decision is replayable`,
    );
  }
  return { ok: true, value: seed };
}

/** Rejects a missing or blank hash routing key. */
export function requireRoutingKey(
  routingKey: string | undefined,
): SeededRouteStrategyResult<string> {
  if (routingKey === undefined || routingKey.length === 0) {
    return failure(
      "HASH_STRATEGY_REQUIRES_ROUTING_KEY",
      'Route strategy "hash" requires a non-empty routing key so the decision is stable per key',
    );
  }
  return { ok: true, value: routingKey };
}

/**
 * Seeded pick proportional to candidate weight.
 *
 * The draw runs over candidates sorted by id, so the preference order — which
 * is `rule` vocabulary — cannot shift a weighted pick. The digest binds the
 * seed to the policy identity and to the exact weighted candidate set, so
 * adding or reweighting a candidate produces a fresh draw rather than silently
 * inheriting the previous one.
 */
export function drawWeightedCandidate(
  eligible: readonly ExecutionRouteCandidate[],
  weights: ReadonlyMap<string, number>,
  seed: string,
  policy: ExecutionRoutePolicy,
): ExecutionRouteCandidate | undefined {
  const ordered = [...eligible].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  if (ordered.length === 0) return undefined;

  let total = 0;
  for (const candidate of ordered) total += weights.get(candidate.id) ?? 0;
  if (total <= 0) return undefined;

  const digest = fnv1a32(
    [
      seed,
      policy.id,
      policy.requestId,
      ordered
        .map((candidate) => `${candidate.id}=${weights.get(candidate.id) ?? 0}`)
        .join(RECORD_SEPARATOR),
    ].join(FIELD_SEPARATOR),
  );

  let cursor = digest % total;
  for (const candidate of ordered) {
    cursor -= weights.get(candidate.id) ?? 0;
    if (cursor < 0) return candidate;
  }
  return ordered[ordered.length - 1];
}

/**
 * Stable key-based pick using rendezvous (highest-random-weight) hashing.
 *
 * Scoring each candidate independently — rather than taking a digest modulo the
 * candidate count — keeps a key pinned to its candidate when unrelated
 * candidates join or leave the eligible set. The pick depends on the seed, the
 * routing key and the candidate id only: deliberately not on the request id, so
 * the same key routes to the same candidate across requests.
 */
export function drawHashCandidate(
  eligible: readonly ExecutionRouteCandidate[],
  seed: string,
  routingKey: string,
): ExecutionRouteCandidate | undefined {
  let winner: ExecutionRouteCandidate | undefined;
  let winningScore = -1;
  for (const candidate of eligible) {
    const score = fnv1a32(
      [seed, routingKey, candidate.id].join(FIELD_SEPARATOR),
    );
    if (
      winner === undefined ||
      score > winningScore ||
      (score === winningScore && candidate.id.localeCompare(winner.id) < 0)
    ) {
      winner = candidate;
      winningScore = score;
    }
  }
  return winner;
}

function failure(
  code: SeededRouteStrategyFailureCode,
  message: string,
): SeededRouteStrategyResult<never> {
  return { ok: false, failure: { code, message } };
}
