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

export interface DeterministicRouteSelectionOptions {
  /** Host-supplied timestamp keeps selection deterministic and replayable. */
  decidedAt: string
}

/** Pure candidate selector. Input order never decides ties. */
export function selectExecutionRoute(
  policy: ExecutionRoutePolicy,
  options: DeterministicRouteSelectionOptions,
): ExecutionRouteDecision {
  const unique = uniqueCandidates(policy.candidates)
  const byId = new Map(unique.map((candidate) => [candidate.id, candidate]))
  const origin = policy.originCandidateId ? byId.get(policy.originCandidateId) : undefined
  const approved = new Set(policy.approvedTransitions ?? [])
  const rejected: ExecutionRouteRejection[] = []
  const transitions: ExecutionRouteTransitionDecision[] = []
  const eligible: ExecutionRouteCandidate[] = []

  for (const candidate of unique) {
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

  const preferenceRank = new Map(policy.preferenceOrder.map((id, index) => [id, index]))
  eligible.sort((left, right) => {
    const leftRank = preferenceRank.get(left.id) ?? Number.MAX_SAFE_INTEGER
    const rightRank = preferenceRank.get(right.id) ?? Number.MAX_SAFE_INTEGER
    return leftRank - rightRank || left.id.localeCompare(right.id)
  })
  rejected.sort((left, right) => left.candidateId.localeCompare(right.candidateId))
  transitions.sort((left, right) => left.toCandidateId.localeCompare(right.toCandidateId))

  const selected = eligible[0]
  return {
    id: `${policy.id}:${policy.requestId}`,
    policyId: policy.id,
    requestId: policy.requestId,
    eligibleCandidateIds: eligible.map((candidate) => candidate.id),
    rejected,
    selectedCandidateId: selected?.id ?? null,
    fallbackCandidateIds: policy.fallback === 'ordered-compatible'
      ? eligible.slice(1).map((candidate) => candidate.id)
      : [],
    transitions,
    strategy: policy.strategy,
    reasoningSummary: selected
      ? `Selected ${selected.id}; ${rejected.length} candidate(s) rejected`
      : `No eligible candidate; ${rejected.length} candidate(s) rejected`,
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

function uniqueCandidates(candidates: readonly ExecutionRouteCandidate[]): ExecutionRouteCandidate[] {
  const byId = new Map<string, ExecutionRouteCandidate>()
  for (const candidate of candidates) if (!byId.has(candidate.id)) byId.set(candidate.id, candidate)
  return [...byId.values()]
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
