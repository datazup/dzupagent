import { canonicalDigestPrefixed } from '@dzupagent/canonical-json'
import type { ExecutionRoutePolicy } from '@dzupagent/runtime-contracts'
import {
  AI_EXECUTION_BINDING_SCHEMA,
  validateAiExecutionBinding,
} from '@dzupagent/runtime-contracts/ai-execution'
import type { AiExecutionBinding } from '@dzupagent/runtime-contracts/ai-execution'
import {
  materializeAiExecutionBinding,
  materializeAiRouteDecisionBinding,
  validateAiExecutionBindingDigest,
  validateAiExecutionOfferSnapshotDigest,
} from '@dzupagent/runtime-contracts/ai-execution/node'

import { selectExecutionRouteWithReceipt } from './deterministic-candidate-selector.js'
import { admitExecutionRoutePolicy } from './route-policy-admission.js'
import type {
  QualifiedTaskRoutingOffer,
  SelectedTaskRoute,
  TaskComplexityProfile,
  TaskRouteIdentity,
  TaskRoutingDecision,
  TaskRoutingRequest,
} from './complexity-routing-types.js'

const COMPLEXITY = ['C0', 'C1', 'C2', 'C3'] as const
const HIGH_EFFORT = 3
const REQUIRED_CAPABILITY = {
  implementation: 'coding/v1',
  architecture: 'architecture/v1',
  security: 'security-review/v1',
  review: 'code-review/v1',
} as const

export class TaskRoutingError extends Error {
  constructor(
    readonly code: 'TASK_ROUTING_INVALID' | 'TASK_ROUTING_NO_OFFER' | 'TASK_ROUTING_NO_REVIEWER' | 'TASK_ROUTING_DECISION_MISMATCH' | 'TASK_ROUTING_BINDING_MISMATCH',
    message: string,
    readonly evidence?: unknown,
  ) {
    super(message)
    this.name = 'TaskRoutingError'
  }
}

/** Compile task policy into the existing deterministic selector, with no effects. */
export function selectTaskExecutionRoute(input: TaskRoutingRequest): TaskRoutingDecision {
  const request = structuredClone(input)
  validateRequest(request)
  return selectAdmittedTaskRoute(request)
}

function selectAdmittedTaskRoute(input: TaskRoutingRequest): TaskRoutingDecision {
  const request = {
    ...input,
    offers: [...input.offers].sort((a, b) => compare(a.offer.offerId, b.offer.offerId)),
  }
  const requiredCapabilities = capabilities(request.task)
  const eligibility: Array<TaskRoutingDecision['eligibility'][number]> = []
  const requiresReview = request.task.complexity === 'C3' && request.task.kind !== 'review'
  const reviewable = requiresReview ? new Set(request.offers.filter((offer) =>
    selectRole(request, 'reviewer', identity(offer), [], undefined,
      request.task.maximumCostMicros - offer.estimatedCostMicros) !== undefined,
  ).map((offer) => offer.offer.offerId)) : undefined
  if (reviewable?.size === 0) {
    throw new TaskRoutingError('TASK_ROUTING_NO_REVIEWER', 'C3 requires an eligible independent reviewer.', freeze({ request }))
  }
  const primary = selectRole(request, 'primary', request.implementer, eligibility, reviewable)
  if (!primary) {
    throw new TaskRoutingError('TASK_ROUTING_NO_OFFER', 'No qualified task offer satisfies the admitted policy.', freeze({ request, eligibility }))
  }
  const reviewer = requiresReview
    ? selectRole(request, 'reviewer', identity(primary.offer), eligibility, undefined,
      request.task.maximumCostMicros - primary.offer.estimatedCostMicros)
    : undefined
  if (requiresReview && !reviewer) {
    throw new TaskRoutingError('TASK_ROUTING_NO_REVIEWER', 'C3 requires an eligible independent reviewer.', freeze({ request, primary, eligibility }))
  }
  const reviewPolicy = {
    required: requiresReview,
    preferDifferentProviderFamily: requiresReview || request.task.kind === 'review',
    ...(request.implementer ? { implementer: request.implementer } : {}),
    ...(reviewer ? { reviewer: identity(reviewer.offer) } : {}),
  }
  const decision = {
    schema: 'dzupagent.taskRoutingDecision/v1' as const,
    request,
    requiredCapabilities,
    eligibility,
    primary,
    ...(reviewer ? { reviewer } : {}),
    reviewPolicy,
  }
  return freeze({ ...decision, decisionDigest: digest(decision) })
}

/** Recompute all eligibility, ordering, effort and review evidence before use. */
export function replayTaskRoutingDecision(decision: TaskRoutingDecision): TaskRoutingDecision {
  const replay = selectTaskExecutionRoute(decision.request)
  if (digest(replay) !== digest(decision)) {
    throw new TaskRoutingError('TASK_ROUTING_DECISION_MISMATCH', 'Retained task routing decision does not replay.')
  }
  return replay
}

/** Attach policy context to the existing execution binding; never bind a different offer. */
export function bindTaskExecutionRoute(
  decision: TaskRoutingDecision,
  context: Pick<AiExecutionBinding, 'target' | 'prompt' | 'persona'>,
  role: 'primary' | 'reviewer' = 'primary',
): AiExecutionBinding {
  const recorded = replayTaskRoutingDecision(decision)
  const primary = role === 'reviewer' ? recorded.reviewer : recorded.primary
  if (!primary) throw new TaskRoutingError('TASK_ROUTING_BINDING_MISMATCH', 'No reviewer was selected for this decision.')
  const selectedCandidateId = primary.receipt.decision.selectedCandidateId
  if (!selectedCandidateId) throw new TaskRoutingError('TASK_ROUTING_BINDING_MISMATCH', 'Selected route is missing.')
  const binding = materializeAiExecutionBinding({
    schema: AI_EXECUTION_BINDING_SCHEMA,
    ...structuredClone(context),
    offer: primary.offer.offer,
    model: primary.offer.offer.model,
    routeDecision: materializeAiRouteDecisionBinding({ ...primary.receipt.decision, selectedCandidateId }),
    taskRouting: {
      decisionDigest: recorded.decisionDigest,
      policyRevision: recorded.request.policyRevision,
      complexity: recorded.request.task.complexity,
      effort: primary.effort,
      role: recorded.request.task.kind === 'review' ? 'reviewer' : role,
      reviewPolicy: role === 'reviewer' ? {
        required: false,
        preferDifferentProviderFamily: true,
        implementer: identity(recorded.primary.offer),
      } : recorded.reviewPolicy,
    },
  })
  if (binding.target.policyRevision !== recorded.request.policyRevision ||
    binding.target.profileRef !== primary.offer.offer.profileRef ||
    binding.target.provider !== primary.offer.offer.provider ||
    binding.target.model !== primary.offer.offer.model.providerModelId ||
    !validateAiExecutionBinding(binding).valid || !validateAiExecutionBindingDigest(binding).valid) {
    throw new TaskRoutingError('TASK_ROUTING_BINDING_MISMATCH', 'Execution target does not match the recorded task route.')
  }
  return freeze(binding)
}

/** Predispatch guard: even a rehashed binding must match its retained decision. */
export function assertTaskExecutionBinding(
  decision: TaskRoutingDecision,
  binding: AiExecutionBinding,
): void {
  const role = decision.request.task.kind === 'review' ? 'primary' : binding.taskRouting?.role
  if (!role) throw new TaskRoutingError('TASK_ROUTING_BINDING_MISMATCH', 'Task routing context is missing.')
  const expected = bindTaskExecutionRoute(decision, {
    target: binding.target, prompt: binding.prompt, persona: binding.persona,
  }, role)
  if (digest(expected) !== digest(binding)) {
    throw new TaskRoutingError('TASK_ROUTING_BINDING_MISMATCH', 'Execution binding differs from the retained task decision.')
  }
}

function selectRole(
  request: TaskRoutingRequest,
  role: 'primary' | 'reviewer',
  implementer: TaskRouteIdentity | undefined,
  evidence: Array<TaskRoutingDecision['eligibility'][number]>,
  reviewable?: ReadonlySet<string>,
  reviewCostLimit?: number,
): SelectedTaskRoute | undefined {
  const task = role === 'reviewer' ? {
    ...request.task, kind: 'review' as const,
    maximumCostMicros: reviewCostLimit ?? request.task.maximumCostMicros,
  } : request.task
  const needed = capabilities(task)
  const candidates = request.offers.map((item) => {
    const reasons = rejectionReasons(item, task, request.decidedAt, implementer)
    if (reviewable && !reviewable.has(item.offer.offerId)) reasons.push('INDEPENDENT_REVIEW_UNAVAILABLE')
    evidence.push({ offerId: item.offer.offerId, role, reasons })
    return {
      id: item.offer.offerId,
      provider: item.offer.provider,
      backend: item.offer.backend,
      ...(item.offer.authMode ? { authMode: item.offer.authMode } : {}),
      ...(item.offer.agentHost ? { agentHost: item.offer.agentHost } : {}),
      model: item.offer.model.providerModelId,
      profileRef: item.offer.profileRef,
      authAvailable: item.authAvailable,
      backendAvailable: item.backendAvailable,
      modelAvailable: item.modelAvailable,
      health: item.offer.health,
      privacyClass: item.offer.privacyClass,
      locality: item.offer.locality,
      costClass: item.costClass,
      capabilities: item.offer.capabilities,
      policyCompatible: reasons.length === 0,
    }
  })
  const preferences = [...request.offers].sort((a, b) => {
    const familyRank = (offer: QualifiedTaskRoutingOffer) => implementer && offer.providerFamily === implementer.providerFamily ? 1 : 0
    return familyRank(a) - familyRank(b) ||
      a.estimatedCostMicros - b.estimatedCostMicros ||
      a.estimatedLatencyMs - b.estimatedLatencyMs || compare(a.offer.offerId, b.offer.offerId)
  })
  const policy: ExecutionRoutePolicy = admitExecutionRoutePolicy({
    ...request.policy,
    id: role === 'reviewer' ? `${request.policy.id}:review` : request.policy.id,
    requestId: role === 'reviewer' ? `${request.policy.requestId}:review` : request.policy.requestId,
    strategy: 'rule',
    candidates,
    preferenceOrder: preferences.map((item) => item.offer.offerId),
    requirements: {
      ...request.policy.requirements,
      capabilities: [...new Set([...(request.policy.requirements?.capabilities ?? []), ...needed])].sort(),
      requireHealthy: true,
    },
  })
  const receipt = selectExecutionRouteWithReceipt(policy, { decidedAt: request.decidedAt })
  // Retain the selector's host-constraint/transition rejections as well.
  for (const rejected of receipt.decision.rejected) {
    evidence.push({ offerId: rejected.candidateId, role, reasons: rejected.codes ?? rejected.reasons })
  }
  const offer = request.offers.find((item) => item.offer.offerId === receipt.decision.selectedCandidateId)
  if (!offer) return undefined
  const effort = chooseEffort(offer, task)
  if (!effort) return undefined
  return { offer, effort, policy, receipt }
}

function rejectionReasons(
  item: QualifiedTaskRoutingOffer,
  task: TaskComplexityProfile,
  decidedAt: string,
  implementer: TaskRouteIdentity | undefined,
): string[] {
  const reasons: string[] = []
  const now = Date.parse(decidedAt)
  if (!validateAiExecutionOfferSnapshotDigest(item.offer).valid) reasons.push('OFFER_DIGEST_INVALID')
  if (Date.parse(item.offer.effectiveAt) > now ||
    (item.offer.expiresAt && Date.parse(item.offer.expiresAt) <= now)) reasons.push('OFFER_NOT_CURRENT')
  if (item.offer.health.status !== 'healthy' || !item.offer.health.checkedAt ||
    Date.parse(item.offer.health.checkedAt) > now) reasons.push('HEALTH_NOT_QUALIFIED')
  if (COMPLEXITY.indexOf(item.qualification.maximumComplexity) < COMPLEXITY.indexOf(task.complexity)) reasons.push('COMPLEXITY_NOT_QUALIFIED')
  if (COMPLEXITY.indexOf(task.complexity) >= 2 && item.qualification.coding !== 'strong') reasons.push('STRONG_CODING_REQUIRED')
  if (!capabilities(task).every((capability) => item.offer.capabilities.includes(capability))) reasons.push('CAPABILITY_MISSING')
  if (!chooseEffort(item, task)) reasons.push('EFFORT_UNSUPPORTED')
  if (item.contextWindowTokens < task.contextTokens + task.outputTokens ||
    item.maximumOutputTokens < task.outputTokens) reasons.push('CONTEXT_INSUFFICIENT')
  if (item.estimatedCostMicros > task.maximumCostMicros) reasons.push('COST_LIMIT_EXCEEDED')
  if (!item.quota.available || item.quota.remainingTokens < task.contextTokens + task.outputTokens) reasons.push('QUOTA_INSUFFICIENT')
  if (implementer && !independent(item, implementer)) reasons.push('REVIEWER_NOT_INDEPENDENT')
  return reasons
}

function chooseEffort(item: QualifiedTaskRoutingOffer, task: TaskComplexityProfile): string | undefined {
  const efforts = [...item.efforts].sort((a, b) => a.level - b.level || compare(a.name, b.name))
  if (task.complexity === 'C3') return efforts.at(-1)?.name
  if (task.complexity === 'C2') return efforts.find((effort) => effort.level >= HIGH_EFFORT)?.name
  return efforts[0]?.name
}

function capabilities(task: TaskComplexityProfile): string[] {
  return [...new Set([...task.requiredCapabilities, REQUIRED_CAPABILITY[task.kind]])].sort()
}

function identity(item: QualifiedTaskRoutingOffer): TaskRouteIdentity {
  return {
    provider: item.offer.provider,
    providerFamily: item.providerFamily,
    modelRef: item.offer.model.modelRef,
    providerModelId: item.offer.model.providerModelId!,
  }
}

function independent(item: QualifiedTaskRoutingOffer, other: TaskRouteIdentity): boolean {
  return item.offer.model.modelRef !== other.modelRef &&
    (item.offer.provider !== other.provider || item.offer.model.providerModelId !== other.providerModelId)
}

function validateRequest(request: TaskRoutingRequest): void {
  const invalid = (condition: boolean, message: string) => {
    if (condition) throw new TaskRoutingError('TASK_ROUTING_INVALID', message)
  }
  const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  const amount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  const date = (value: unknown): value is string => text(value) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
  invalid(!request || request.schema !== 'dzupagent.taskRoutingRequest/v1' || !request.task || !request.policy, 'Invalid task routing request.')
  const task = request.task
  invalid(!text(request.policyRevision) || !date(request.decidedAt), 'Policy revision and decision time are required.')
  invalid(!text(task.taskId) || !text(task.assessmentRef) || !COMPLEXITY.includes(task.complexity) ||
    !Object.hasOwn(REQUIRED_CAPABILITY, task.kind), 'Invalid task complexity assessment.')
  invalid((task.kind === 'architecture' || task.kind === 'security') && task.complexity !== 'C3', 'Architecture and security tasks require C3.')
  invalid(!Array.isArray(task.requiredCapabilities) || !task.requiredCapabilities.every(text), 'Capabilities must be explicit strings.')
  invalid(!amount(task.contextTokens) || !amount(task.outputTokens) || !amount(task.maximumCostMicros) ||
    !amount(task.contextTokens + task.outputTokens), 'Task context and budget must be non-negative safe integers.')
  invalid(task.kind === 'review' && !request.implementer, 'Review requires implementer identity.')
  invalid(task.kind !== 'review' && request.implementer !== undefined, 'Implementer identity belongs only to review requests.')
  if (request.implementer) invalid(!Object.values(request.implementer).every(text) ||
    !['provider', 'providerFamily', 'modelRef', 'providerModelId'].every((key) => Object.hasOwn(request.implementer!, key)), 'Incomplete implementer identity.')
  invalid(!Array.isArray(request.offers) || request.offers.length === 0 || request.offers.length > 500, 'A bounded offer catalog is required.')
  const ids = new Set<string>()
  for (const item of request.offers) {
    invalid(!item?.offer?.model || !item.qualification || !item.quota || !item.offer.health, 'Incomplete offer evidence.')
    const offer = item.offer
    invalid(offer.schema !== 'dzupagent.aiExecutionOffer/v1' || !text(offer.offerRevision) ||
      !text(offer.model.revision) || !/^sha256:[a-f0-9]{64}$/.test(offer.model.catalogDigest) ||
      !/^sha256:[a-f0-9]{64}$/.test(offer.catalogDigest), 'Offer revision and catalog identity are required.')
    invalid(!text(offer.offerId) || ids.has(offer.offerId), 'Offer identities must be unique.')
    ids.add(offer.offerId)
    invalid(!text(offer.profileRef) || !text(offer.provider) || !text(offer.model.providerModelId) ||
      !text(offer.model.modelRef) || !text(item.providerFamily), 'Offer must pin provider, model, family and profile.')
    invalid(!text(item.qualification.evidenceRef) || !COMPLEXITY.includes(item.qualification.maximumComplexity) ||
      !['fast', 'strong'].includes(item.qualification.coding), 'Offer qualification evidence is required.')
    invalid(!date(offer.effectiveAt) || (offer.expiresAt !== undefined && !date(offer.expiresAt)) ||
      (offer.health.checkedAt !== undefined && !date(offer.health.checkedAt)), 'Invalid offer observation time.')
    invalid(offer.expiresAt !== undefined && Date.parse(offer.expiresAt) <= Date.parse(offer.effectiveAt), 'Offer expiry must follow its effective time.')
    invalid(!['none', 'provider', 'host', 'unknown'].includes(offer.cacheBehavior) ||
      !['stateless', 'stateful', 'unknown'].includes(offer.sessionBehavior) ||
      !['free', 'low', 'medium', 'high'].includes(item.costClass), 'Offer runtime and cost classes must be explicit.')
    invalid(!Array.isArray(offer.capabilities) || !offer.capabilities.every(text), 'Invalid offer capabilities.')
    invalid(![item.contextWindowTokens, item.maximumOutputTokens, item.estimatedCostMicros,
      item.estimatedLatencyMs, item.quota.remainingTokens].every(amount), 'Offer capacity, cost and latency must be known non-negative integers.')
    invalid(!text(item.quota.evidenceRef) || ![item.quota.available, item.authAvailable, item.backendAvailable, item.modelAvailable].every((v) => typeof v === 'boolean'), 'Offer availability and quota evidence are required.')
    invalid(!Array.isArray(item.efforts) || item.efforts.length === 0 || item.efforts.length > 32 ||
      !item.efforts.every((e) => e && text(e.name) && amount(e.level) && e.level > 0), 'Supported effort mappings are required.')
    invalid(new Set(item.efforts.map((e) => e.name)).size !== item.efforts.length ||
      new Set(item.efforts.map((e) => e.level)).size !== item.efforts.length, 'Effort mappings must have unique names and levels.')
  }
  invalid(request.policy.requestId !== task.taskId, 'Policy request identity must equal task identity.')
  invalid(request.policy.originCandidateId !== undefined && !ids.has(request.policy.originCandidateId), 'Transition origin must be present in the offer catalog.')
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
function digest(value: unknown): `sha256:${string}` { return canonicalDigestPrefixed(value, 'idempotency-v1') }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
