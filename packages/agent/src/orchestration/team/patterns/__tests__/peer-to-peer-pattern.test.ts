/**
 * Unit tests for the peer-to-peer coordination pattern.
 */
import { describe, expect, it } from 'vitest'
import { peerToPeerPattern } from '../peer-to-peer-pattern.js'
import { buildContext, buildResolved } from './test-helpers.js'

describe('peerToPeerPattern', () => {
  it('exposes the canonical id', () => {
    expect(peerToPeerPattern.id).toBe('peer_to_peer')
  })

  it('throws when participants is empty', async () => {
    const { ctx } = buildContext('peer_to_peer', [])
    await expect(peerToPeerPattern.execute(ctx)).rejects.toThrow(
      /no participants/,
    )
  })

  it('runs all participants in parallel and merges successful contents', async () => {
    const { ctx, calls } = buildContext('peer_to_peer', [
      buildResolved('p1', { role: 'worker', response: 'alpha' }),
      buildResolved('p2', { role: 'worker', response: 'beta' }),
    ])

    const result = await peerToPeerPattern.execute(ctx)
    expect(result.pattern).toBe('peer-to-peer')
    expect(result.agentResults).toHaveLength(2)
    expect(result.agentResults.every((r) => r.success)).toBe(true)
    // concatMerge joins on double newlines.
    expect(result.content).toContain('alpha')
    expect(result.content).toContain('beta')
    expect(calls.starts).toEqual(['p1', 'p2'])
  })

  it('returns success=false for failing participants but still merges the rest', async () => {
    const { ctx, calls } = buildContext('peer_to_peer', [
      buildResolved('p1', { role: 'worker', response: 'alpha' }),
      buildResolved('p2', { role: 'worker', shouldThrow: true }),
    ])

    const result = await peerToPeerPattern.execute(ctx)
    const ok = result.agentResults.find((r) => r.agentId === 'p1')!
    const bad = result.agentResults.find((r) => r.agentId === 'p2')!
    expect(ok.success).toBe(true)
    expect(bad.success).toBe(false)
    expect(bad.error).toMatch(/mock model failed/)
    expect(result.content).toBe('alpha')
    expect(calls.completes.find((c) => c.id === 'p2')!.success).toBe(false)
  })

  it('returns empty content when every participant fails', async () => {
    const { ctx } = buildContext('peer_to_peer', [
      buildResolved('p1', { shouldThrow: true }),
      buildResolved('p2', { shouldThrow: true }),
    ])
    const result = await peerToPeerPattern.execute(ctx)
    expect(result.content).toBe('')
    expect(result.agentResults.every((r) => !r.success)).toBe(true)
  })
})
