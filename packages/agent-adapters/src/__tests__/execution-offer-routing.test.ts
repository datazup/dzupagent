import { describe, expect, it, vi } from 'vitest'
import { materializeAiExecutionOfferSnapshot, materializeAiResolvedTargetSnapshot, validateAiExecutionBindingDigest } from '@dzupagent/runtime-contracts/ai-execution/node'
import type { RoutingObservation, RoutingCapacity, ExecutionOfferOperations, ExecutionOfferReservationPort } from '@dzupagent/runtime-contracts'
import type { AiBudgetReservationRequest } from '@dzupagent/runtime-contracts/ai-budget-reservation'
import type { QualifiedTaskRoutingOffer } from '../registry/complexity-routing-types.js'
import { DEFAULT_EXECUTION_OFFER_WEIGHTS, bindExecutionOfferRouting, assertExecutionOfferRoutingBinding, routeExecutionOffers, replayExecutionOfferRouting, reserveExecutionOfferRouting, recoverExecutionOfferRouting, digestExecutionOfferRouting } from '../routing.js'
import type { ExecutionOfferRoutingRequest } from '../routing.js'

const at = '2026-10-23T09:00:00.000Z', expires = '2026-10-23T09:01:00.000Z'
const hash = `sha256:${'a'.repeat(64)}` as const
function m(value: number, unit: RoutingObservation['unit'] = 'slots'): RoutingObservation {
  return { state: 'known', value, unit, observedAt: at, expiresAt: expires, provenance: 'receipt/live', confidence: 1 }
}
function capacity(limit = 4): RoutingCapacity { return { running: m(0), queued: m(0), reserved: m(0), limit: m(limit), reviewHeadroom: m(1) } }
function offer(id: string, principal: string, provider = 'codex', host = 'am5'): { qualified: QualifiedTaskRoutingOffer; operations: ExecutionOfferOperations; budget: AiBudgetReservationRequest } {
  const qualified: QualifiedTaskRoutingOffer = {
    offer: materializeAiExecutionOfferSnapshot({ schema: 'dzupagent.aiExecutionOffer/v1', offerId: id, offerRevision: '1',
      provider, backend: 'sdk', profileRef: `profile/${id}`, model: { modelRef: `model/${id}`, revision: '1', providerModelId: provider === 'codex' ? 'gpt-6.1-sol' : 'claude', catalogDigest: hash },
      locality: principal === 'user2' ? 'local' : 'remote', privacyClass: 'provider', capabilities: ['coding/v1', 'code-review/v1'],
      cacheBehavior: 'unknown', sessionBehavior: 'stateless', health: { status: 'healthy', checkedAt: at }, effectiveAt: at, expiresAt: expires, catalogDigest: hash }),
    providerFamily: provider, qualification: { evidenceRef: 'qualification/test', maximumComplexity: 'C3', coding: 'strong' },
    efforts: [{ name: 'high', level: 3 }], contextWindowTokens: 10000, maximumOutputTokens: 1000, estimatedCostMicros: 200,
    costClass: 'low', estimatedLatencyMs: 100, quota: { poolRef: `pool/${id}`, available: true, remainingTokens: 10000, evidenceRef: 'quota/live', checkedAt: at },
    authAvailable: true, backendAvailable: true, modelAvailable: true,
  }
  const operations: ExecutionOfferOperations = { offerId: id, principal, account: `account/${id}`, host, quotaPool: `pool/${id}`, stages: ['review', 'implementation'], authorityRef: 'admission/1', allowed: true,
    principalCapacity: capacity(), accountCapacity: capacity(), hostCapacity: capacity(),
    quota: { remaining: m(10000, 'tokens'), committed: m(0, 'tokens'), reviewHeadroom: m(200, 'tokens') },
    quality: m(.8, 'score'), continuity: m(.8, 'score'), fairness: m(.5, 'score'),
    completion: { queue: m(0, 'ms'), execution: m(100, 'ms'), transfer: m(0, 'ms'), validation: m(100, 'ms'), review: m(100, 'ms') } }
  const budget: AiBudgetReservationRequest = { tariff: { schema: 'dzupagent.aiTariff/v2', tariffId: `tariff/${id}`, offerRef: id, modelRef: `model/${id}`, modelRevision: '1', currency: 'USD',
    baseRates: { inputMicrosPerToken: 1, outputMicrosPerToken: 1 }, provenance: { sourceKind: 'hand-maintained', authorityId: 'operator', revision: '1', effectiveAt: at, digest: hash } },
    usageCeiling: { uncachedInputTokens: 100, outputTokens: 100 }, hardCeiling: { currency: 'USD', maxAmountMicros: 1000 }, reservedAt: at }
  return { qualified, operations, budget }
}
function request(): ExecutionOfferRoutingRequest {
  const offers = [offer('local-sol', 'user2'), offer('peer', 'user1', 'claude'), offer('ninel', 'ninel', 'claude')]
  return { schema: 'dzupagent.executionOfferRouting/v1', qualification: { schema: 'dzupagent.taskRoutingRequest/v1', policyRevision: 'policy/1',
    task: { taskId: 'task/1', kind: 'implementation', complexity: 'C2', requiredCapabilities: [], contextTokens: 100, outputTokens: 100, maximumCostMicros: 1000, assessmentRef: 'assessment/1' },
    offers: offers.map(o => o.qualified), policy: { id: 'route/1', requestId: 'task/1', hardConstraints: [], fallback: 'none', maxSelectionLatencyMs: 100, approvedTransitions: ['identity-change', 'local-to-remote'] }, decidedAt: at, maxObservationAgeMs: 10000 },
    operations: offers.map(o => o.operations), budgets: Object.fromEntries(offers.map(o => [o.qualified.offer.offerId, o.budget])),
    policy: { revision: 'policy/1', maxObservationAgeMs: 10000, minimumConfidence: .8, maximumCompletionMs: 10000, weights: DEFAULT_EXECUTION_OFFER_WEIGHTS,
      preferredLocal: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' } },
    assignment: { taskId: 'task/1', stage: 'implementation', generation: 2, ownerOfferId: 'local-sol', state: 'checkpointed', sourceRef: 'git/main@123', recoveryRef: 'checkpoint/1' },
    localPrincipal: 'user2', localHost: 'am5', environmentRef: 'host/am5/receipt', remainingBudgetMicros: 10000, budgetCurrency: 'USD' }
}
function changeOp(r: ExecutionOfferRoutingRequest, id: string, changes: Partial<ExecutionOfferOperations>): ExecutionOfferRoutingRequest {
  return { ...r, operations: r.operations.map(o => o.offerId === id ? { ...o, ...changes } : o) }
}
function unknown(unit: RoutingObservation['unit']): RoutingObservation {
  const { value: _value, ...metadata } = m(0, unit)
  return { ...metadata, state: 'unknown', reason: 'no qualified sample', confidence: 0 }
}
function uncertainRequest(): ExecutionOfferRoutingRequest {
  const r = request()
  return { ...r, policy: { ...r.policy, rankingEvidence: 'conservative' }, operations: r.operations.map(o => ({ ...o,
    quality: unknown('score'), continuity: { ...m(.8, 'score'), confidence: .3 }, fairness: unknown('score'),
    completion: { ...o.completion, execution: unknown('ms') },
  })) }
}
function ports(input: ExecutionOfferRoutingRequest) {
  const seen = new Set<string>(), accepted = new Set<string>()
  const reservation: ExecutionOfferReservationPort = {
    reserve: vi.fn(async v => { if (seen.has(v.key)) return null; seen.add(v.key); return { id: 'hold/1', key: v.key, offerId: v.offerId, ...(v.reviewerOfferId ? { reviewerOfferId: v.reviewerOfferId } : {}),
      generation: v.expectedGeneration + 1, decisionDigest: v.decisionDigest, observationDigest: v.observationDigest, expiresAt: '2026-10-23T09:00:01.000Z' } }),
    confirm: vi.fn(async v => { if (accepted.has(v.key)) return { accepted: false }; accepted.add(v.key); return { accepted: true, handoffId: 'handoff/1' } }),
  }
  return { observe: async () => input, reservation, now: () => at, holdMs: 1000 }
}
describe('operational routing on existing qualification and deterministic receipts', () => {
  it('keeps strict ranking as the default and validates an explicit mode', () => {
    const r = uncertainRequest(), { rankingEvidence: _mode, ...policy } = r.policy
    expect(routeExecutionOffers({ ...r, policy }).action).toBe('wait')
    expect(routeExecutionOffers({ ...r, policy: { ...policy, rankingEvidence: 'strict' } }).action).toBe('wait')
    expect(() => routeExecutionOffers({ ...r, policy: { ...policy, rankingEvidence: 'optimistic' as 'strict' } })).toThrow('ROUTING_RANKING_EVIDENCE_INVALID')
    const normal = routeExecutionOffers(request()).ranked[0]!
    expect(normal).not.toHaveProperty('completionBasis')
    expect(normal).not.toHaveProperty('uncertainty')
  })
  it('gives uncertain ranking facts no credit and labels completion as a policy penalty', () => {
    const r = uncertainRequest(), d = routeExecutionOffers(r)
    expect(d.selectedOfferId).toBe('local-sol')
    expect(d.ranked[0]!.score).toBeCloseTo(.08)
    expect(d.ranked[0]).toEqual(expect.objectContaining({ completionMs: r.policy.maximumCompletionMs, completionBasis: 'policy-penalty',
      uncertainty: ['EVIDENCE_REQUIRED:quality', 'EVIDENCE_REQUIRED:continuity', 'EVIDENCE_REQUIRED:fairness', 'EVIDENCE_REQUIRED:completion.execution'] }))
    expect(d.request.operations).toEqual(r.operations)
    expect(d.request.operations[0]!.quality).not.toHaveProperty('value')
    expect(r.operations[0]!.continuity).toEqual(expect.objectContaining({ state: 'known', value: .8, confidence: .3 }))
    expect(replayExecutionOfferRouting(d)).toEqual(d)
    expect(() => replayExecutionOfferRouting({ ...d, ranked: d.ranked.map(v => ({ ...v, uncertainty: [] })) })).toThrow('ROUTING_DECISION_MISMATCH')
  })
  it('keeps ties deterministic with no soft credit and records stale soft evidence', () => {
    let r = uncertainRequest(), { preferredLocal: _preferred, ...policy } = r.policy
    r = { ...r, policy }
    expect(routeExecutionOffers(r).selectedOfferId).toBe('local-sol')
    expect(routeExecutionOffers({ ...r, qualification: { ...r.qualification, offers: [...r.qualification.offers].reverse() }, operations: [...r.operations].reverse() }).selectedOfferId).toBe('local-sol')
    const stale = changeOp(r, 'local-sol', { quality: { ...m(1, 'score'), observedAt: '2026-10-23T08:59:00.000Z', expiresAt: at } })
    expect(routeExecutionOffers(stale).ranked.find(v => v.offerId === 'local-sol')!.uncertainty).toContain('OBSERVATION_NOT_CURRENT:quality')
  })
  it('never uses an unknown completion penalty as a deadline fit or exception', () => {
    let r = uncertainRequest()
    r = { ...r, policy: { ...r.policy, maximumCompletionMs: 100 }, urgency: { deadline: '2026-10-23T09:00:00.500Z', exceptionRef: 'urgent/approved' } }
    const d = routeExecutionOffers(r)
    expect(d.selectedOfferId).toBe('local-sol')
    expect(d.reasons.some(v => v.startsWith('DEADLINE_EXCEPTION:'))).toBe(false)
    // The peer's penalty100 is numerically below the deadline, but the measured
    // local duration1300 does not fit. The unknown peer cannot displace it.
    r = changeOp(r, 'local-sol', { completion: { queue: m(1000, 'ms'), execution: m(100, 'ms'), transfer: m(0, 'ms'), validation: m(100, 'ms'), review: m(100, 'ms') } })
    expect(routeExecutionOffers(r).selectedOfferId).toBe('local-sol')
    // A qualified peer duration300 CAN establish the exception; unknown local
    // completion100 must not win against it or be selected by an LLM proposal.
    r = changeOp(uncertainRequest(), 'peer', { completion: request().operations[1]!.completion })
    r = { ...r, policy: { ...r.policy, maximumCompletionMs: 100 }, urgency: { deadline: '2026-10-23T09:00:00.500Z', exceptionRef: 'urgent/approved' } }
    expect(routeExecutionOffers(r).selectedOfferId).toBe('peer')
    expect(() => routeExecutionOffers({ ...r, assessment: { schema: 'dzupagent.executionOfferAssessment/v1', action: 'select', policyRevision: r.policy.revision,
      inputDigest: digestExecutionOfferRouting(r), offerId: 'local-sol', rationale: 'The numeric penalty looks fast.' } })).toThrow('ROUTING_ASSESSMENT_INELIGIBLE')
  })
  it.each(['quota', 'principal', 'account', 'host', 'recovery'] as const)('still holds unknown mandatory %s evidence', field => {
    const r = uncertainRequest()
    const operations = r.operations.map(o => field === 'quota' ? { ...o, quota: { ...o.quota, remaining: unknown('tokens') } }
      : field === 'recovery' ? { ...o, recovery: { restoredAt: at, admitted: unknown('slots'), limit: m(1) } }
      : { ...o, [`${field}Capacity`]: { ...o[`${field}Capacity`], limit: unknown('slots') } })
    expect(routeExecutionOffers({ ...r, operations }).action).toBe('wait')
  })
  it('still holds stale or low-confidence quota, denied authority and unknown pricing', () => {
    const r = uncertainRequest()
    for (const remaining of [{ ...m(10000, 'tokens'), observedAt: '2026-10-23T08:59:00.000Z', expiresAt: at }, { ...m(10000, 'tokens'), confidence: .3 }]) {
      expect(routeExecutionOffers({ ...r, operations: r.operations.map(o => ({ ...o, quota: { ...o.quota, remaining } })) }).action).toBe('wait')
    }
    expect(routeExecutionOffers({ ...r, operations: r.operations.map(o => ({ ...o, allowed: false })) }).action).toBe('wait')
    expect(routeExecutionOffers({ ...r, budgets: {} }).action).toBe('wait')
  })
  it('refuses malformed, future and wrong-unit soft facts rather than labelling them uncertain', () => {
    const r = uncertainRequest()
    expect(() => routeExecutionOffers(changeOp(r, 'local-sol', { quality: m(NaN, 'score') }))).toThrow('ROUTING_OBSERVATION_INVALID')
    const wrongUnit = { ...r, operations: r.operations.map(o => ({ ...o, quality: m(1, 'tokens') })) }
    expect(routeExecutionOffers(wrongUnit).action).toBe('wait')
    const future = { ...r, operations: r.operations.map(o => ({ ...o, quality: { ...m(1, 'score'), observedAt: '2026-10-23T09:00:01.000Z', expiresAt: '2026-10-23T09:01:01.000Z' } })) }
    expect(routeExecutionOffers(future).action).toBe('wait')
  })
  it('preserves C3 independence and aggregate review capacity in conservative mode', () => {
    const r = uncertainRequest(), q = { ...r.qualification, task: { ...r.qualification.task, complexity: 'C3' as const } }
    const d = routeExecutionOffers({ ...r, qualification: q })
    expect(d.selectedOfferId).toBe('local-sol')
    expect(d.reviewerOfferId).toBeDefined()
    expect(d.reviewerOfferId).not.toBe(d.selectedOfferId)
    expect(routeExecutionOffers({ ...r, qualification: q, operations: r.operations.map(o => ({ ...o, hostCapacity: capacity(2) })) }).action).toBe('wait')
  })
  it('reserves with the same uncertainty policy and refuses a refresh that changes it', async () => {
    const r = uncertainRequest(), d = routeExecutionOffers(r), p = ports(r)
    const handoff = await reserveExecutionOfferRouting(d, { ...p, now: () => '2026-10-23T09:00:00.001Z' })
    expect(handoff.effort).toBe('high')
    const changed = { ...p, observe: async () => ({ ...r, policy: { ...r.policy, rankingEvidence: 'strict' as const } }) }
    await expect(reserveExecutionOfferRouting(d, changed)).rejects.toThrow('ROUTING_EVIDENCE_CHANGED')
  })
  it('prefers qualified local Sol/high even when the peer has a higher numeric score', () => {
    let r = request()
    r = changeOp(r, 'local-sol', { quality: m(.1, 'score') })
    r = changeOp(r, 'peer', { quality: m(1, 'score') })
    const d = routeExecutionOffers(r)
    expect(d.selectedOfferId).toBe('local-sol')
    expect(d.ranked.find(v => v.offerId === 'peer')!.score).toBeGreaterThan(d.ranked[0]!.score)
    expect(d.receipt?.decision.strategy).toBe('rule')
    expect(replayExecutionOfferRouting(d)).toEqual(d)
    expect(Object.isFrozen(d.request.operations)).toBe(true)
  })
  it('allows only a documented deadline exception to beat local precedence', () => {
    const r = changeOp(request(), 'local-sol', { completion: { queue: m(1000, 'ms'), execution: m(100, 'ms'), transfer: m(0, 'ms'), validation: m(100, 'ms'), review: m(100, 'ms') } })
    const d = routeExecutionOffers({ ...r, urgency: { deadline: '2026-10-23T09:00:00.500Z', exceptionRef: 'urgent/approval' } })
    expect(d.selectedOfferId).not.toBe('local-sol')
  })
  it('refuses busy peers and exhausted local quota rather than overloading another user', () => {
    let r = request()
    r = { ...r, qualification: { ...r.qualification, offers: r.qualification.offers.map(o => ({ ...o, quota: { ...o.quota, available: false } })) } }
    for (const id of ['peer', 'ninel']) r = changeOp(r, id, { principalCapacity: { ...capacity(2), queued: m(2) } })
    const d = routeExecutionOffers(r)
    expect(d.action).toBe('wait')
    expect(d.eligibility.find(v => v.offerId === 'peer')!.reasons).toContain('CAPACITY_EXHAUSTED:principal:user1')
  })
  it.each(['codex', 'claude'])('fails over symmetrically when %s quota is exhausted', provider => {
    let r = request()
    r = { ...r, qualification: { ...r.qualification, offers: r.qualification.offers.map(o => ({ ...o, quota: { ...o.quota, available: o.offer.provider !== provider } })) } }
    const d = routeExecutionOffers(r)
    expect(d.action).toBe('select')
    expect(r.qualification.offers.find(o => o.offer.offerId === d.selectedOfferId)!.offer.provider).not.toBe(provider)
  })
  it('counts all users on one physical host and rejects contradictory host snapshots', () => {
    let r = request()
    r = { ...r, operations: r.operations.map(o => ({ ...o, hostCapacity: { ...capacity(2), running: m(2) } })) }
    expect(routeExecutionOffers(r).action).toBe('wait')
    expect(() => routeExecutionOffers(changeOp(r, 'peer', { hostCapacity: capacity(10) }))).toThrow('ROUTING_SHARED_OBSERVATION_CONTRADICTION:host:am5')
  })
  it('rejects contradictory shared quota pools without summing their capacity', () => {
    const r = request(), first = r.qualification.offers[0]!
    const changed = { ...r, qualification: { ...r.qualification, offers: r.qualification.offers.map(o => ({ ...o, quota: { ...first.quota } })) },
      operations: r.operations.map(o => ({ ...o, quotaPool: first.quota.poolRef })) }
    expect(() => routeExecutionOffers(changeOp(changed, 'peer', { quota: { ...changed.operations[1]!.quota, committed: m(9000, 'tokens') } }))).toThrow('ROUTING_SHARED_OBSERVATION_CONTRADICTION:pool:')
  })
  it('holds unknown percentage-only and stale evidence without a fabricated token conversion', () => {
    let r = request()
    r = { ...r, operations: r.operations.map(o => ({ ...o, quota: { ...o.quota, remaining: m(99, 'percent') } })) }
    expect(routeExecutionOffers(r).action).toBe('wait')
    r = request()
    const stale = { ...r, qualification: { ...r.qualification, decidedAt: expires } }
    expect(routeExecutionOffers(stale).action).toBe('wait')
  })
  it.each([NaN, Infinity, -1])('rejects malformed capacity %s', value => {
    expect(() => routeExecutionOffers(changeOp(request(), 'peer', { principalCapacity: { ...capacity(), queued: m(value) } }))).toThrow('ROUTING_OBSERVATION_INVALID')
  })
  it('never assumes unknown cost is free', () => {
    const r = request()
    expect(routeExecutionOffers({ ...r, budgets: {} }).action).toBe('wait')
  })
  it('reserves the full admitted token ceiling and refuses mixed monetary units', async () => {
    const r = request(), original = r.budgets['local-sol']!
    const expanded = { ...original, usageCeiling: { uncachedInputTokens: 1000, outputTokens: 100, cachedInputTokens: 50, cacheWriteTokens: 20, reasoningTokens: 30 },
      tariff: { ...original.tariff, baseRates: { ...original.tariff.baseRates, cachedInputMicrosPerToken: 1, cacheWriteMicrosPerToken: 1, reasoningMicrosPerToken: 1 } }, hardCeiling: { currency: 'USD', maxAmountMicros: 5000 } }
    let larger = { ...r, budgets: { ...r.budgets, 'local-sol': expanded }, qualification: { ...r.qualification, task: { ...r.qualification.task, maximumCostMicros: 5000 }, offers: r.qualification.offers.map(o => ({ ...o, estimatedCostMicros: 2000 })) } }
    const d = routeExecutionOffers(larger), p = ports(larger)
    await reserveExecutionOfferRouting(d, p)
    expect(p.reservation.reserve).toHaveBeenCalledWith(expect.objectContaining({ allocations: [expect.objectContaining({ offerId: 'local-sol', tokens: 1200 })] }))
    larger = changeOp({ ...larger, qualification: { ...larger.qualification, offers: larger.qualification.offers.map(o => o.offer.offerId === 'local-sol' ? { ...o, quota: { ...o.quota, remainingTokens: 500 } } : o) } }, 'local-sol', { quota: { ...larger.operations[0]!.quota, remaining: m(500, 'tokens') } })
    expect(routeExecutionOffers(larger).eligibility.find(e => e.offerId === 'local-sol')!.reasons).toContain('QUOTA_COMMITTED_OR_RESERVED')
    const euro = { ...r, budgets: { ...r.budgets, 'local-sol': { ...original, tariff: { ...original.tariff, currency: 'EUR' }, hardCeiling: { currency: 'EUR', maxAmountMicros: 1000 } } } }
    expect(routeExecutionOffers(euro).eligibility.find(e => e.offerId === 'local-sol')!.reasons).toContain('BUDGET_CURRENCY_MISMATCH')
  })
  it('adds differing primary/reviewer ceilings once for a shared C3 quota pool', () => {
    const r = request()
    const shared = { ...r, qualification: { ...r.qualification, task: { ...r.qualification.task, complexity: 'C3' as const }, offers: r.qualification.offers.map(o => ({ ...o, estimatedCostMicros: 400, quota: { ...o.quota, poolRef: 'shared', remainingTokens: 650 } })) },
      budgets: Object.fromEntries(Object.entries(r.budgets).map(([id, b]) => [id, { ...b, usageCeiling: { uncachedInputTokens: id === 'local-sol' ? 300 : 200, outputTokens: 100 } }])),
      operations: r.operations.map(o => ({ ...o, quotaPool: 'shared', quota: { ...o.quota, remaining: m(650, 'tokens'), reviewHeadroom: m(100, 'tokens') } })) }
    // Each role fits alone, but even the smaller pair needs600+protected100.
    expect(routeExecutionOffers(shared).action).toBe('wait')
  })
  it('uses a restored pool only inside its new-work ramp and retains running tasks', () => {
    const r = changeOp(request(), 'local-sol', { recovery: { restoredAt: at, admitted: m(1), limit: m(1) } })
    expect(routeExecutionOffers(r).selectedOfferId).not.toBe('local-sol')
    expect(routeExecutionOffers({ ...r, assignment: { ...r.assignment, state: 'running' } }).action).toBe('retain')
    const recovered = changeOp(r, 'local-sol', { recovery: { restoredAt: at, admitted: m(0), limit: m(1) } })
    expect(routeExecutionOffers(recovered).selectedOfferId).toBe('local-sol')
  })
  it('replays stable ties and detects changed result evidence', () => {
    const r = { ...request(), policy: { ...request().policy, preferredLocal: undefined } }
    // Optional properties are absent in canonical JSON, never undefined.
    const { preferredLocal: _, ...policy } = r.policy
    const d = routeExecutionOffers({ ...r, policy })
    expect(d.selectedOfferId).toBe('local-sol')
    expect(() => replayExecutionOfferRouting({ ...d, action: 'wait' })).toThrow('ROUTING_DECISION_MISMATCH')
  })
  it('protects an independent C3 reviewer and shared capacity', () => {
    const r = request(), q = { ...r.qualification, task: { ...r.qualification.task, complexity: 'C3' as const } }
    const d = routeExecutionOffers({ ...r, qualification: q })
    expect(d.action).toBe('select')
    expect(d.reviewerOfferId).toBeDefined()
    expect(d.reviewerOfferId).not.toBe(d.selectedOfferId)
    const crowded = { ...r, qualification: q, operations: r.operations.map(o => ({ ...o, hostCapacity: capacity(1) })) }
    expect(routeExecutionOffers(crowded).action).toBe('wait')
  })
  it('requires reviewer-stage qualification and accepts review-only operational profiles', () => {
    let r = request()
    r = { ...r, qualification: { ...r.qualification, task: { ...r.qualification.task, complexity: 'C3' } }, operations: r.operations.map(o => ({ ...o, stages: ['implementation'] })) }
    expect(routeExecutionOffers(r).action).toBe('wait')
    r = { ...r, operations: r.operations.map(o => ({ ...o, stages: o.offerId === 'local-sol' ? ['implementation'] : ['review'] })) }
    const d = routeExecutionOffers(r)
    expect(d.selectedOfferId).toBe('local-sol')
    expect(['peer', 'ninel']).toContain(d.reviewerOfferId)
  })
  it('preserves protected review quotas and host slots when reserving a C3 pair', () => {
    let r = request()
    r = { ...r, qualification: { ...r.qualification, task: { ...r.qualification.task, complexity: 'C3' }, offers: r.qualification.offers.map(o => ({ ...o, quota: { ...o.quota, poolRef: 'shared', remainingTokens: 500 } })) },
      operations: r.operations.map(o => ({ ...o, quotaPool: 'shared', quota: { ...o.quota, remaining: m(500, 'tokens') } })) }
    expect(routeExecutionOffers(r).action).toBe('wait')
    const original = request()
    const slots = { ...original, qualification: { ...original.qualification, task: { ...original.qualification.task, complexity: 'C3' as const } }, operations: original.operations.map(o => ({ ...o, hostCapacity: capacity(2) })) }
    expect(routeExecutionOffers(slots).action).toBe('wait')
  })
  it('binds transition approvals to the actual owner and rejects mismatched stages', () => {
    const r = request()
    expect(() => routeExecutionOffers({ ...r, qualification: { ...r.qualification, policy: { ...r.qualification.policy, originCandidateId: 'peer' } } })).toThrow('ROUTING_OWNER_MISMATCH')
    expect(() => routeExecutionOffers({ ...r, assignment: { ...r.assignment, stage: 'review' } })).toThrow('ROUTING_STAGE_MISMATCH')
    const unavailable = { ...r, qualification: { ...r.qualification, policy: { ...r.qualification.policy, approvedTransitions: [] }, offers: r.qualification.offers.map(o => ({ ...o, quota: { ...o.quota, available: o.offer.offerId !== 'local-sol' } })) } }
    expect(routeExecutionOffers(unavailable).action).toBe('wait')
  })
  it('requires quota and health observed after restoration', () => {
    let r = request()
    r = { ...r, qualification: { ...r.qualification, decidedAt: '2026-10-23T09:00:00.500Z' } }
    r = changeOp(r, 'local-sol', { recovery: { restoredAt: '2026-10-23T09:00:00.001Z', admitted: m(0), limit: m(1) } })
    const d = routeExecutionOffers(r)
    expect(d.eligibility.find(e => e.offerId === 'local-sol')!.reasons).toContain('POST_RECOVERY_EVIDENCE_REQUIRED')
    expect(d.selectedOfferId).not.toBe('local-sol')
  })
  it.each(['strict', 'conservative'] as const)('preserves binding checks in a composed read-only review handoff (%s)', async mode => {
    const r = mode === 'strict' ? request() : uncertainRequest()
    const review = { ...r, assignment: { ...r.assignment, stage: 'review' }, qualification: { ...r.qualification, task: { ...r.qualification.task, kind: 'review' as const },
      implementer: { provider: 'claude', providerFamily: 'anthropic', modelRef: 'model/implementer', providerModelId: 'claude-opus' } } }
    const d = routeExecutionOffers(review), selected = review.qualification.offers.find(o => o.offer.offerId === d.selectedOfferId)!.offer
    const target = materializeAiResolvedTargetSnapshot({ schema: 'dzupagent.aiResolvedTarget/v1', targetId: 'target', targetRevision: '1', policyRevision: 'policy/1', operation: 'agent.run', placement: 'worker', executionStyle: 'durable',
      routeCandidateId: selected.offerId, backend: selected.backend, provider: selected.provider, model: selected.model.providerModelId!, profileRef: selected.profileRef!, resolvedAt: at })
    const context = { target, prompt: { blueprintRef: 'review', blueprintRevision: '1', blueprintDigest: hash, renderedPayloadDigest: hash }, persona: { status: 'none' as const } }
    const binding = bindExecutionOfferRouting(d, context)
    expect(validateAiExecutionBindingDigest(binding).valid).toBe(true)
    expect(binding.taskRouting?.effort).toBe('high')
    expect(() => assertExecutionOfferRoutingBinding(d, binding)).not.toThrow()
    expect(() => assertExecutionOfferRoutingBinding(d, { ...binding, taskRouting: { ...binding.taskRouting!, effort: 'low' } })).toThrow('ROUTING_BINDING_MISMATCH')
    const p = ports(review), handoff = await reserveExecutionOfferRouting(d, p)
    const dispatchReview = vi.fn(async () => ({ accepted: true, bindingDigest: binding.bindingDigest }))
    expect(await dispatchReview()).toEqual(expect.objectContaining({ accepted: true }))
    expect(handoff).toEqual(expect.objectContaining({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', stage: 'review', sourceRef: 'git/main@123' }))
    expect(p.reservation.confirm).toHaveBeenCalledTimes(1)
    expect(() => bindExecutionOfferRouting(d, { ...context, target: { ...target, model: 'other' } })).toThrow('ROUTING_BINDING_MISMATCH')
    await expect(reserveExecutionOfferRouting(d, p)).rejects.toThrow('ROUTING_RESERVATION_RACE')
  })
  it('refuses stale generations and changed observations before reservation', async () => {
    const r = request(), d = routeExecutionOffers(r), p = ports(r)
    const stale = { ...p, observe: async () => ({ ...r, assignment: { ...r.assignment, generation: 3 } }) }
    await expect(reserveExecutionOfferRouting(d, stale)).rejects.toThrow('ROUTING_EVIDENCE_CHANGED')
    const changed = { ...p, observe: async () => changeOp(r, 'peer', { quality: m(.2, 'score') }) }
    await expect(reserveExecutionOfferRouting(d, changed)).rejects.toThrow('ROUTING_EVIDENCE_CHANGED')
    await expect(reserveExecutionOfferRouting(d, { ...p, now: () => expires })).rejects.toThrow('ROUTING_EVIDENCE_CHANGED')
    expect(p.reservation.reserve).not.toHaveBeenCalled()
  })
  it('refuses an expired reservation and failed confirmation', async () => {
    const r = request(), d = routeExecutionOffers(r), p = ports(r)
    let tick = 0
    await expect(reserveExecutionOfferRouting(d, { ...p, now: () => tick++ === 0 ? at : expires })).rejects.toThrow('ROUTING_RESERVATION_INVALID')
    const refused = ports(r)
    refused.reservation.confirm = vi.fn(async () => ({ accepted: false }))
    await expect(reserveExecutionOfferRouting(d, refused)).rejects.toThrow('ROUTING_CONFIRMATION_REFUSED')
  })
  it('requires reconciliation for ambiguous dispatch or partial writes', () => {
    for (const dispatch of ['unknown', 'partial-writes'] as const) expect(recoverExecutionOfferRouting({ candidateId: 'local-sol', failureCode: 'QUOTA', dispatch, compatibleOfferIds: ['peer'] })).toEqual({ kind: 'stop', code: 'RECONCILIATION_REQUIRED' })
    expect(recoverExecutionOfferRouting({ candidateId: 'local-sol', failureCode: 'QUOTA', dispatch: 'not-started', compatibleOfferIds: ['peer'] })).toEqual({ kind: 'fallback-candidate', candidateId: 'peer' })
  })
})
