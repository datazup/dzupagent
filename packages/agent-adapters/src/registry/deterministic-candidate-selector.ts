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
} from '@dzupagent/runtime-contracts'
import {
  assertDeterministicRoutePolicyAdmission,
  DeterministicRouteSelectionAdmissionError,
} from './route-policy-admission.js'
import type {
  DeterministicRouteSelectionOptions,
} from './route-policy-admission.js'

export {
  DeterministicRouteSelectionAdmissionError,
  IMPLEMENTED_DETERMINISTIC_ROUTE_STRATEGIES,
} from './route-policy-admission.js'
export type {
  DeterministicRouteSelectionAdmissionCode,
  DeterministicRouteSelectionOptions,
} from './route-policy-admission.js'

const COST_RANK: Record<ExecutionRouteCostClass, number> = {
  free: 0,
  low: 1,
  medium: 2,
  high: 3,
}

const PRIVACY_RANK: Record<ExecutionRoutePrivacyClass, number> = {
  device: 0,
  'private-network': 1,
  provider: 2,
  public: 3,
}

export const ROUTE_SELECTION_RECEIPT_SCHEMA =
  'dzupagent.agentAdapters.routeSelectionReceipt/v1' as const

export interface RouteSelectionCandidateWeight {
  readonly candidateId: string
  readonly weight: number
}

/** Replay input and the exact decision it produced. No ambient selector state is used. */
export interface RouteSelectionReceipt {
  readonly schema: typeof ROUTE_SELECTION_RECEIPT_SCHEMA
  readonly decision: ExecutionRouteDecision
  readonly seed: string | null
  readonly routingKey: string | null
  readonly candidateWeights: readonly RouteSelectionCandidateWeight[]
  readonly roundRobinCursor: string | null
}

export type RouteSelectionReceiptReplayCode =
  | 'ROUTE_SELECTION_RECEIPT_SCHEMA_UNSUPPORTED'
  | 'ROUTE_SELECTION_RECEIPT_POLICY_MISMATCH'
  | 'ROUTE_SELECTION_RECEIPT_WEIGHT_MISMATCH'
  | 'ROUTE_SELECTION_RECEIPT_DECISION_MISMATCH'

/** Fail-closed replay error for a receipt that does not reproduce under the supplied policy. */
export class RouteSelectionReceiptReplayError extends Error {
  readonly code: RouteSelectionReceiptReplayCode

  constructor(code: RouteSelectionReceiptReplayCode, message: string) {
    super(message)
    this.name = 'RouteSelectionReceiptReplayError'
    this.code = code
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
 * The broader route-policy vocabulary is intentionally not treated as
 * metadata: strategies without an implementation fail before selection.
 */
export function selectExecutionRoute(
  policy: ExecutionRoutePolicy,
  options: DeterministicRouteSelectionOptions,
): ExecutionRouteDecision {
  assertDeterministicRoutePolicyAdmission(policy, options)
  if (policy.strategy === 'weighted') routeSelectionCandidateWeights(policy.candidates)
  const candidates = [...policy.candidates]
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
  const origin = policy.originCandidateId ? byId.get(policy.originCandidateId) : undefined
  const approved = new Set(policy.approvedTransitions ?? [])
  const rejected: ExecutionRouteRejection[] = []
  const transitions: ExecutionRouteTransitionDecision[] = []
  const eligible: ExecutionRouteCandidate[] = []

  for (const candidate of candidates) {
    const failures = evaluateCandidate(candidate, policy)
    const transitionKinds = origin && origin.id !== candidate.id
      ? classifyRouteTransition(origin, candidate)
      : []
    if (origin && origin.id !== candidate.id) {
      const transitionApproved = transitionKinds.every((kind) => approved.has(kind))
      transitions.push({
        fromCandidateId: origin.id,
        toCandidateId: candidate.id,
        kinds: transitionKinds,
        approved: transitionApproved,
      })
      if (!transitionApproved) {
        failures.push({
          code: 'TRANSITION_APPROVAL_REQUIRED',
          reason: `Transition requires approval: ${transitionKinds.filter((kind) => !approved.has(kind)).join(', ')}`,
        })
      }
    }

    if (failures.length > 0) {
      rejected.push({
        candidateId: candidate.id,
        codes: failures.map((failure) => failure.code),
        reasons: failures.map((failure) => failure.reason),
      })
    } else {
      eligible.push(candidate)
    }
  }

  const orderedEligible = orderEligibleRouteCandidates(eligible, policy, options)
  rejected.sort((left, right) => left.candidateId.localeCompare(right.candidateId))
  transitions.sort((left, right) => left.toCandidateId.localeCompare(right.toCandidateId))

  const selected = orderedEligible[0]
  return {
    id: `${policy.id}:${policy.requestId}`,
    policyId: policy.id,
    requestId: policy.requestId,
    eligibleCandidateIds: orderedEligible.map((candidate) => candidate.id),
    rejected,
    selectedCandidateId: selected?.id ?? null,
    fallbackCandidateIds: policy.fallback === 'ordered-compatible'
      ? orderedEligible.slice(1).map((candidate) => candidate.id)
      : [],
    transitions,
    strategy: policy.strategy,
    reasoningSummary: selected
      ? `${strategyLabel(policy.strategy)} selected ${selected.id}; ${rejected.length} candidate(s) rejected`
      : `${strategyLabel(policy.strategy)} found no eligible candidate; ${rejected.length} candidate(s) rejected`,
    decidedAt: options.decidedAt,
  }
}

export function classifyRouteTransition(
  from: ExecutionRouteCandidate,
  to: ExecutionRouteCandidate,
): ExecutionRouteTransitionKind[] {
  const kinds: ExecutionRouteTransitionKind[] = []
  if (from.accessClass === 'subscription' && to.accessClass === 'api') kinds.push('subscription-to-api')
  if (from.locality === 'local' && to.locality === 'remote') kinds.push('local-to-remote')
  if (
    from.provider !== to.provider ||
    from.agentHost !== to.agentHost ||
    from.profileRef !== to.profileRef ||
    from.authSourceRef !== to.authSourceRef
  ) kinds.push('identity-change')
  if (privacyRank(to.privacyClass) > privacyRank(from.privacyClass)) kinds.push('privacy-downgrade')
  if (costRank(to.costClass) > costRank(from.costClass)) kinds.push('higher-cost')
  return kinds
}

type CandidateFailure = { code: ExecutionRouteRejectionCode; reason: string }

function evaluateCandidate(
  candidate: ExecutionRouteCandidate,
  policy: ExecutionRoutePolicy,
): CandidateFailure[] {
  const failures: CandidateFailure[] = []
  const requirements = policy.requirements
  if (candidate.backendAvailable === false) failure(failures, 'BACKEND_UNAVAILABLE', 'Backend is unavailable')
  if (candidate.authAvailable === false) failure(failures, 'AUTH_SOURCE_UNAVAILABLE', 'Authentication source is unavailable')
  if (candidate.modelAvailable === false) failure(failures, 'MODEL_UNAVAILABLE', 'Model is unavailable')
  if (candidate.policyCompatible === false) failure(failures, 'POLICY_INCOMPATIBLE', 'Candidate is incompatible with policy')
  if (candidate.health?.status === 'unhealthy') failure(failures, 'HEALTH_CHECK_FAILED', candidate.health.reason ?? 'Health check failed')
  if (requirements?.requireHealthy && candidate.health?.status !== 'healthy') {
    failure(failures, 'HEALTH_CHECK_FAILED', `Healthy candidate required; observed ${candidate.health?.status ?? 'unknown'}`)
  }
  if (requirements?.providers && !includes(requirements.providers, candidate.provider)) {
    failure(failures, 'PROVIDER_UNAVAILABLE', 'Provider is outside the allowed set')
  }
  if (requirements?.backends && (!candidate.backend || !requirements.backends.includes(candidate.backend))) {
    failure(failures, 'BACKEND_UNAVAILABLE', 'Backend is outside the allowed set')
  }
  if (requirements?.agentHosts && !includes(requirements.agentHosts, candidate.agentHost)) {
    failure(failures, 'POLICY_INCOMPATIBLE', 'Agent host is outside the allowed set')
  }
  if (requirements?.models && !includes(requirements.models, candidate.model)) {
    failure(failures, 'MODEL_UNAVAILABLE', 'Model is outside the allowed set')
  }
  if (requirements?.profileRefs && !includes(requirements.profileRefs, candidate.profileRef)) {
    failure(failures, 'POLICY_INCOMPATIBLE', 'Profile is outside the allowed set')
  }
  if (requirements?.authSourceRefs && !includes(requirements.authSourceRefs, candidate.authSourceRef)) {
    failure(failures, 'AUTH_SOURCE_UNAVAILABLE', 'Authentication source is outside the allowed set')
  }
  for (const capability of requirements?.capabilities ?? []) {
    if (!(candidate.capabilities ?? []).includes(capability)) {
      failure(failures, 'CAPABILITY_MISSING', `Missing capability: ${capability}`)
    }
  }
  if (requirements?.maximumCostClass && costRank(candidate.costClass) > COST_RANK[requirements.maximumCostClass]) {
    failure(failures, 'COST_LIMIT_EXCEEDED', `Cost class ${candidate.costClass ?? 'unknown'} exceeds limit ${requirements.maximumCostClass}`)
  }
  if (requirements?.minimumPrivacyClass && privacyRank(candidate.privacyClass) > PRIVACY_RANK[requirements.minimumPrivacyClass]) {
    failure(failures, 'PRIVACY_INCOMPATIBLE', `Privacy class ${candidate.privacyClass ?? 'unknown'} is weaker than ${requirements.minimumPrivacyClass}`)
  }

  for (const constraint of policy.hardConstraints) {
    if (constraint.kind === 'provider' && !includes(constraint.values, candidate.provider)) {
      failure(failures, 'PROVIDER_UNAVAILABLE', 'Provider hard constraint failed')
    } else if (constraint.kind === 'tags') {
      for (const tag of constraint.values) {
        if (!(candidate.tags ?? []).includes(tag)) failure(failures, 'POLICY_INCOMPATIBLE', `Missing tag: ${tag}`)
      }
    } else if (constraint.kind === 'capability') {
      for (const capability of constraint.values) {
        if (!(candidate.capabilities ?? []).includes(capability)) failure(failures, 'CAPABILITY_MISSING', `Missing capability: ${capability}`)
      }
    } else if (constraint.kind === 'policy' && candidate.policyCompatible !== true) {
      failure(failures, 'POLICY_INCOMPATIBLE', 'Policy hard constraint failed')
    }
  }
  return deduplicateFailures(failures)
}

function orderEligibleRouteCandidates(
  eligible: readonly ExecutionRouteCandidate[],
  policy: ExecutionRoutePolicy,
  options: DeterministicRouteSelectionOptions,
): ExecutionRouteCandidate[] {
  const candidates = [...eligible]
  if (policy.strategy === 'rule' || policy.strategy === 'fixed') {
    const preferenceRank = new Map(policy.preferenceOrder.map((id, index) => [id, index]))
    return candidates.sort((left, right) => {
      const leftRank = preferenceRank.get(left.id) ?? Number.MAX_SAFE_INTEGER
      const rightRank = preferenceRank.get(right.id) ?? Number.MAX_SAFE_INTEGER
      return leftRank - rightRank || left.id.localeCompare(right.id)
    })
  }
  if (policy.strategy === 'weighted') {
    const weights = new Map(routeSelectionCandidateWeights(policy.candidates)
      .map((item) => [item.candidateId, item.weight]))
    const seed = options.seed as string
    return candidates.sort((left, right) => {
      const leftScore = weightedScore(left.id, seed, weights.get(left.id) as number)
      const rightScore = weightedScore(right.id, seed, weights.get(right.id) as number)
      return leftScore - rightScore || left.id.localeCompare(right.id)
    })
  }
  if (policy.strategy === 'hash') {
    const seed = options.seed as string
    const routingKey = options.routingKey as string
    return candidates.sort((left, right) => {
      const leftScore = fnv1a32(`${left.id}|${seed}|${routingKey}`)
      const rightScore = fnv1a32(`${right.id}|${seed}|${routingKey}`)
      return rightScore - leftScore || left.id.localeCompare(right.id)
    })
  }

  candidates.sort((left, right) => left.id.localeCompare(right.id))
  const cursor = options.roundRobinCursor
  if (cursor === undefined || candidates.length < 2) return candidates
  const successor = candidates.findIndex((candidate) => candidate.id.localeCompare(cursor) > 0)
  const pivot = successor === -1 ? 0 : successor
  return [...candidates.slice(pivot), ...candidates.slice(0, pivot)]
}

function routeSelectionCandidateWeights(
  candidates: readonly ExecutionRouteCandidate[],
): RouteSelectionCandidateWeight[] {
  const result = [...candidates]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((candidate) => {
      const weightTags = (candidate.tags ?? []).filter((tag) => tag.startsWith('route-weight:'))
      if (weightTags.length === 0) {
        throw new DeterministicRouteSelectionAdmissionError(
          'WEIGHTED_STRATEGY_REQUIRES_CANDIDATE_WEIGHT',
          `Weighted route candidate requires exactly one route-weight tag: ${candidate.id}`,
        )
      }
      if (weightTags.length !== 1) {
        throw new DeterministicRouteSelectionAdmissionError(
          'WEIGHTED_STRATEGY_INVALID_CANDIDATE_WEIGHT',
          `Weighted route candidate has multiple route-weight tags: ${candidate.id}`,
        )
      }
      const encoded = weightTags[0]?.slice('route-weight:'.length) ?? ''
      if (!/^[1-9][0-9]*$/.test(encoded)) {
        throw new DeterministicRouteSelectionAdmissionError(
          'WEIGHTED_STRATEGY_INVALID_CANDIDATE_WEIGHT',
          `Weighted route candidate has an invalid positive integer weight: ${candidate.id}`,
        )
      }
      const weight = Number(encoded)
      if (!Number.isSafeInteger(weight) || weight <= 0) {
        throw new DeterministicRouteSelectionAdmissionError(
          'WEIGHTED_STRATEGY_INVALID_CANDIDATE_WEIGHT',
          `Weighted route candidate weight is outside the safe integer range: ${candidate.id}`,
        )
      }
      return { candidateId: candidate.id, weight }
    })
  const total = result.reduce((sum, item) => sum + item.weight, 0)
  if (!Number.isSafeInteger(total) || total <= 0) {
    throw new DeterministicRouteSelectionAdmissionError(
      'WEIGHTED_STRATEGY_REQUIRES_POSITIVE_WEIGHT_SUM',
      'Weighted route candidate weights must have a positive safe-integer sum',
    )
  }
  return result
}

function weightedScore(candidateId: string, seed: string, weight: number): number {
  const unit = (fnv1a32(`${candidateId}|${seed}|weighted`) + 1) / 4_294_967_297
  return -Math.log(unit) / weight
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5
  for (const byte of Buffer.from(value, 'utf8')) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

function strategyLabel(strategy: ExecutionRoutePolicy['strategy']): string {
  switch (strategy) {
    case 'fixed': return 'Fixed route'
    case 'rule': return 'Ordered rule'
    case 'weighted': return 'Seeded weighted route'
    case 'hash': return 'Rendezvous hash route'
    case 'round-robin': return 'Receipt round-robin route'
    case 'llm-rank': return 'LLM-ranked route'
  }
}

function includes(values: readonly string[], value: string | undefined): boolean {
  return value !== undefined && values.includes(value)
}

function failure(failures: CandidateFailure[], code: ExecutionRouteRejectionCode, reason: string): void {
  failures.push({ code, reason })
}

function deduplicateFailures(failures: CandidateFailure[]): CandidateFailure[] {
  const seen = new Set<string>()
  return failures.filter((failure) => {
    const key = failure.code
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function costRank(value: ExecutionRouteCostClass | undefined): number {
  return value === undefined ? Number.MAX_SAFE_INTEGER : COST_RANK[value]
}

function privacyRank(value: ExecutionRoutePrivacyClass | undefined): number {
  return value === undefined ? Number.MAX_SAFE_INTEGER : PRIVACY_RANK[value]
}

/** Select and bind every strategy input needed for deterministic replay. */
export function createRouteSelectionReceipt(
  policy: ExecutionRoutePolicy,
  options: DeterministicRouteSelectionOptions,
): RouteSelectionReceipt {
  const decision = selectExecutionRoute(policy, options)
  return {
    schema: ROUTE_SELECTION_RECEIPT_SCHEMA,
    decision,
    seed: policy.strategy === 'weighted' || policy.strategy === 'hash'
      ? options.seed ?? null
      : null,
    routingKey: policy.strategy === 'hash' ? options.routingKey ?? null : null,
    candidateWeights: policy.strategy === 'weighted'
      ? routeSelectionCandidateWeights(policy.candidates)
      : [],
    roundRobinCursor: policy.strategy === 'round-robin' ? options.roundRobinCursor ?? null : null,
  }
}

/** Re-select from recorded inputs and reject any policy, weight, or decision drift. */
export function replayRouteSelectionReceipt(
  policy: ExecutionRoutePolicy,
  receipt: RouteSelectionReceipt,
): ExecutionRouteDecision {
  if (receipt.schema !== ROUTE_SELECTION_RECEIPT_SCHEMA) {
    throw new RouteSelectionReceiptReplayError(
      'ROUTE_SELECTION_RECEIPT_SCHEMA_UNSUPPORTED',
      `Unsupported route-selection receipt schema: ${String(receipt.schema)}`,
    )
  }
  if (receipt.decision.policyId !== policy.id || receipt.decision.requestId !== policy.requestId) {
    throw new RouteSelectionReceiptReplayError(
      'ROUTE_SELECTION_RECEIPT_POLICY_MISMATCH',
      'Route-selection receipt does not belong to the supplied policy and request',
    )
  }
  const expectedWeights = policy.strategy === 'weighted'
    ? routeSelectionCandidateWeights(policy.candidates)
    : []
  if (JSON.stringify(receipt.candidateWeights) !== JSON.stringify(expectedWeights)) {
    throw new RouteSelectionReceiptReplayError(
      'ROUTE_SELECTION_RECEIPT_WEIGHT_MISMATCH',
      'Route-selection receipt candidate weights do not match the supplied policy',
    )
  }

  const replayed = selectExecutionRoute(policy, {
    decidedAt: receipt.decision.decidedAt,
    ...(receipt.seed === null ? {} : { seed: receipt.seed }),
    ...(receipt.routingKey === null ? {} : { routingKey: receipt.routingKey }),
    ...(receipt.roundRobinCursor === null ? {} : { roundRobinCursor: receipt.roundRobinCursor }),
  })
  if (JSON.stringify(replayed) !== JSON.stringify(receipt.decision)) {
    throw new RouteSelectionReceiptReplayError(
      'ROUTE_SELECTION_RECEIPT_DECISION_MISMATCH',
      'Route-selection receipt decision does not reproduce from its recorded inputs',
    )
  }
  return replayed
}

export type CandidateRecoveryAction =
  | { kind: 'retry-same-candidate'; candidateId: string; nextAttempt: number }
  | { kind: 'fallback-candidate'; candidateId: string }
  | { kind: 'stop'; code: string }

export interface CandidateRecoveryInput {
  candidateId: string
  failureCode: string
  recoverable: boolean
  attempt: number
  maxSameCandidateRetries: number
  compatibleFallbackCandidateIds: readonly string[]
}

/** Same-candidate retry is always decided before cross-candidate fallback. */
export function planCandidateRecovery(input: CandidateRecoveryInput): CandidateRecoveryAction {
  if (NON_RECOVERABLE_CODES.has(input.failureCode) || !input.recoverable) {
    return { kind: 'stop', code: input.failureCode }
  }
  if (input.attempt <= input.maxSameCandidateRetries) {
    return { kind: 'retry-same-candidate', candidateId: input.candidateId, nextAttempt: input.attempt + 1 }
  }
  const fallback = input.compatibleFallbackCandidateIds[0]
  return fallback
    ? { kind: 'fallback-candidate', candidateId: fallback }
    : { kind: 'stop', code: 'NO_COMPATIBLE_FALLBACK' }
}

const NON_RECOVERABLE_CODES = new Set([
  'AGENT_ABORTED',
  'CAPABILITY_DENIED',
  'POLICY_DENIED',
  'POLICY_INCOMPATIBLE',
  'AUTH_SOURCE_UNAVAILABLE',
  'INVALID_AUTH',
])
