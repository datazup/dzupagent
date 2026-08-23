import { describe, expect, it } from 'vitest'

import {
  admitExecutionRoutePolicy,
  ROUTE_POLICY_ADMISSION_CODES,
  selectExecutionRoute,
} from '../routing.js'

function rawPolicy(): Record<string, unknown> {
  return {
    id: 'policy-1',
    requestId: 'request-1',
    strategy: 'rule',
    candidates: [{
      id: 'codex:sdk:work',
      provider: 'codex',
      backend: 'sdk',
      authMode: 'subscription_cli',
      agentHost: 'codex',
      model: 'codex-1',
      profileRef: 'work',
      authSourceRef: 'subscription-ref',
      authAvailable: true,
      backendAvailable: true,
      modelAvailable: true,
      health: { status: 'healthy', checkedAt: '2026-08-20T00:00:00.000Z', reason: 'probe' },
      costClass: 'low',
      privacyClass: 'provider',
      locality: 'remote',
      accessClass: 'subscription',
      policyCompatible: true,
      tags: ['route-weight:1'],
      capabilities: ['tools'],
    }],
    hardConstraints: [{ kind: 'capability', values: ['tools'] }],
    preferenceOrder: ['codex:sdk:work'],
    fallback: 'ordered-compatible',
    maxSelectionLatencyMs: 25,
    originCandidateId: 'codex:sdk:work',
    approvedTransitions: ['identity-change'],
    requirements: {
      providers: ['codex'],
      backends: ['sdk'],
      agentHosts: ['codex'],
      models: ['codex-1'],
      capabilities: ['tools'],
      profileRefs: ['work'],
      authSourceRefs: ['subscription-ref'],
      maximumCostClass: 'medium',
      minimumPrivacyClass: 'provider',
      requireHealthy: true,
    },
  }
}

describe('route-policy admission', () => {
  it('publishes the stable 17-code admission vocabulary', () => {
    expect(ROUTE_POLICY_ADMISSION_CODES).toHaveLength(17)
    expect(new Set(ROUTE_POLICY_ADMISSION_CODES).size).toBe(17)
  })

  it('strictly rebuilds a complete valid policy without retaining nested references', () => {
    const input = rawPolicy()
    const admitted = admitExecutionRoutePolicy(input)

    expect(admitted).toEqual(input)
    expect(admitted).not.toBe(input)
    expect(admitted.candidates).not.toBe(input.candidates)
    expect(admitted.candidates[0]).not.toBe((input.candidates as object[])[0])
    expect(admitted.candidates[0]?.health).not.toBe(
      ((input.candidates as Array<{ health: object }>)[0]?.health),
    )
    expect(admitted.requirements).not.toBe(input.requirements)

    ;(input.preferenceOrder as string[])[0] = 'mutated'
    ;((input.candidates as Array<{ tags: string[] }>)[0]?.tags)[0] = 'mutated'
    expect(admitted.preferenceOrder).toEqual(['codex:sdk:work'])
    expect(admitted.candidates[0]?.tags).toEqual(['route-weight:1'])
  })

  it.each([
    [{ ...rawPolicy(), unexpected: true }, 'ROUTE_POLICY_UNKNOWN_KEY', '$.unexpected'],
    [{ ...rawPolicy(), candidates: [{ id: 'one', extra: true }] }, 'ROUTE_POLICY_CANDIDATE_UNKNOWN_KEY', '$.candidates[0].extra'],
    [{ ...rawPolicy(), candidates: [{ id: 'one', health: { status: 'healthy', extra: true } }] }, 'ROUTE_POLICY_HEALTH_UNKNOWN_KEY', '$.candidates[0].health.extra'],
    [{ ...rawPolicy(), hardConstraints: [{ kind: 'tags', values: [], extra: true }] }, 'ROUTE_POLICY_CONSTRAINT_UNKNOWN_KEY', '$.hardConstraints[0].extra'],
    [{ ...rawPolicy(), requirements: { providers: [], extra: true } }, 'ROUTE_POLICY_REQUIREMENTS_UNKNOWN_KEY', '$.requirements.extra'],
  ])('rejects unknown keys at every object level', (input, code, path) => {
    expect(() => admitExecutionRoutePolicy(input)).toThrow(expect.objectContaining({ code, path }))
  })

  it.each([
    [{ ...rawPolicy(), maxSelectionLatencyMs: '25' }, 'ROUTE_POLICY_EXPECTED_NUMBER', '$.maxSelectionLatencyMs'],
    [{ ...rawPolicy(), maxSelectionLatencyMs: 1.5 }, 'ROUTE_POLICY_INVALID_INTEGER', '$.maxSelectionLatencyMs'],
    [{ ...rawPolicy(), candidates: [{ id: 7 }] }, 'ROUTE_POLICY_EXPECTED_STRING', '$.candidates[0].id'],
    [{ ...rawPolicy(), candidates: [{ id: 'one', authAvailable: 1 }] }, 'ROUTE_POLICY_EXPECTED_BOOLEAN', '$.candidates[0].authAvailable'],
    [{ ...rawPolicy(), preferenceOrder: 'one' }, 'ROUTE_POLICY_EXPECTED_ARRAY', '$.preferenceOrder'],
    [{ ...rawPolicy(), fallback: 'best-effort' }, 'ROUTE_POLICY_EXPECTED_ENUM', '$.fallback'],
  ])('does not coerce malformed values', (input, code, path) => {
    expect(() => admitExecutionRoutePolicy(input)).toThrow(expect.objectContaining({ code, path }))
  })

  it('keeps shape admission separate from strategy implementation admission', () => {
    const admitted = admitExecutionRoutePolicy({ ...rawPolicy(), strategy: 'llm-rank' })
    expect(admitted.strategy).toBe('llm-rank')
    expect(() => selectExecutionRoute(admitted, { decidedAt: '2026-08-20T00:00:00.000Z' }))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_ROUTE_STRATEGY' }))
  })

  it('rejects missing fields and non-plain object instances', () => {
    const missing = rawPolicy()
    delete missing.requestId
    expect(() => admitExecutionRoutePolicy(missing)).toThrow(expect.objectContaining({
      code: 'ROUTE_POLICY_REQUIRED_FIELD',
      path: '$.requestId',
    }))
    expect(() => admitExecutionRoutePolicy(new Date())).toThrow(expect.objectContaining({
      code: 'ROUTE_POLICY_EXPECTED_OBJECT',
      path: '$',
    }))

    const accessor = rawPolicy()
    Object.defineProperty(accessor, 'id', { enumerable: true, get: () => 'policy-1' })
    expect(() => admitExecutionRoutePolicy(accessor)).toThrow(expect.objectContaining({
      code: 'ROUTE_POLICY_UNKNOWN_KEY',
      path: '$.id',
    }))
  })
})
