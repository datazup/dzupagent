import { canonicalDigestPrefixed } from '@dzupagent/canonical-json'
import { validateRoutingObservation, EXECUTION_OFFER_ROUTING_SCHEMA } from '@dzupagent/runtime-contracts'
import type {
  ExecutionOfferOperations, ExecutionOfferRoutingPolicy, ExecutionTaskAssignment,
  ExecutionOfferRanking, RoutingObservation, RoutingCapacity,
  ExecutionOfferReservationPort, ExecutionOfferHandoff,
} from '@dzupagent/runtime-contracts'
import { reserveAiBudget } from '@dzupagent/runtime-contracts/ai-budget-reservation'
import type { AiBudgetReservationRequest } from '@dzupagent/runtime-contracts/ai-budget-reservation'
import type { AiExecutionBinding } from '@dzupagent/runtime-contracts/ai-execution'
import {
  materializeAiExecutionBinding, materializeAiRouteDecisionBinding,
  validateAiExecutionBindingDigest,
} from '@dzupagent/runtime-contracts/ai-execution/node'
import { selectTaskExecutionRoute, TaskRoutingError } from './complexity-routing.js'
import type { TaskRoutingRequest, TaskRoutingDecision, QualifiedTaskRoutingOffer } from './complexity-routing-types.js'
import { selectExecutionRouteWithReceipt, replayRouteSelectionReceipt, planCandidateRecovery } from './deterministic-candidate-selector.js'
import type { RouteSelectionReceipt } from './deterministic-candidate-selector.js'

export const DEFAULT_EXECUTION_OFFER_WEIGHTS = Object.freeze({ quality: .35, completion: .30, continuity: .15, cost: .10, fairness: .10 })

export interface ExecutionOfferRoutingRequest {
  readonly schema: typeof EXECUTION_OFFER_ROUTING_SCHEMA
  readonly qualification: TaskRoutingRequest
  readonly operations: readonly ExecutionOfferOperations[]
  readonly policy: ExecutionOfferRoutingPolicy
  readonly assignment: ExecutionTaskAssignment
  readonly localPrincipal: string
  readonly localHost: string
  readonly environmentRef: string
  readonly remainingBudgetMicros: number
  /** Missing pricing is unknown, never a zero-cost route. */
  readonly budgets: Readonly<Record<string, AiBudgetReservationRequest>>
  readonly urgency?: { readonly deadline: string; readonly exceptionRef: string }
  readonly assessment?: ExecutionOfferAssessmentProposal
}

export interface ExecutionOfferAssessmentProposal {
  readonly schema: 'dzupagent.executionOfferAssessment/v1'
  readonly action: 'select' | 'wait' | 'needs_evidence'
  readonly policyRevision: string
  readonly inputDigest: string
  readonly offerId?: string
  readonly rationale: string
}

export interface ExecutionOfferRoutingDecision {
  readonly schema: typeof EXECUTION_OFFER_ROUTING_SCHEMA
  readonly request: ExecutionOfferRoutingRequest
  readonly inputDigest: `sha256:${string}`
  readonly observationDigest: `sha256:${string}`
  readonly decisionDigest: `sha256:${string}`
  readonly action: 'select' | 'wait' | 'retain' | 'reconcile'
  readonly reasons: readonly string[]
  readonly eligibility: readonly { readonly offerId: string; readonly reasons: readonly string[] }[]
  readonly ranked: readonly ExecutionOfferRanking[]
  readonly selectedOfferId?: string
  readonly reviewerOfferId?: string
  readonly receipt?: RouteSelectionReceipt
  readonly qualification?: TaskRoutingDecision
  readonly reviewerQualification?: TaskRoutingDecision
}

export class ExecutionOfferRoutingError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ExecutionOfferRoutingError' }
}
const fail = (code: string): never => { throw new ExecutionOfferRoutingError(code) }
export const digestExecutionOfferRouting = (value: unknown): `sha256:${string}` => canonicalDigestPrefixed(value, 'idempotency-v1')
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim()
const integer = (v: number) => Number.isSafeInteger(v) && v >= 0
const date = (v: string) => /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
function freeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.values(v).forEach(freeze); Object.freeze(v) }
  return v
}

/** Pure, replayable admission. No provider call, queue, lease or Git effect. */
export function routeExecutionOffers(input: ExecutionOfferRoutingRequest): ExecutionOfferRoutingDecision {
  const request = structuredClone(input)
  const { qualification: q, policy, assignment } = request
  if (!q || !policy || !assignment || request.schema !== EXECUTION_OFFER_ROUTING_SCHEMA ||
      !text(policy.revision) || policy.revision !== q.policyRevision ||
      !integer(policy.maxObservationAgeMs) || policy.maxObservationAgeMs === 0 ||
      !Number.isFinite(policy.minimumConfidence) || policy.minimumConfidence < 0 || policy.minimumConfidence > 1 ||
      !Number.isFinite(policy.maximumCompletionMs) || policy.maximumCompletionMs <= 0 ||
      !integer(request.remainingBudgetMicros) || !text(request.environmentRef) ||
      !text(request.localPrincipal) || !text(request.localHost) || !integer(assignment.generation) ||
      assignment.taskId !== q.task?.taskId || !text(assignment.stage) || !text(assignment.ownerOfferId) ||
      !text(assignment.sourceRef) || !text(assignment.recoveryRef) || !date(q.decidedAt) ||
      !['queued', 'checkpointed', 'running', 'unknown-dispatch', 'partial-writes'].includes(assignment.state)) fail('ROUTING_REQUEST_INVALID')
  if (!policy.weights || Object.keys(policy.weights).sort().join() !== 'completion,continuity,cost,fairness,quality' ||
      Object.values(policy.weights).some(w => !Number.isFinite(w) || w < 0) ||
      Math.abs(Object.values(policy.weights).reduce((a, b) => a + b, 0) - 1) > 1e-9) fail('ROUTING_WEIGHTS_INVALID')
  if (policy.preferredLocal && !Object.values(policy.preferredLocal).every(text)) fail('ROUTING_PREFERENCE_INVALID')
  if (request.urgency && (!date(request.urgency.deadline) || !text(request.urgency.exceptionRef))) fail('ROUTING_URGENCY_INVALID')
  if (!Array.isArray(q.offers) || q.offers.length < 1 || q.offers.length > 500 ||
      !Array.isArray(request.operations) || request.operations.length !== q.offers.length) fail('ROUTING_OFFER_SET_INVALID')
  const ops = new Map(request.operations.map(o => [o.offerId, o]))
  if (ops.size !== q.offers.length || q.offers.some(o => !ops.has(o.offer.offerId))) fail('ROUTING_OFFER_SET_INVALID')
  const shared = new Map<string, string>()
  const costs = new Map<string, number>()
  const eligibility = [...q.offers].sort((a, b) => compare(a.offer.offerId, b.offer.offerId)).map(item => {
    const id = item.offer.offerId, o = ops.get(id)!
    if (![o.principal, o.account, o.host, o.quotaPool, o.authorityRef].every(text) ||
        typeof o.allowed !== 'boolean' || !Array.isArray(o.stages) || !o.stages.every(text) ||
        o.quotaPool !== item.quota.poolRef) fail('ROUTING_IDENTITY_INVALID')
    const reasons: string[] = []
    if (!o.allowed) reasons.push('AUTHORITY_DENIED')
    if (!o.stages.includes(assignment.stage)) reasons.push('STAGE_UNSUPPORTED')
    for (const [key, capacity] of [
      [`principal:${o.principal}`, o.principalCapacity], [`account:${o.account}`, o.accountCapacity], [`host:${o.host}`, o.hostCapacity],
    ] as const) {
      if (!capacity || Object.keys(capacity).sort().join() !== 'limit,queued,reserved,reviewHeadroom,running') fail('ROUTING_CAPACITY_INVALID')
      consistent(shared, key, capacity)
      const counts = Object.entries(capacity).map(([name, metric]) => metricValue(metric, 'slots', q.decidedAt, policy, reasons, `${key}:${name}`))
      if (counts.every(v => v !== undefined)) {
        const { running, queued, reserved, limit, reviewHeadroom } = capacity
        const val = (m: RoutingObservation) => m.state === 'known' ? m.value : 0
        if (val(running) + val(queued) + val(reserved) + val(reviewHeadroom) + 1 > val(limit)) reasons.push(`CAPACITY_EXHAUSTED:${key}`)
      }
    }
    consistent(shared, `pool:${o.quotaPool}`, { quota: o.quota, qualified: item.quota, recovery: o.recovery ?? null })
    const remaining = metricValue(o.quota.remaining, 'tokens', q.decidedAt, policy, reasons, 'quota.remaining')
    const committed = metricValue(o.quota.committed, 'tokens', q.decidedAt, policy, reasons, 'quota.committed')
    const review = metricValue(o.quota.reviewHeadroom, 'tokens', q.decidedAt, policy, reasons, 'quota.reviewHeadroom')
    if (remaining !== undefined && remaining !== item.quota.remainingTokens) fail('ROUTING_QUOTA_CONTRADICTION')
    if (remaining !== undefined && committed !== undefined && review !== undefined && remaining - committed - review < q.task.contextTokens + q.task.outputTokens) reasons.push('QUOTA_COMMITTED_OR_RESERVED')
    for (const name of ['quality', 'continuity', 'fairness'] as const) metricValue(o[name], 'score', q.decidedAt, policy, reasons, name)
    for (const name of ['queue', 'execution', 'transfer', 'validation', 'review'] as const) metricValue(o.completion[name], 'ms', q.decidedAt, policy, reasons, `completion.${name}`)
    if (o.recovery) {
      if (!date(o.recovery.restoredAt) || Date.parse(o.recovery.restoredAt) > Date.parse(q.decidedAt)) fail('ROUTING_RECOVERY_INVALID')
      const admitted = metricValue(o.recovery.admitted, 'slots', q.decidedAt, policy, reasons, 'recovery.admitted')
      const limit = metricValue(o.recovery.limit, 'slots', q.decidedAt, policy, reasons, 'recovery.limit')
      if (admitted !== undefined && limit !== undefined && admitted >= limit) reasons.push('RECOVERY_RAMP_EXHAUSTED')
    }
    const budget = request.budgets?.[id]
    if (!budget) reasons.push('COST_EVIDENCE_REQUIRED')
    else {
      const price = reserveAiBudget({ ...budget, reservedAt: q.decidedAt })
      if (price.status !== 'admitted') reasons.push(`BUDGET_${price.reason}`)
      else if (price.offerRef !== id || price.modelRef !== item.offer.model.modelRef || price.modelRevision !== item.offer.model.revision ||
          budget.usageCeiling.uncachedInputTokens < q.task.contextTokens || budget.usageCeiling.outputTokens < q.task.outputTokens) reasons.push('BUDGET_IDENTITY_OR_USAGE_MISMATCH')
      else {
        costs.set(id, price.reservedAmountMicros)
        if (price.reservedAmountMicros > request.remainingBudgetMicros || price.reservedAmountMicros > item.estimatedCostMicros) reasons.push('BUDGET_INSUFFICIENT')
      }
    }
    return { offerId: id, reasons }
  })
  const observations = { operations: request.operations, offers: q.offers, budgets: request.budgets,
    assignment, environmentRef: request.environmentRef, remainingBudgetMicros: request.remainingBudgetMicros }
  const base = { schema: EXECUTION_OFFER_ROUTING_SCHEMA, request, inputDigest: digestExecutionOfferRouting(request),
    observationDigest: digestExecutionOfferRouting(observations), eligibility }
  const finish = (rest: Omit<ExecutionOfferRoutingDecision, keyof typeof base | 'decisionDigest'>): ExecutionOfferRoutingDecision => {
    const result = { ...base, ...rest }
    return freeze({ ...result, decisionDigest: digestExecutionOfferRouting(result) })
  }
  if (assignment.state === 'running') return finish({ action: 'retain', reasons: ['PRODUCTIVE_OWNER_RETAINED'], ranked: [] })
  if (['unknown-dispatch', 'partial-writes'].includes(assignment.state)) return finish({ action: 'reconcile', reasons: ['SOURCE_RECONCILIATION_REQUIRED'], ranked: [] })
  const qualifiedRequest: TaskRoutingRequest = { ...q, maxObservationAgeMs: Math.min(q.maxObservationAgeMs, policy.maxObservationAgeMs),
    offers: q.offers.map(o => ({ ...o, backendAvailable: o.backendAvailable && eligibility.find(e => e.offerId === o.offer.offerId)!.reasons.length === 0 })) }
  let qualified: TaskRoutingDecision
  try { qualified = selectTaskExecutionRoute(qualifiedRequest) }
  catch (error) {
    if (!(error instanceof TaskRoutingError) || error.code === 'TASK_ROUTING_INVALID') throw error
    for (const e of eligibility) e.reasons.push(error.code)
    return finish({ action: 'wait', reasons: [error.code], ranked: [] })
  }
  for (const e of eligibility) for (const reason of qualified.eligibility.filter(v => v.offerId === e.offerId && v.role === 'primary').flatMap(v => v.reasons)) {
    if (!e.reasons.includes(reason)) e.reasons.push(reason)
  }
  const ranked: ExecutionOfferRanking[] = []
  const reviewers = new Map<string, TaskRoutingDecision>()
  for (const item of q.offers) {
    const id = item.offer.offerId, e = eligibility.find(v => v.offerId === id)!, o = ops.get(id)!
    if (e.reasons.length) continue
    if (qualified.reviewPolicy.required) {
      const reviewer = findReviewer(qualifiedRequest, item, request, ops, costs)
      if (!reviewer) { e.reasons.push('OPERATIONAL_REVIEW_HEADROOM_REQUIRED'); continue }
      reviewers.set(id, reviewer)
    }
    const val = (m: RoutingObservation) => m.state === 'known' ? m.value : fail('ROUTING_UNKNOWN_METRIC')
    const completionMs = Object.values(o.completion).reduce((sum, m) => sum + val(m), 0)
    const effort = [...item.efforts].sort((a, b) => a.level - b.level || compare(a.name, b.name))
    const nativeEffort = q.task.complexity === 'C3' ? effort.at(-1)!.name : q.task.complexity === 'C2' ? effort.find(e => e.level >= 3)!.name : effort[0]!.name
    const preferred = policy.preferredLocal
    const localPreference = !!preferred && o.principal === request.localPrincipal && o.host === request.localHost &&
      item.offer.locality === 'local' && item.offer.provider === preferred.provider && item.offer.model.providerModelId === preferred.model && nativeEffort === preferred.effort
    const cost = costs.get(id)!, weights = policy.weights
    const score = weights.quality * val(o.quality) + weights.completion * Math.max(0, 1 - completionMs / policy.maximumCompletionMs) +
      weights.continuity * val(o.continuity) + weights.cost * Math.max(0, 1 - cost / Math.max(1, q.task.maximumCostMicros)) + weights.fairness * val(o.fairness)
    ranked.push({ offerId: id, score, completionMs, reservedCostMicros: cost, effort: nativeEffort, localPreference })
  }
  ranked.sort((a, b) => {
    const urgent = request.urgency && Date.parse(q.decidedAt) + Math.min(a.completionMs, b.completionMs) <= Date.parse(request.urgency.deadline)
    if (urgent) {
      const fits = (r: ExecutionOfferRanking) => Date.parse(q.decidedAt) + r.completionMs <= Date.parse(request.urgency!.deadline)
      if (fits(a) !== fits(b)) return fits(a) ? -1 : 1
    }
    return Number(b.localPreference) - Number(a.localPreference) || b.score - a.score || compare(a.offerId, b.offerId)
  })
  if (!ranked.length) return finish({ action: 'wait', reasons: ['NO_OPERATIONAL_OFFER'], ranked, qualification: qualified })
  if (request.assessment) {
    const { assessment, ...unassessed } = request
    if (assessment.schema !== 'dzupagent.executionOfferAssessment/v1' ||
        !['select', 'wait', 'needs_evidence'].includes(assessment.action) ||
        assessment.policyRevision !== policy.revision || assessment.inputDigest !== digestExecutionOfferRouting(unassessed) ||
        !text(assessment.rationale) || assessment.rationale.length > 2000 ||
        Object.keys(assessment).some(k => !['schema', 'action', 'policyRevision', 'inputDigest', 'offerId', 'rationale'].includes(k))) fail('ROUTING_ASSESSMENT_INVALID')
    if (assessment.action !== 'select') {
      if (assessment.offerId !== undefined) fail('ROUTING_ASSESSMENT_INVALID')
      return finish({ action: 'wait', reasons: [`ASSESSMENT_${assessment.action.toUpperCase()}`], ranked, qualification: qualified })
    }
    const index = ranked.findIndex(r => r.offerId === assessment.offerId)
    if (index < 0 || (ranked[0]!.localPreference && !ranked[index]!.localPreference) ||
        (request.urgency && Date.parse(q.decidedAt) + ranked[0]!.completionMs <= Date.parse(request.urgency.deadline) && Date.parse(q.decidedAt) + ranked[index]!.completionMs > Date.parse(request.urgency.deadline))) fail('ROUTING_ASSESSMENT_INELIGIBLE')
    ranked.unshift(...ranked.splice(index, 1))
  }
  // Reuse the deterministic rule selector and its transition/permission checks.
  const admitted = new Set(ranked.map(r => r.offerId))
  const finalPolicy = { ...qualified.primary.policy, preferenceOrder: ranked.map(r => r.offerId),
    candidates: qualified.primary.policy.candidates.map(c => ({ ...c, policyCompatible: c.policyCompatible !== false && admitted.has(c.id) })) }
  const receipt = selectExecutionRouteWithReceipt(finalPolicy, { decidedAt: q.decidedAt })
  const selectedOfferId = receipt.decision.selectedCandidateId
  if (!selectedOfferId) return finish({ action: 'wait', reasons: ['ROUTE_SELECTOR_REFUSED'], ranked, qualification: qualified, receipt })
  const reviewer = reviewers.get(selectedOfferId)
  return finish({ action: 'select', reasons: ['HARD_GATES_PASSED', ...(ranked[0]!.localPreference ? ['QUALIFIED_LOCAL_PREFERENCE'] : []), ...(request.urgency ? [`DEADLINE_EXCEPTION:${request.urgency.exceptionRef}`] : [])], ranked,
    selectedOfferId, ...(reviewer ? { reviewerOfferId: reviewer.primary.offer.offer.offerId, reviewerQualification: reviewer } : {}), receipt, qualification: qualified })
}

function consistent(shared: Map<string, string>, key: string, v: unknown) {
  const digest = digestExecutionOfferRouting(v)
  if (shared.has(key) && shared.get(key) !== digest) fail(`ROUTING_SHARED_OBSERVATION_CONTRADICTION:${key}`)
  shared.set(key, digest)
}
function metricValue(m: RoutingObservation, unit: RoutingObservation['unit'], at: string, p: ExecutionOfferRoutingPolicy, reasons: string[], label: string): number | undefined {
  if (validateRoutingObservation(m).length) fail(`ROUTING_OBSERVATION_INVALID:${label}`)
  const age = Date.parse(at) - Date.parse(m.observedAt)
  if (age < 0 || Date.parse(m.expiresAt) <= Date.parse(at) || age > p.maxObservationAgeMs) { reasons.push(`OBSERVATION_NOT_CURRENT:${label}`); return }
  if (m.state === 'unknown' || m.confidence < p.minimumConfidence || m.unit !== unit) { reasons.push(`EVIDENCE_REQUIRED:${label}`); return }
  return m.value
}
function findReviewer(q: TaskRoutingRequest, primary: QualifiedTaskRoutingOffer, request: ExecutionOfferRoutingRequest, ops: Map<string, ExecutionOfferOperations>, costs: Map<string, number>): TaskRoutingDecision | undefined {
  if (primary.estimatedCostMicros > Math.min(q.task.maximumCostMicros, request.remainingBudgetMicros)) return
  const p = ops.get(primary.offer.offerId)!
  const available = (c: RoutingCapacity) => {
    const v = (m: RoutingObservation) => m.state === 'known' ? m.value : 0
    return v(c.limit) - v(c.running) - v(c.queued) - v(c.reserved)
  }
  const tokenDemand = q.task.contextTokens + q.task.outputTokens
  try {
    return selectTaskExecutionRoute({ ...q, task: { ...q.task, kind: 'review', maximumCostMicros: Math.min(q.task.maximumCostMicros, request.remainingBudgetMicros) - primary.estimatedCostMicros },
      implementer: { provider: primary.offer.provider, providerFamily: primary.providerFamily, modelRef: primary.offer.model.modelRef, providerModelId: primary.offer.model.providerModelId! },
      offers: q.offers.map(o => {
        const v = ops.get(o.offer.offerId)!, totalCost = (costs.get(o.offer.offerId) ?? Infinity) + (costs.get(primary.offer.offerId) ?? Infinity)
        const jointSlots = [['principal', 'principalCapacity'], ['account', 'accountCapacity'], ['host', 'hostCapacity']] as const
        const slotsFit = jointSlots.every(([key, capacity]) => available(v[capacity]) >= (v[key] === p[key] ? 2 : 1))
        const remaining = v.quota.remaining.state === 'known' ? v.quota.remaining.value : 0
        const committed = v.quota.committed.state === 'known' ? v.quota.committed.value : 0
        const quotaFit = remaining - committed >= tokenDemand * (v.quotaPool === p.quotaPool ? 2 : 1)
        return { ...o, backendAvailable: o.backendAvailable && slotsFit && quotaFit && totalCost <= request.remainingBudgetMicros }
      }) })
  } catch (e) { if (!(e instanceof TaskRoutingError) || e.code === 'TASK_ROUTING_INVALID') throw e; return }
}

export function replayExecutionOfferRouting(decision: ExecutionOfferRoutingDecision): ExecutionOfferRoutingDecision {
  const replay = routeExecutionOffers(decision.request)
  if (digestExecutionOfferRouting(replay) !== digestExecutionOfferRouting(decision)) fail('ROUTING_DECISION_MISMATCH')
  if (decision.receipt) replayRouteSelectionReceipt(decision.receipt)
  return replay
}

/** Bind the selected immutable offer through the existing AI binding format. */
export function bindExecutionOfferRouting(decision: ExecutionOfferRoutingDecision, context: Pick<AiExecutionBinding, 'target' | 'prompt' | 'persona'>): AiExecutionBinding {
  replayExecutionOfferRouting(decision)
  if (decision.action !== 'select' || !decision.receipt || !decision.selectedOfferId) fail('ROUTING_NOT_SELECTED')
  const offer = decision.request.qualification.offers.find(o => o.offer.offerId === decision.selectedOfferId)!.offer
  if (context.target.provider !== offer.provider || context.target.model !== offer.model.providerModelId || context.target.profileRef !== offer.profileRef || context.target.policyRevision !== decision.request.policy.revision) fail('ROUTING_BINDING_MISMATCH')
  const binding = materializeAiExecutionBinding({ ...context, schema: 'dzupagent.aiExecutionBinding/v1', offer, model: offer.model,
    routeDecision: materializeAiRouteDecisionBinding({ ...decision.receipt.decision, selectedCandidateId: decision.selectedOfferId }) })
  if (!validateAiExecutionBindingDigest(binding).valid) fail('ROUTING_BINDING_MISMATCH')
  return binding
}

/** Destination confirmation precedes any source relinquishment. The host owns atomic persistence. */
export async function reserveExecutionOfferRouting(decision: ExecutionOfferRoutingDecision, ports: {
  readonly observe: () => Promise<ExecutionOfferRoutingRequest>
  readonly reservation: ExecutionOfferReservationPort
  readonly now: () => string
  readonly holdMs: number
}): Promise<ExecutionOfferHandoff> {
  replayExecutionOfferRouting(decision)
  if (decision.action !== 'select' || !decision.selectedOfferId || !integer(ports.holdMs) || ports.holdMs < 1 || ports.holdMs > 60000) fail('ROUTING_NOT_RESERVABLE')
  const observed = await ports.observe()
  const now = ports.now()
  if (!date(now)) fail('ROUTING_CLOCK_INVALID')
  // Refresh the baseline first; an assessment is bound to its original input, not a new clock.
  const { assessment: _assessment, ...baseline } = observed
  const fresh = routeExecutionOffers({ ...baseline, qualification: { ...observed.qualification, decidedAt: now } })
  if (fresh.action !== 'select' || fresh.selectedOfferId !== decision.selectedOfferId || fresh.reviewerOfferId !== decision.reviewerOfferId ||
      fresh.observationDigest !== decision.observationDigest || observed.assignment.generation !== decision.request.assignment.generation ||
      digestExecutionOfferRouting(observed.policy) !== digestExecutionOfferRouting(decision.request.policy)) fail('ROUTING_EVIDENCE_CHANGED')
  const a = decision.request.assignment, key = `${a.taskId}:${a.generation}:${decision.decisionDigest}`
  const hold = await ports.reservation.reserve({ key, taskId: a.taskId, expectedGeneration: a.generation,
    decisionDigest: decision.decisionDigest, observationDigest: decision.observationDigest, offerId: decision.selectedOfferId,
    ...(decision.reviewerOfferId ? { reviewerOfferId: decision.reviewerOfferId } : {}), expiresAfterMs: ports.holdMs })
  if (!hold) fail('ROUTING_RESERVATION_RACE')
  if (!text(hold.id) || hold.key !== key || hold.offerId !== decision.selectedOfferId || hold.reviewerOfferId !== decision.reviewerOfferId ||
      hold.generation !== a.generation + 1 || hold.observationDigest !== decision.observationDigest || hold.decisionDigest !== decision.decisionDigest ||
      !date(hold.expiresAt) || Date.parse(hold.expiresAt) <= Date.parse(ports.now()) || Date.parse(hold.expiresAt) > Date.parse(now) + ports.holdMs) fail('ROUTING_RESERVATION_INVALID')
  const ack = await ports.reservation.confirm(hold)
  if (!ack.accepted || !text(ack.handoffId)) fail('ROUTING_CONFIRMATION_REFUSED')
  const item = decision.request.qualification.offers.find(o => o.offer.offerId === decision.selectedOfferId)!
  return freeze({ schema: EXECUTION_OFFER_ROUTING_SCHEMA, handoffId: ack.handoffId, taskId: a.taskId, stage: a.stage,
    sourceRef: a.sourceRef, recoveryRef: a.recoveryRef, sourceDisposition: 'retain-until-destination-ack', reservation: hold,
    provider: item.offer.provider, model: item.offer.model.providerModelId!, effort: decision.ranked.find(r => r.offerId === decision.selectedOfferId)!.effort,
    policyRevision: decision.request.policy.revision, inputDigest: decision.inputDigest, decisionDigest: decision.decisionDigest,
    nextAction: 'destination-admission-required' })
}

/** Explicitly ambiguous dispatch always stops; quota failures may use a freshly admitted fallback. */
export function recoverExecutionOfferRouting(input: { candidateId: string; failureCode: string; dispatch: 'not-started' | 'unknown' | 'partial-writes'; compatibleOfferIds: readonly string[] }) {
  return planCandidateRecovery({ candidateId: input.candidateId, failureCode: input.dispatch === 'not-started' ? input.failureCode : 'RECONCILIATION_REQUIRED',
    recoverable: input.dispatch === 'not-started', attempt: 1, maxSameCandidateRetries: 0, compatibleFallbackCandidateIds: input.compatibleOfferIds })
}
