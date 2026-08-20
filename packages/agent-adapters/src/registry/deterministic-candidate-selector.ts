import type {
  ExecutionRouteCandidate,
  ExecutionRouteCostClass,
  ExecutionRouteDecision,
  ExecutionRoutePolicy,
  ExecutionRoutePrivacyClass,
  ExecutionRouteRejection,
  ExecutionRouteRejectionCode,
  ExecutionRouteTransitionDecision,
  ExecutionRouteTransitionKind,
} from "@dzupagent/runtime-contracts";

import {
  drawRoundRobinCandidate,
  requireRoundRobinCursor,
} from "./round-robin-route-strategy.js";
import type { RoundRobinRouteStrategyFailureCode } from "./round-robin-route-strategy.js";
import {
  drawHashCandidate,
  drawWeightedCandidate,
  readPolicyCandidateWeights,
  requireRoutingKey,
  requireSeed,
} from "./seeded-route-strategies.js";
import type { SeededRouteStrategyFailureCode } from "./seeded-route-strategies.js";

const COST_RANK: Record<ExecutionRouteCostClass, number> = {
  free: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const PRIVACY_RANK: Record<ExecutionRoutePrivacyClass, number> = {
  device: 0,
  "private-network": 1,
  provider: 2,
  public: 3,
};

export interface DeterministicRouteSelectionOptions {
  /** Host-supplied timestamp keeps selection deterministic and replayable. */
  decidedAt: string;
  /**
   * Host-supplied seed consumed by the `weighted` and `hash` strategies. It is
   * an input to the decision, never drawn at decision time, and is recorded in
   * the selection receipt so a replay reproduces the identical pick.
   */
  seed?: string;
  /**
   * Host-supplied routing key consumed by the `hash` strategy. The same key
   * routes to the same candidate for a given seed and eligible candidate set.
   */
  routingKey?: string;
  /**
   * Receipt-carried cursor consumed by the `round-robin` strategy: the
   * candidate id the previous decision selected. Absent for the first
   * selection. It is an input to the decision — never module state — and is
   * recorded in the selection receipt so a replay reproduces the identical
   * pick. See `round-robin-route-strategy.ts` for the full cursor semantics.
   */
  roundRobinCursor?: string;
}

/** Strategies whose selection semantics are implemented by this selector. */
export const IMPLEMENTED_DETERMINISTIC_ROUTE_STRATEGIES = [
  "fixed",
  "hash",
  "round-robin",
  "rule",
  "weighted",
] as const;

type ImplementedDeterministicRouteStrategy =
  (typeof IMPLEMENTED_DETERMINISTIC_ROUTE_STRATEGIES)[number];

export type DeterministicRouteSelectionAdmissionCode =
  | "UNSUPPORTED_ROUTE_STRATEGY"
  | "DUPLICATE_ROUTE_CANDIDATE"
  | "FIXED_STRATEGY_REQUIRES_SINGLE_CANDIDATE"
  | SeededRouteStrategyFailureCode
  | RoundRobinRouteStrategyFailureCode;

/** Fail-closed policy-admission error raised before any candidate is evaluated. */
export class DeterministicRouteSelectionAdmissionError extends Error {
  readonly code: DeterministicRouteSelectionAdmissionCode;

  constructor(code: DeterministicRouteSelectionAdmissionCode, message: string) {
    super(message);
    this.name = "DeterministicRouteSelectionAdmissionError";
    this.code = code;
  }
}

/**
 * Pure deterministic candidate selector. Input order never decides ties.
 *
 * `rule` evaluates the full candidate set with preference ordering; `fixed`
 * requires exactly one candidate (the policy vocabulary carries no fixed
 * candidate identifier, so fixedness is single-candidate by construction —
 * matching the flow compiler, the only first-party producer) and still
 * evaluates that candidate's eligibility so an unavailable or incompatible
 * fixed target fails closed instead of being selected blindly.
 *
 * `weighted` and `hash` add a seeded pick on top of the same eligibility pass:
 * every candidate still runs the full evaluation, and only the eligible subset
 * enters the draw. Both are pure functions of the policy, the candidates and
 * the recorded seed — the seed is an input, never generated here — so a replay
 * of the selection receipt reproduces the decision exactly.
 *
 * `round-robin` rotates over the eligible subset in canonical id order using a
 * receipt-carried cursor — the previous decision's selected candidate id — so
 * rotation state never lives in this module and the pick stays a pure function
 * of (policy, candidates, cursor). See `round-robin-route-strategy.ts` for the
 * cursor semantics, including how candidate-set changes are re-derived.
 *
 * The broader route-policy vocabulary is intentionally not treated as
 * metadata: strategies without an implementation fail before selection.
 */
export function selectExecutionRoute(
  policy: ExecutionRoutePolicy,
  options: DeterministicRouteSelectionOptions,
): ExecutionRouteDecision {
  return decideExecutionRoute(policy, options).decision;
}

function decideExecutionRoute(
  policy: ExecutionRoutePolicy,
  options: DeterministicRouteSelectionOptions,
): { decision: ExecutionRouteDecision; admitted: AdmittedRouteSelection } {
  const admitted = assertRoutePolicyAdmission(policy, options);
  const candidates = [...policy.candidates];
  const byId = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  const origin = policy.originCandidateId
    ? byId.get(policy.originCandidateId)
    : undefined;
  const approved = new Set(policy.approvedTransitions ?? []);
  const rejected: ExecutionRouteRejection[] = [];
  const transitions: ExecutionRouteTransitionDecision[] = [];
  const eligible: ExecutionRouteCandidate[] = [];

  for (const candidate of candidates) {
    const failures = evaluateCandidate(candidate, policy);
    const transitionKinds =
      origin && origin.id !== candidate.id
        ? classifyRouteTransition(origin, candidate)
        : [];
    if (origin && origin.id !== candidate.id) {
      const transitionApproved = transitionKinds.every((kind) =>
        approved.has(kind),
      );
      transitions.push({
        fromCandidateId: origin.id,
        toCandidateId: candidate.id,
        kinds: transitionKinds,
        approved: transitionApproved,
      });
      if (!transitionApproved) {
        failures.push({
          code: "TRANSITION_APPROVAL_REQUIRED",
          reason: `Transition requires approval: ${transitionKinds.filter((kind) => !approved.has(kind)).join(", ")}`,
        });
      }
    }

    if (failures.length > 0) {
      rejected.push({
        candidateId: candidate.id,
        codes: failures.map((failure) => failure.code),
        reasons: failures.map((failure) => failure.reason),
      });
    } else {
      eligible.push(candidate);
    }
  }

  const preferenceRank = new Map(
    policy.preferenceOrder.map((id, index) => [id, index]),
  );
  eligible.sort((left, right) => {
    const leftRank = preferenceRank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = preferenceRank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.id.localeCompare(right.id);
  });
  rejected.sort((left, right) =>
    left.candidateId.localeCompare(right.candidateId),
  );
  transitions.sort((left, right) =>
    left.toCandidateId.localeCompare(right.toCandidateId),
  );

  const selected = selectFromEligible(eligible, policy, admitted);
  const decision: ExecutionRouteDecision = {
    id: `${policy.id}:${policy.requestId}`,
    policyId: policy.id,
    requestId: policy.requestId,
    eligibleCandidateIds: eligible.map((candidate) => candidate.id),
    rejected,
    selectedCandidateId: selected?.id ?? null,
    fallbackCandidateIds:
      policy.fallback === "ordered-compatible"
        ? eligible
            .filter((candidate) => candidate.id !== selected?.id)
            .map((candidate) => candidate.id)
        : [],
    transitions,
    strategy: policy.strategy,
    reasoningSummary: selected
      ? `${strategyLabel(policy.strategy)} selected ${selected.id}; ${rejected.length} candidate(s) rejected`
      : `${strategyLabel(policy.strategy)} found no eligible candidate; ${rejected.length} candidate(s) rejected`,
    decidedAt: options.decidedAt,
  };
  return { decision, admitted };
}

/**
 * Inputs the admitted policy contributed to the pick.
 *
 * Admission resolves the seeded inputs once and hands them to the draw as a
 * discriminated union, so a seeded strategy cannot reach the draw without its
 * seed and cannot silently degrade to ordered selection.
 */
type AdmittedRouteSelection =
  | { readonly kind: "ordered" }
  | {
      readonly kind: "weighted";
      readonly seed: string;
      readonly weights: ReadonlyMap<string, number>;
    }
  | {
      readonly kind: "hash";
      readonly seed: string;
      readonly routingKey: string;
    }
  | {
      readonly kind: "round-robin";
      /** Receipt-carried cursor; null means first selection. */
      readonly cursor: string | null;
    };

function selectFromEligible(
  eligible: readonly ExecutionRouteCandidate[],
  policy: ExecutionRoutePolicy,
  admitted: AdmittedRouteSelection,
): ExecutionRouteCandidate | undefined {
  switch (admitted.kind) {
    case "weighted":
      return drawWeightedCandidate(
        eligible,
        admitted.weights,
        admitted.seed,
        policy,
      );
    case "hash":
      return drawHashCandidate(eligible, admitted.seed, admitted.routingKey);
    case "round-robin":
      return drawRoundRobinCandidate(eligible, admitted.cursor);
    case "ordered":
      return eligible[0];
  }
}

export const ROUTE_SELECTION_RECEIPT_SCHEMA =
  "dzupagent.agentAdapters.routeSelectionReceipt/v1";

/**
 * Replayable record of one decision plus every input the pick consumed.
 *
 * Weights are recorded as id-ordered pairs rather than an object so the
 * serialized receipt is byte-stable regardless of candidate input order.
 */
export interface RouteSelectionReceipt {
  readonly schema: typeof ROUTE_SELECTION_RECEIPT_SCHEMA;
  readonly decision: ExecutionRouteDecision;
  /** Seed consumed by the pick; null for strategies that consume none. */
  readonly seed: string | null;
  /** Hash routing key consumed by the pick; null outside the hash strategy. */
  readonly routingKey: string | null;
  /** Admitted candidate weights in candidate-id order; null outside weighted. */
  readonly candidateWeights: readonly (readonly [string, number])[] | null;
  /**
   * Round-robin cursor the pick consumed: the previous decision's selected
   * candidate id, or null for the first selection. Null outside round-robin.
   * The *next* cursor is this receipt's `decision.selectedCandidateId`.
   */
  readonly roundRobinCursor: string | null;
}

/** Decides a route and records the seeded inputs the decision actually used. */
export function selectExecutionRouteWithReceipt(
  policy: ExecutionRoutePolicy,
  options: DeterministicRouteSelectionOptions,
): RouteSelectionReceipt {
  const { decision, admitted } = decideExecutionRoute(policy, options);
  return {
    schema: ROUTE_SELECTION_RECEIPT_SCHEMA,
    decision,
    seed:
      admitted.kind === "weighted" || admitted.kind === "hash"
        ? admitted.seed
        : null,
    routingKey: admitted.kind === "hash" ? admitted.routingKey : null,
    candidateWeights:
      admitted.kind === "weighted"
        ? [...admitted.weights].sort((left, right) =>
            left[0].localeCompare(right[0]),
          )
        : null,
    roundRobinCursor: admitted.kind === "round-robin" ? admitted.cursor : null,
  };
}

/**
 * Re-decides a route from a receipt alone.
 *
 * The receipt carries the timestamp, the seed and the routing key, so replay
 * needs no ambient input; a differing result means the selector stopped being a
 * pure function of its recorded inputs.
 */
export function replayRouteSelectionReceipt(
  policy: ExecutionRoutePolicy,
  receipt: RouteSelectionReceipt,
): RouteSelectionReceipt {
  return selectExecutionRouteWithReceipt(policy, {
    decidedAt: receipt.decision.decidedAt,
    ...(receipt.seed === null ? {} : { seed: receipt.seed }),
    ...(receipt.routingKey === null ? {} : { routingKey: receipt.routingKey }),
    ...(typeof receipt.roundRobinCursor === "string"
      ? { roundRobinCursor: receipt.roundRobinCursor }
      : {}),
  });
}

export function classifyRouteTransition(
  from: ExecutionRouteCandidate,
  to: ExecutionRouteCandidate,
): ExecutionRouteTransitionKind[] {
  const kinds: ExecutionRouteTransitionKind[] = [];
  if (from.accessClass === "subscription" && to.accessClass === "api")
    kinds.push("subscription-to-api");
  if (from.locality === "local" && to.locality === "remote")
    kinds.push("local-to-remote");
  if (
    from.provider !== to.provider ||
    from.agentHost !== to.agentHost ||
    from.profileRef !== to.profileRef ||
    from.authSourceRef !== to.authSourceRef
  )
    kinds.push("identity-change");
  if (privacyRank(to.privacyClass) > privacyRank(from.privacyClass))
    kinds.push("privacy-downgrade");
  if (costRank(to.costClass) > costRank(from.costClass))
    kinds.push("higher-cost");
  return kinds;
}

type CandidateFailure = { code: ExecutionRouteRejectionCode; reason: string };

function evaluateCandidate(
  candidate: ExecutionRouteCandidate,
  policy: ExecutionRoutePolicy,
): CandidateFailure[] {
  const failures: CandidateFailure[] = [];
  const requirements = policy.requirements;
  if (candidate.backendAvailable === false)
    failure(failures, "BACKEND_UNAVAILABLE", "Backend is unavailable");
  if (candidate.authAvailable === false)
    failure(
      failures,
      "AUTH_SOURCE_UNAVAILABLE",
      "Authentication source is unavailable",
    );
  if (candidate.modelAvailable === false)
    failure(failures, "MODEL_UNAVAILABLE", "Model is unavailable");
  if (candidate.policyCompatible === false)
    failure(
      failures,
      "POLICY_INCOMPATIBLE",
      "Candidate is incompatible with policy",
    );
  if (candidate.health?.status === "unhealthy")
    failure(
      failures,
      "HEALTH_CHECK_FAILED",
      candidate.health.reason ?? "Health check failed",
    );
  if (requirements?.requireHealthy && candidate.health?.status !== "healthy") {
    failure(
      failures,
      "HEALTH_CHECK_FAILED",
      `Healthy candidate required; observed ${candidate.health?.status ?? "unknown"}`,
    );
  }
  if (
    requirements?.providers &&
    !includes(requirements.providers, candidate.provider)
  ) {
    failure(
      failures,
      "PROVIDER_UNAVAILABLE",
      "Provider is outside the allowed set",
    );
  }
  if (
    requirements?.backends &&
    (!candidate.backend || !requirements.backends.includes(candidate.backend))
  ) {
    failure(
      failures,
      "BACKEND_UNAVAILABLE",
      "Backend is outside the allowed set",
    );
  }
  if (
    requirements?.agentHosts &&
    !includes(requirements.agentHosts, candidate.agentHost)
  ) {
    failure(
      failures,
      "POLICY_INCOMPATIBLE",
      "Agent host is outside the allowed set",
    );
  }
  if (requirements?.models && !includes(requirements.models, candidate.model)) {
    failure(failures, "MODEL_UNAVAILABLE", "Model is outside the allowed set");
  }
  if (
    requirements?.profileRefs &&
    !includes(requirements.profileRefs, candidate.profileRef)
  ) {
    failure(
      failures,
      "POLICY_INCOMPATIBLE",
      "Profile is outside the allowed set",
    );
  }
  if (
    requirements?.authSourceRefs &&
    !includes(requirements.authSourceRefs, candidate.authSourceRef)
  ) {
    failure(
      failures,
      "AUTH_SOURCE_UNAVAILABLE",
      "Authentication source is outside the allowed set",
    );
  }
  for (const capability of requirements?.capabilities ?? []) {
    if (!(candidate.capabilities ?? []).includes(capability)) {
      failure(
        failures,
        "CAPABILITY_MISSING",
        `Missing capability: ${capability}`,
      );
    }
  }
  if (
    requirements?.maximumCostClass &&
    costRank(candidate.costClass) > COST_RANK[requirements.maximumCostClass]
  ) {
    failure(
      failures,
      "COST_LIMIT_EXCEEDED",
      `Cost class ${candidate.costClass ?? "unknown"} exceeds limit ${requirements.maximumCostClass}`,
    );
  }
  if (
    requirements?.minimumPrivacyClass &&
    privacyRank(candidate.privacyClass) >
      PRIVACY_RANK[requirements.minimumPrivacyClass]
  ) {
    failure(
      failures,
      "PRIVACY_INCOMPATIBLE",
      `Privacy class ${candidate.privacyClass ?? "unknown"} is weaker than ${requirements.minimumPrivacyClass}`,
    );
  }

  for (const constraint of policy.hardConstraints) {
    if (
      constraint.kind === "provider" &&
      !includes(constraint.values, candidate.provider)
    ) {
      failure(
        failures,
        "PROVIDER_UNAVAILABLE",
        "Provider hard constraint failed",
      );
    } else if (constraint.kind === "tags") {
      for (const tag of constraint.values) {
        if (!(candidate.tags ?? []).includes(tag))
          failure(failures, "POLICY_INCOMPATIBLE", `Missing tag: ${tag}`);
      }
    } else if (constraint.kind === "capability") {
      for (const capability of constraint.values) {
        if (!(candidate.capabilities ?? []).includes(capability))
          failure(
            failures,
            "CAPABILITY_MISSING",
            `Missing capability: ${capability}`,
          );
      }
    } else if (
      constraint.kind === "policy" &&
      candidate.policyCompatible !== true
    ) {
      failure(failures, "POLICY_INCOMPATIBLE", "Policy hard constraint failed");
    }
  }
  return deduplicateFailures(failures);
}

function assertRoutePolicyAdmission(
  policy: ExecutionRoutePolicy,
  options: DeterministicRouteSelectionOptions,
): AdmittedRouteSelection {
  if (!isImplementedStrategy(policy.strategy)) {
    throw new DeterministicRouteSelectionAdmissionError(
      "UNSUPPORTED_ROUTE_STRATEGY",
      `Route strategy "${policy.strategy}" is not implemented by the deterministic selector; supported strategies: ${IMPLEMENTED_DETERMINISTIC_ROUTE_STRATEGIES.join(", ")}`,
    );
  }

  const candidateIds = new Set<string>();
  for (const candidate of policy.candidates) {
    if (candidateIds.has(candidate.id)) {
      throw new DeterministicRouteSelectionAdmissionError(
        "DUPLICATE_ROUTE_CANDIDATE",
        `Duplicate route candidate: ${candidate.id}`,
      );
    }
    candidateIds.add(candidate.id);
  }

  if (policy.strategy === "fixed" && policy.candidates.length !== 1) {
    throw new DeterministicRouteSelectionAdmissionError(
      "FIXED_STRATEGY_REQUIRES_SINGLE_CANDIDATE",
      `Fixed route strategy requires exactly one candidate; received ${policy.candidates.length}`,
    );
  }

  if (policy.strategy === "weighted") {
    return {
      kind: "weighted",
      seed: admit(requireSeed("weighted", options.seed)),
      weights: admit(readPolicyCandidateWeights(policy)),
    };
  }

  if (policy.strategy === "hash") {
    return {
      kind: "hash",
      seed: admit(requireSeed("hash", options.seed)),
      routingKey: admit(requireRoutingKey(options.routingKey)),
    };
  }

  if (policy.strategy === "round-robin") {
    return {
      kind: "round-robin",
      cursor: admit(requireRoundRobinCursor(policy, options.roundRobinCursor)),
    };
  }

  return { kind: "ordered" };
}

/**
 * Typed-failure shape shared by every strategy guard feeding admission.
 * Structurally satisfied by both the seeded and the round-robin guard results.
 */
type AdmissionGuardResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly failure: {
        readonly code: DeterministicRouteSelectionAdmissionCode;
        readonly message: string;
      };
    };

/** Raises a strategy guard failure as the selector's admission error. */
function admit<T>(result: AdmissionGuardResult<T>): T {
  if (!result.ok) {
    throw new DeterministicRouteSelectionAdmissionError(
      result.failure.code,
      result.failure.message,
    );
  }
  return result.value;
}

function isImplementedStrategy(
  strategy: ExecutionRoutePolicy["strategy"],
): strategy is ImplementedDeterministicRouteStrategy {
  return (
    IMPLEMENTED_DETERMINISTIC_ROUTE_STRATEGIES as readonly string[]
  ).includes(strategy);
}

/** Total map: implementing a new strategy must name it here or fail to compile. */
const STRATEGY_LABELS: Record<ExecutionRoutePolicy["strategy"], string> = {
  fixed: "Fixed route",
  hash: "Seeded hash route",
  "llm-rank": "LLM rank",
  "round-robin": "Round robin",
  rule: "Ordered rule",
  weighted: "Seeded weighted route",
};

function strategyLabel(strategy: ExecutionRoutePolicy["strategy"]): string {
  return STRATEGY_LABELS[strategy];
}

function includes(
  values: readonly string[],
  value: string | undefined,
): boolean {
  return value !== undefined && values.includes(value);
}

function failure(
  failures: CandidateFailure[],
  code: ExecutionRouteRejectionCode,
  reason: string,
): void {
  failures.push({ code, reason });
}

function deduplicateFailures(failures: CandidateFailure[]): CandidateFailure[] {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    const key = failure.code;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function costRank(value: ExecutionRouteCostClass | undefined): number {
  return value === undefined ? Number.MAX_SAFE_INTEGER : COST_RANK[value];
}

function privacyRank(value: ExecutionRoutePrivacyClass | undefined): number {
  return value === undefined ? Number.MAX_SAFE_INTEGER : PRIVACY_RANK[value];
}

export type CandidateRecoveryAction =
  | { kind: "retry-same-candidate"; candidateId: string; nextAttempt: number }
  | { kind: "fallback-candidate"; candidateId: string }
  | { kind: "stop"; code: string };

export interface CandidateRecoveryInput {
  candidateId: string;
  failureCode: string;
  recoverable: boolean;
  attempt: number;
  maxSameCandidateRetries: number;
  compatibleFallbackCandidateIds: readonly string[];
}

/** Same-candidate retry is always decided before cross-candidate fallback. */
export function planCandidateRecovery(
  input: CandidateRecoveryInput,
): CandidateRecoveryAction {
  if (NON_RECOVERABLE_CODES.has(input.failureCode) || !input.recoverable) {
    return { kind: "stop", code: input.failureCode };
  }
  if (input.attempt <= input.maxSameCandidateRetries) {
    return {
      kind: "retry-same-candidate",
      candidateId: input.candidateId,
      nextAttempt: input.attempt + 1,
    };
  }
  const fallback = input.compatibleFallbackCandidateIds[0];
  return fallback
    ? { kind: "fallback-candidate", candidateId: fallback }
    : { kind: "stop", code: "NO_COMPATIBLE_FALLBACK" };
}

const NON_RECOVERABLE_CODES = new Set([
  "AGENT_ABORTED",
  "CAPABILITY_DENIED",
  "POLICY_DENIED",
  "POLICY_INCOMPATIBLE",
  "AUTH_SOURCE_UNAVAILABLE",
  "INVALID_AUTH",
]);
