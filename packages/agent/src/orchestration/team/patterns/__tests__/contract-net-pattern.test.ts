/**
 * Unit tests for the contract-net coordination pattern.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContractNetManager } from '../../../contract-net/contract-net-manager.js'
import { contractNetPattern } from '../contract-net-pattern.js'
import { buildContext, buildResolved } from './test-helpers.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('contractNetPattern', () => {
  it('exposes the canonical id', () => {
    expect(contractNetPattern.id).toBe('contract_net')
  })

  it('throws when participants is empty', async () => {
    const { ctx } = buildContext('contract_net', [])
    await expect(contractNetPattern.execute(ctx)).rejects.toThrow(
      /no participants/,
    )
  })

  it('falls back to single-participant when only the manager is present', async () => {
    const { ctx } = buildContext('contract_net', [
      buildResolved('solo', { role: 'supervisor', response: 'solo-result' }),
    ])
    const result = await contractNetPattern.execute(ctx)
    expect(result.pattern).toBe('single-participant')
    expect(result.content).toBe('solo-result')
  })

  it('runs ContractNetManager.execute with the specialists and reports the winner', async () => {
    const cnSpy = vi
      .spyOn(ContractNetManager, 'execute')
      .mockResolvedValue({
        cfpId: 'cfp-1',
        agentId: 's1',
        success: true,
        result: 'contract result',
        actualDurationMs: 7,
      })
    const { ctx, calls } = buildContext('contract_net', [
      buildResolved('mgr', { role: 'supervisor' }),
      buildResolved('s1', { role: 'specialist' }),
      buildResolved('s2', { role: 'specialist' }),
    ])

    const result = await contractNetPattern.execute(ctx)
    expect(cnSpy).toHaveBeenCalledTimes(1)
    expect(result.pattern).toBe('contract-net')
    expect(result.content).toBe('contract result')
    // Winner gets the result content; non-winners get empty content + 0 ms.
    const winner = result.agentResults.find((r) => r.agentId === 's1')!
    const loser = result.agentResults.find((r) => r.agentId === 's2')!
    expect(winner.content).toBe('contract result')
    expect(winner.durationMs).toBe(7)
    expect(loser.content).toBe('')
    expect(loser.durationMs).toBe(0)
    expect(calls.starts).toEqual(['mgr', 's1', 's2'])
  })

  it('marks the winner as failed when ContractNetManager reports failure', async () => {
    vi.spyOn(ContractNetManager, 'execute').mockResolvedValue({
      cfpId: 'cfp-2',
      agentId: 's1',
      success: false,
      error: 'no good bid',
      actualDurationMs: 0,
    })
    const { ctx, calls } = buildContext('contract_net', [
      buildResolved('mgr', { role: 'supervisor' }),
      buildResolved('s1', { role: 'specialist' }),
    ])

    const result = await contractNetPattern.execute(ctx)
    const winner = result.agentResults.find((r) => r.agentId === 's1')!
    expect(winner.success).toBe(false)
    expect(winner.error).toBe('no good bid')
    expect(calls.completes.find((c) => c.id === 's1')!.success).toBe(false)
  })
})
