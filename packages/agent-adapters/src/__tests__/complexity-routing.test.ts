import { describe, expect, it } from 'vitest'
import {
  materializeAiExecutionBinding,
  materializeAiExecutionOfferSnapshot,
  materializeAiResolvedTargetSnapshot,
  validateAiExecutionBindingDigest,
} from '@dzupagent/runtime-contracts/ai-execution/node'

import {
  assertTaskExecutionBinding,
  bindTaskExecutionRoute,
  replayTaskRoutingDecision,
  selectTaskExecutionRoute,
  TaskRoutingError,
} from '../registry/complexity-routing.js'
import type {
  QualifiedTaskRoutingOffer,
  TaskComplexityProfile,
  TaskRoutingRequest,
} from '../registry/complexity-routing-types.js'

const at = '2026-09-09T12:00:00.000Z'
const hash = `sha256:${'a'.repeat(64)}` as const

function offer(id: string, cost = 100, family = id): QualifiedTaskRoutingOffer {
  return {
    offer: materializeAiExecutionOfferSnapshot({
      schema: 'dzupagent.aiExecutionOffer/v1',
      offerId: id,
      offerRevision: '1',
      provider: id,
      backend: 'sdk',
      profileRef: `profile/${id}`,
      model: { modelRef: `model/${id}`, revision: '1', providerModelId: id, catalogDigest: hash },
      locality: 'remote',
      privacyClass: 'provider',
      capabilities: ['coding/v1', 'code-review/v1', 'architecture/v1', 'security-review/v1'],
      cacheBehavior: 'unknown',
      sessionBehavior: 'stateless',
      health: { status: 'healthy', checkedAt: at },
      effectiveAt: at,
      expiresAt: '2026-09-10T12:00:00.000Z',
      catalogDigest: hash,
    }),
    providerFamily: family,
    qualification: { evidenceRef: `qualification/${id}`, maximumComplexity: 'C3', coding: 'strong' },
    efforts: [{ name: 'quick', level: 1 }, { name: 'careful', level: 3 }, { name: 'deepest', level: 5 }],
    contextWindowTokens: 10_000,
    maximumOutputTokens: 2_000,
    estimatedCostMicros: cost,
    costClass: 'low',
    estimatedLatencyMs: 100,
    quota: { poolRef: `quota-pool/${id}`, available: true, remainingTokens: 20_000, evidenceRef: 'quota/observed', checkedAt: at },
    authAvailable: true,
    backendAvailable: true,
    modelAvailable: true,
  }
}

function request(complexity: TaskComplexityProfile['complexity'] = 'C1'): TaskRoutingRequest {
  return {
    schema: 'dzupagent.taskRoutingRequest/v1',
    policyRevision: 'l3-policy/1',
    task: {
      taskId: 'task/1', complexity, kind: 'implementation', requiredCapabilities: [],
      contextTokens: 1000, outputTokens: 500, maximumCostMicros: 1000, assessmentRef: 'assessment/1',
    },
    offers: [offer('economy', 10), offer('strong', 100)],
    policy: { id: 'route/1', requestId: 'task/1', hardConstraints: [], fallback: 'none', maxSelectionLatencyMs: 100 },
    decidedAt: at,
    maxObservationAgeMs: 10_000,
  }
}

function replaceOfferSnapshot(
  item: QualifiedTaskRoutingOffer,
  changes: Partial<QualifiedTaskRoutingOffer['offer']>,
): QualifiedTaskRoutingOffer {
  const { snapshotDigest: _digest, ...input } = { ...item.offer, ...changes }
  return { ...item, offer: materializeAiExecutionOfferSnapshot(input) }
}

describe('complexity policy over the existing deterministic selector', () => {
  it.each(['C0', 'C1'] as const)('selects qualified cheap/fast coding for %s', (complexity) => {
    const input = request(complexity)
    const decision = selectTaskExecutionRoute(input)
    expect(decision.primary.offer.offer.offerId).toBe('economy')
    expect(decision.primary.effort).toBe('quick')
    expect(decision.primary.receipt.decision.strategy).toBe('rule')
    expect(decision.requiredCapabilities).toEqual(['coding/v1'])
    expect(decision.reviewPolicy.required).toBe(false)
  })

  it('uses latency then stable offer identity to break equal-cost ties', () => {
    const input = request()
    const slow = { ...offer('a', 10), estimatedLatencyMs: 1000 }
    const fast = { ...offer('b', 10), estimatedLatencyMs: 10 }
    expect(selectTaskExecutionRoute({ ...input, offers: [slow, fast] }).primary.offer.offer.offerId).toBe('b')
    expect(selectTaskExecutionRoute({ ...input, offers: [offer('b', 10), offer('a', 10)] }).primary.offer.offer.offerId).toBe('a')
  })

  it('requires strong coding and at least high effort for C2', () => {
    const input = request('C2')
    const fast = { ...offer('fast', 1), qualification: { evidenceRef: 'qualified', maximumComplexity: 'C3' as const, coding: 'fast' as const } }
    const unsupported = { ...offer('unsupported', 2), efforts: [{ name: 'quick', level: 1 }] }
    const decision = selectTaskExecutionRoute({ ...input, offers: [fast, unsupported, offer('strong')] })
    expect(decision.primary.offer.offer.offerId).toBe('strong')
    expect(decision.primary.effort).toBe('careful')
    expect(decision.eligibility).toEqual(expect.arrayContaining([
      expect.objectContaining({ offerId: 'fast', reasons: expect.arrayContaining(['STRONG_CODING_REQUIRED']) }),
      expect.objectContaining({ offerId: 'unsupported', reasons: expect.arrayContaining(['EFFORT_UNSUPPORTED']) }),
    ]))
  })

  it.each(['implementation', 'architecture', 'security'] as const)('routes C3 %s and an independent reviewer at highest supported effort', (kind) => {
    const input = request('C3')
    const decision = selectTaskExecutionRoute({ ...input, task: { ...input.task, kind } })
    expect(decision.primary.effort).toBe('deepest')
    expect(decision.reviewer?.effort).toBe('deepest')
    expect(decision.reviewPolicy.required).toBe(true)
    expect(decision.reviewer?.offer.offer.provider).not.toBe(decision.primary.offer.offer.provider)
    expect(decision.reviewer?.receipt.decision.policyId).toBe('route/1:review')
  })

  it('refuses C3 without an independent reviewer even when profiles and effort differ', () => {
    const base = offer('one')
    const alias = replaceOfferSnapshot(base, { offerId: 'other-profile', profileRef: 'other-profile' })
    expect(() => selectTaskExecutionRoute({ ...request('C3'), offers: [base, alias] }))
      .toThrowError(expect.objectContaining({ code: 'TASK_ROUTING_NO_REVIEWER' }))
  })

  it('selects a viable implementation/review pair when the cheapest implementer lacks a reviewer', () => {
    const reviewCapable = offer('cheap', 10)
    const implementationOnly = replaceOfferSnapshot(offer('expensive', 100), { capabilities: ['coding/v1'] })
    const decision = selectTaskExecutionRoute({ ...request('C3'), offers: [reviewCapable, implementationOnly] })
    expect(decision.primary.offer.offer.offerId).toBe('expensive')
    expect(decision.reviewer?.offer.offer.offerId).toBe('cheap')
  })

  it('accounts for the required reviewer inside the task cost ceiling', () => {
    const input = request('C3')
    expect(() => selectTaskExecutionRoute({ ...input, offers: [offer('one', 600), offer('two', 600)] }))
      .toThrowError(expect.objectContaining({ code: 'TASK_ROUTING_NO_REVIEWER' }))
  })

  it('rejects C3 pairs that overcommit one shared quota pool', () => {
    const quota = { ...offer('one').quota, poolRef: 'shared', remainingTokens: 2000 }
    expect(() => selectTaskExecutionRoute({ ...request('C3'), offers: [
      { ...offer('one'), quota }, { ...offer('two'), quota },
    ] })).toThrowError(expect.objectContaining({ code: 'TASK_ROUTING_NO_REVIEWER' }))
  })

  it('accepts exactly sufficient shared quota and independent pools', () => {
    const quota = { ...offer('one').quota, poolRef: 'shared', remainingTokens: 3000 }
    const input = { ...request('C3'), offers: [{ ...offer('one'), quota }, { ...offer('two'), quota }] }
    expect(selectTaskExecutionRoute(input).reviewer).toBeDefined()
    const separate = input.offers.map((item) => ({ ...item,
      quota: { ...item.quota, poolRef: item.offer.offerId, remainingTokens: 1500 },
    }))
    expect(selectTaskExecutionRoute({ ...input, offers: separate }).reviewer).toBeDefined()
  })

  it('rejects inconsistent observations for the same accounting pool', () => {
    const first = { ...offer('one'), quota: { ...offer('one').quota, poolRef: 'shared' } }
    for (const change of [{ remainingTokens: 1500 }, { available: false }, { checkedAt: '2026-09-09T11:59:59.000Z' }]) {
      const second = { ...offer('two'), quota: { ...first.quota, ...change } }
      expect(() => selectTaskExecutionRoute({ ...request('C3'), offers: [first, second] }))
        .toThrowError(expect.objectContaining({ code: 'TASK_ROUTING_INVALID' }))
    }
  })

  it('records stale health and stale or future quota rejections', () => {
    const staleTime = '2026-09-09T11:59:49.999Z'
    const badHealth = replaceOfferSnapshot(offer('bad-health', 1), { health: { status: 'healthy', checkedAt: staleTime } })
    const badQuota = { ...offer('bad-quota', 2), quota: { ...offer('bad-quota').quota, checkedAt: staleTime } }
    const futureQuota = { ...offer('future-quota', 3), quota: { ...offer('future-quota').quota, checkedAt: '2026-09-09T12:00:00.001Z' } }
    const decision = selectTaskExecutionRoute({ ...request(), offers: [badHealth, badQuota, futureQuota, offer('good')] })
    expect(decision.primary.offer.offer.offerId).toBe('good')
    for (const [id, reason] of [
      ['bad-health', 'HEALTH_OBSERVATION_NOT_CURRENT'],
      ['bad-quota', 'QUOTA_OBSERVATION_NOT_CURRENT'],
      ['future-quota', 'QUOTA_OBSERVATION_NOT_CURRENT'],
    ]) {
      expect(decision.eligibility).toEqual(expect.arrayContaining([
        expect.objectContaining({ offerId: id, reasons: expect.arrayContaining([reason]) }),
      ]))
    }
  })

  it('includes the exact freshness boundary and retains it for replay', () => {
    const boundary = '2026-09-09T11:59:50.000Z'
    const item = replaceOfferSnapshot(offer('boundary'), { health: { status: 'healthy', checkedAt: boundary } })
    const decision = selectTaskExecutionRoute({ ...request(), offers: [{ ...item, quota: { ...item.quota, checkedAt: boundary } }] })
    expect(decision.primary.offer.offer.offerId).toBe('boundary')
    expect(replayTaskRoutingDecision(decision)).toEqual(decision)
    expect(() => selectTaskExecutionRoute({ ...decision.request, maxObservationAgeMs: 9999 }))
      .toThrowError(expect.objectContaining({ code: 'TASK_ROUTING_NO_OFFER' }))
    expect(() => selectTaskExecutionRoute({ ...decision.request, maxObservationAgeMs: 0 }))
      .toThrowError(expect.objectContaining({ code: 'TASK_ROUTING_INVALID' }))
  })

  it('prefers a different family for review, but accepts an independent same-family model', () => {
    const input = request('C2')
    const review = {
      ...input,
      task: { ...input.task, kind: 'review' as const },
      implementer: { provider: 'author', providerFamily: 'family-a', modelRef: 'model/author', providerModelId: 'author' },
      offers: [offer('same-family', 1, 'family-a'), offer('other-family', 100, 'family-b')],
    }
    expect(selectTaskExecutionRoute(review).primary.offer.offer.offerId).toBe('other-family')
    expect(selectTaskExecutionRoute({ ...review, offers: [review.offers[0]!] }).primary.offer.offer.offerId).toBe('same-family')
  })

  it('requires the canonical model identity to differ even across provider aliases', () => {
    const input = request('C1')
    const aliased = replaceOfferSnapshot(offer('alias'), {
      model: { ...offer('alias').offer.model, modelRef: 'model/author' },
    })
    expect(() => selectTaskExecutionRoute({ ...input,
      task: { ...input.task, kind: 'review' }, offers: [aliased],
      implementer: { provider: 'author', providerFamily: 'family-a', modelRef: 'model/author', providerModelId: 'author' },
    })).toThrowError(expect.objectContaining({ code: 'TASK_ROUTING_NO_OFFER' }))
  })

  it.each([
    ['capability', (item: QualifiedTaskRoutingOffer) => replaceOfferSnapshot(item, { capabilities: [] }), 'CAPABILITY_MISSING'],
    ['health', (item: QualifiedTaskRoutingOffer) => replaceOfferSnapshot(item, { health: { status: 'unknown' } }), 'HEALTH_NOT_QUALIFIED'],
    ['context', (item: QualifiedTaskRoutingOffer) => ({ ...item, contextWindowTokens: 100 }), 'CONTEXT_INSUFFICIENT'],
    ['output', (item: QualifiedTaskRoutingOffer) => ({ ...item, maximumOutputTokens: 100 }), 'CONTEXT_INSUFFICIENT'],
    ['quota', (item: QualifiedTaskRoutingOffer) => ({ ...item, quota: { ...item.quota, available: false } }), 'QUOTA_INSUFFICIENT'],
    ['remaining quota', (item: QualifiedTaskRoutingOffer) => ({ ...item, quota: { ...item.quota, remainingTokens: 1 } }), 'QUOTA_INSUFFICIENT'],
    ['cost', (item: QualifiedTaskRoutingOffer) => ({ ...item, estimatedCostMicros: 1001 }), 'COST_LIMIT_EXCEEDED'],
    ['qualification', (item: QualifiedTaskRoutingOffer) => ({ ...item, qualification: { ...item.qualification, maximumComplexity: 'C0' as const } }), 'COMPLEXITY_NOT_QUALIFIED'],
    ['expiry', (item: QualifiedTaskRoutingOffer) => replaceOfferSnapshot(item, { effectiveAt: '2026-09-08T12:00:00.000Z', expiresAt: at }), 'OFFER_NOT_CURRENT'],
    ['digest', (item: QualifiedTaskRoutingOffer) => ({ ...item, offer: { ...item.offer, snapshotDigest: `sha256:${'b'.repeat(64)}` as const } }), 'OFFER_DIGEST_INVALID'],
  ] as const)('records %s rejection before selecting another offer', (_name, change, reason) => {
    const decision = selectTaskExecutionRoute({ ...request(), offers: [change(offer('bad', 1)), offer('good')] })
    expect(decision.primary.offer.offer.offerId).toBe('good')
    expect(decision.eligibility).toEqual(expect.arrayContaining([
      expect.objectContaining({ offerId: 'bad', reasons: expect.arrayContaining([reason]) }),
    ]))
  })

  it.each(['authAvailable', 'backendAvailable', 'modelAvailable'] as const)('preserves selector admission for %s', (field) => {
    const decision = selectTaskExecutionRoute({ ...request(), offers: [{ ...offer('bad', 1), [field]: false }, offer('good')] })
    expect(decision.primary.offer.offer.offerId).toBe('good')
    expect(decision.primary.receipt.decision.rejected.map((item) => item.candidateId)).toContain('bad')
  })

  it('preserves host capability, cost class and transition constraints', () => {
    const input = request()
    expect(() => selectTaskExecutionRoute({ ...input, policy: {
      ...input.policy, requirements: { maximumCostClass: 'free' },
    } })).toThrowError(TaskRoutingError)
    expect(() => selectTaskExecutionRoute({ ...input, policy: {
      ...input.policy, requirements: { capabilities: ['unavailable/v1'] },
    } })).toThrowError(TaskRoutingError)
    const origin = { ...offer('origin', 100), quota: { ...offer('origin').quota, available: false, remainingTokens: 0 } }
    expect(() => selectTaskExecutionRoute({ ...input, offers: [origin, offer('other', 1)], policy: {
      ...input.policy, originCandidateId: 'origin', approvedTransitions: [],
    } })).toThrowError(TaskRoutingError)
  })

  it('rejects missing observations, nonfinite costs and understated security complexity', () => {
    const input = request()
    expect(() => selectTaskExecutionRoute({ ...input, offers: [{ ...offer('bad'), estimatedCostMicros: NaN }] }))
      .toThrowError(expect.objectContaining({ code: 'TASK_ROUTING_INVALID' }))
    expect(() => selectTaskExecutionRoute({ ...input, task: { ...input.task, kind: 'security' } }))
      .toThrowError(expect.objectContaining({ code: 'TASK_ROUTING_INVALID' }))
    expect(() => selectTaskExecutionRoute({ ...input, task: { ...input.task, kind: 'review' } }))
      .toThrowError(expect.objectContaining({ code: 'TASK_ROUTING_INVALID' }))
    expect(() => selectTaskExecutionRoute({ ...input, offers: [{ ...offer('bad'), qualification: { ...offer('bad').qualification, evidenceRef: '' } }] }))
      .toThrowError(expect.objectContaining({ code: 'TASK_ROUTING_INVALID' }))
  })

  it('records immutable, permutation-stable decisions and rejects replay tampering', () => {
    const input = request('C3')
    const decision = selectTaskExecutionRoute(input)
    expect(replayTaskRoutingDecision(decision)).toEqual(decision)
    expect(selectTaskExecutionRoute({ ...input, offers: [...input.offers].reverse() })).toEqual(decision)
    expect(Object.isFrozen(decision.request.offers[0]?.offer.model)).toBe(true)
    expect(Object.isFrozen(decision.reviewer?.receipt.decision)).toBe(true)
    expect(Object.isFrozen(input)).toBe(false)
    const tampered = { ...decision, primary: { ...decision.primary, effort: 'quick' } }
    expect(() => replayTaskRoutingDecision(tampered)).toThrowError(expect.objectContaining({ code: 'TASK_ROUTING_DECISION_MISMATCH' }))
  })

  it('detaches nested caller observations before freezing the decision', () => {
    const input = request()
    const original = offer('mutable', 1)
    const quota = { ...original.quota }
    const decision = selectTaskExecutionRoute({ ...input, offers: [{ ...original, quota }] })
    quota.available = false
    expect(decision.primary.offer.quota.available).toBe(true)
    expect(replayTaskRoutingDecision(decision)).toEqual(decision)
  })

  it('binds provider/model/profile/effort and review policy into existing canonical custody', () => {
    const decision = selectTaskExecutionRoute(request('C3'))
    const selected = decision.primary.offer.offer
    const target = materializeAiResolvedTargetSnapshot({
      schema: 'dzupagent.aiResolvedTarget/v1', targetId: 'target', targetRevision: '1',
      policyRevision: decision.request.policyRevision, operation: 'agent.run', placement: 'worker', executionStyle: 'durable',
      routeCandidateId: selected.offerId, backend: selected.backend, provider: selected.provider,
      model: selected.model.providerModelId!, profileRef: selected.profileRef!, resolvedAt: at,
    })
    const context = { target, prompt: { blueprintRef: 'prompt', blueprintRevision: '1', blueprintDigest: hash, renderedPayloadDigest: hash }, persona: { status: 'none' as const } }
    const bound = bindTaskExecutionRoute(decision, context)
    expect(bound.taskRouting?.effort).toBe('deepest')
    expect(bound.taskRouting?.reviewPolicy.reviewer?.provider).toBe('strong')
    expect(bound.taskRouting?.decisionDigest).toBe(decision.decisionDigest)
    expect(validateAiExecutionBindingDigest(bound).valid).toBe(true)
    expect(() => assertTaskExecutionBinding(decision, bound)).not.toThrow()
    expect(Object.isFrozen(bound.taskRouting?.reviewPolicy)).toBe(true)
    expect(validateAiExecutionBindingDigest({ ...bound, taskRouting: { ...bound.taskRouting, effort: 'quick' } }).valid).toBe(false)
    const { bindingDigest: _bindingDigest, ...bindingInput } = bound
    const forged = materializeAiExecutionBinding({ ...bindingInput, taskRouting: { ...bound.taskRouting!, effort: 'quick' } })
    expect(validateAiExecutionBindingDigest(forged).valid).toBe(true)
    expect(() => assertTaskExecutionBinding(decision, forged))
      .toThrowError(expect.objectContaining({ code: 'TASK_ROUTING_BINDING_MISMATCH' }))
    expect(() => bindTaskExecutionRoute(decision, { ...context, target: { ...target, model: 'other' } }))
      .toThrowError(expect.objectContaining({ code: 'TASK_ROUTING_BINDING_MISMATCH' }))
    const reviewer = decision.reviewer!.offer.offer
    const reviewTarget = materializeAiResolvedTargetSnapshot({
      schema: 'dzupagent.aiResolvedTarget/v1', targetId: 'review-target', targetRevision: '1',
      policyRevision: decision.request.policyRevision, operation: 'agent.run', placement: 'worker', executionStyle: 'durable',
      routeCandidateId: reviewer.offerId, backend: reviewer.backend, provider: reviewer.provider,
      model: reviewer.model.providerModelId!, profileRef: reviewer.profileRef!, resolvedAt: at,
    })
    const reviewBound = bindTaskExecutionRoute(decision, { ...context, target: reviewTarget }, 'reviewer')
    expect(reviewBound.taskRouting?.role).toBe('reviewer')
    expect(reviewBound.taskRouting?.reviewPolicy.implementer?.provider).toBe('economy')
    expect(validateAiExecutionBindingDigest(reviewBound).valid).toBe(true)
    expect(() => assertTaskExecutionBinding(decision, reviewBound)).not.toThrow()
  })
})
