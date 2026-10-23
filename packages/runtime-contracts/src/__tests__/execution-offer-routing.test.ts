import { describe, expect, it } from 'vitest'
import { validateRoutingObservation } from '../execution-offer-routing.js'

const observation = { state: 'known', value: 20, unit: 'tokens', observedAt: '2026-10-23T09:00:00Z', expiresAt: '2026-10-23T09:01:00Z', provenance: 'provider/receipt', confidence: 1 }
describe('operational observations', () => {
  it('preserves explicit units and unknown state', () => {
    expect(validateRoutingObservation(observation)).toEqual([])
    expect(validateRoutingObservation({ ...observation, unit: 'percent', value: 50 })).toEqual([])
    const { value: _, ...unknown } = observation
    expect(validateRoutingObservation({ ...unknown, state: 'unknown', reason: 'permission denied' })).toEqual([])
    expect(validateRoutingObservation({ ...observation, state: 'unknown', reason: 'no snapshot' })).not.toEqual([])
  })
  it.each([-1, NaN, Infinity, .5, Number.MAX_SAFE_INTEGER + 1])('rejects malformed token count %s', value => {
    expect(validateRoutingObservation({ ...observation, value })).not.toEqual([])
  })
  it.each([
    { confidence: 1.1 }, { confidence: NaN }, { provenance: '' }, { unit: 'requests' },
    { observedAt: 'yesterday' }, { expiresAt: observation.observedAt }, { unit: 'percent', value: 101 },
    { unit: 'score', value: 1.01 }, { state: 'missing' },
  ])('rejects inconsistent observation metadata %j', changes => {
    expect(validateRoutingObservation({ ...observation, ...changes })).not.toEqual([])
  })
})
