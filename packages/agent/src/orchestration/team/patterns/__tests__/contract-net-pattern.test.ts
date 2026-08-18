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

  it('runs ContractNetManager.executeDetailed and reports actual participants', async () => {
    const legacy = vi.spyOn(ContractNetManager, 'execute')
    const cnSpy = vi
      .spyOn(ContractNetManager, 'executeDetailed')
      .mockImplementation(async (config) => {
        const invocations = [
          {
            agentId: 's1', phase: 'bid' as const, attempt: 0,
            invocationIndex: 0, success: true, durationMs: 2,
            content: 's1 bid',
          },
          {
            agentId: 's2', phase: 'bid' as const, attempt: 0,
            invocationIndex: 1, success: true, durationMs: 3,
            content: 's2 bid',
          },
          {
            agentId: 's1', phase: 'execute' as const,
            invocationIndex: 2, success: true, durationMs: 7,
            content: 'contract result',
          },
        ]
        for (const invocation of invocations) {
          void config.invocationObserver?.onStart?.(invocation)
          void config.invocationObserver?.onComplete?.(invocation)
        }
        return {
          result: {
            cfpId: 'cfp-1',
            agentId: 's1',
            success: true,
            result: 'contract result',
            actualDurationMs: 7,
          },
          invocations,
        }
      })
    const { ctx, calls } = buildContext('contract_net', [
      buildResolved('mgr', { role: 'supervisor' }),
      buildResolved('s1', { role: 'specialist' }),
      buildResolved('s2', { role: 'specialist' }),
    ])

    const result = await contractNetPattern.execute(ctx)
    expect(cnSpy).toHaveBeenCalledTimes(1)
    expect(legacy).not.toHaveBeenCalled()
    expect(result.pattern).toBe('contract-net')
    expect(result.content).toBe('contract result')
    // Winner aggregates its bid + execution; the loser keeps its own bid.
    const winner = result.agentResults.find((r) => r.agentId === 's1')!
    const loser = result.agentResults.find((r) => r.agentId === 's2')!
    expect(winner.content).toBe('contract result')
    expect(winner.durationMs).toBe(9)
    expect(loser.content).toBe('s2 bid')
    expect(loser.durationMs).toBe(3)
    expect(calls.starts).toEqual(['s1', 's2'])
  })

  it('marks the winner as failed when ContractNetManager reports failure', async () => {
    vi.spyOn(ContractNetManager, 'executeDetailed').mockImplementation(async (config) => {
      const invocations = [
        {
          agentId: 's1', phase: 'bid' as const, attempt: 0,
          invocationIndex: 0, success: true, durationMs: 1,
          content: 'accepted bid',
        },
        {
          agentId: 's1', phase: 'execute' as const,
          invocationIndex: 1, success: false, durationMs: 2,
          failureKind: 'model_error' as const, error: 'no good bid',
        },
      ]
      for (const invocation of invocations) {
        void config.invocationObserver?.onStart?.(invocation)
        void config.invocationObserver?.onComplete?.(invocation)
      }
      return {
        result: {
          cfpId: 'cfp-2',
          agentId: 's1',
          success: false,
          error: 'no good bid',
          actualDurationMs: 2,
        },
        invocations,
      }
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
