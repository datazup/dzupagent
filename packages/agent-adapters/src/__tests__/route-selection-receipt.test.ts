import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import type { ExecutionRoutePolicy } from '@dzupagent/runtime-contracts'

import {
  createRouteSelectionReceipt,
  replayRouteSelectionReceipt,
  ROUTE_SELECTION_RECEIPT_SCHEMA,
} from '../routing.js'

const DECIDED_AT = '2026-08-20T00:00:00.000Z'

function weightedPolicy(weight = 3): ExecutionRoutePolicy {
  return {
    id: 'fixture-policy',
    requestId: 'fixture-request',
    strategy: 'weighted',
    candidates: [
      { id: 'beta', tags: [`route-weight:${weight}`] },
      { id: 'alpha', tags: ['route-weight:1'] },
    ],
    hardConstraints: [],
    preferenceOrder: [],
    fallback: 'ordered-compatible',
    maxSelectionLatencyMs: 25,
  }
}

describe('route-selection receipts', () => {
  it('pins seeded weighted receipt bytes and replays from recorded inputs', () => {
    const receipt = createRouteSelectionReceipt(weightedPolicy(), {
      decidedAt: DECIDED_AT,
      seed: 'fixture-seed',
    })
    const fixturePath = fileURLToPath(new URL(
      './fixtures/route-selection/weighted-receipt.json',
      import.meta.url,
    ))

    expect(`${JSON.stringify(receipt, null, 2)}\n`).toBe(readFileSync(fixturePath, 'utf8'))
    expect(replayRouteSelectionReceipt(weightedPolicy(), receipt)).toEqual(receipt.decision)
    expect(receipt.schema).toBe(ROUTE_SELECTION_RECEIPT_SCHEMA)
  })

  it('rejects weight drift and decision tampering', () => {
    const receipt = createRouteSelectionReceipt(weightedPolicy(), {
      decidedAt: DECIDED_AT,
      seed: 'fixture-seed',
    })

    expect(() => replayRouteSelectionReceipt(weightedPolicy(4), receipt))
      .toThrow(expect.objectContaining({ code: 'ROUTE_SELECTION_RECEIPT_WEIGHT_MISMATCH' }))
    expect(() => replayRouteSelectionReceipt(weightedPolicy(), {
      ...receipt,
      decision: { ...receipt.decision, selectedCandidateId: 'alpha' },
    })).toThrow(expect.objectContaining({ code: 'ROUTE_SELECTION_RECEIPT_DECISION_MISMATCH' }))
  })

  it('carries round-robin state only through receipts', () => {
    const policy: ExecutionRoutePolicy = {
      ...weightedPolicy(),
      strategy: 'round-robin',
      candidates: [{ id: 'gamma' }, { id: 'alpha' }, { id: 'beta' }],
    }
    const first = createRouteSelectionReceipt(policy, { decidedAt: DECIDED_AT })
    const second = createRouteSelectionReceipt(policy, {
      decidedAt: DECIDED_AT,
      roundRobinCursor: first.decision.selectedCandidateId ?? undefined,
    })
    const repeated = createRouteSelectionReceipt(policy, {
      decidedAt: DECIDED_AT,
      roundRobinCursor: first.decision.selectedCandidateId ?? undefined,
    })

    expect(first.decision.selectedCandidateId).toBe('alpha')
    expect(first.roundRobinCursor).toBeNull()
    expect(second.decision.selectedCandidateId).toBe('beta')
    expect(second.roundRobinCursor).toBe('alpha')
    expect(second).toEqual(repeated)
    expect(replayRouteSelectionReceipt(policy, second)).toEqual(second.decision)
  })

  it('fails closed for an unsupported schema or different policy identity', () => {
    const receipt = createRouteSelectionReceipt(weightedPolicy(), {
      decidedAt: DECIDED_AT,
      seed: 'fixture-seed',
    })
    expect(() => replayRouteSelectionReceipt(weightedPolicy(), {
      ...receipt,
      schema: 'unsupported' as typeof receipt.schema,
    })).toThrow(expect.objectContaining({ code: 'ROUTE_SELECTION_RECEIPT_SCHEMA_UNSUPPORTED' }))
    expect(() => replayRouteSelectionReceipt({ ...weightedPolicy(), id: 'other' }, receipt))
      .toThrow(expect.objectContaining({ code: 'ROUTE_SELECTION_RECEIPT_POLICY_MISMATCH' }))
  })
})
