/**
 * Unit tests for the council coordination pattern.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentOrchestrator } from '../../../orchestrator.js'
import { councilPattern, DEFAULT_GOVERNANCE_MODEL } from '../council-pattern.js'
import { buildContext, buildResolved } from './test-helpers.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('councilPattern', () => {
  it('exposes the canonical id', () => {
    expect(councilPattern.id).toBe('council')
  })

  it('exposes a sensible default governance model', () => {
    expect(DEFAULT_GOVERNANCE_MODEL).toBe('claude-opus-4-7')
  })

  it('throws when participants is empty', async () => {
    const { ctx } = buildContext('council', [])
    await expect(councilPattern.execute(ctx)).rejects.toThrow(/no participants/)
  })

  it('falls back to single-participant when there are no proposers', async () => {
    const { ctx } = buildContext('council', [
      buildResolved('judge', {
        role: 'judge',
        model: 'claude-opus-4-7',
        response: 'verdict',
      }),
    ])
    const result = await councilPattern.execute(ctx)
    expect(result.pattern).toBe('single-participant')
    expect(result.content).toBe('verdict')
  })

  it('delegates to AgentOrchestrator.debate and emits policy_applied when judgeModel is set', async () => {
    const debateSpy = vi
      .spyOn(AgentOrchestrator, 'debate')
      .mockResolvedValue('verdict')

    const { ctx, calls } = buildContext(
      'council',
      [
        buildResolved('judge', { role: 'judge', model: 'claude-opus-4-7' }),
        buildResolved('p1', { role: 'proposer' }),
        buildResolved('p2', { role: 'proposer' }),
      ],
      {
        policies: { governance: { judgeModel: 'claude-opus-4-7' } },
      },
    )

    const result = await councilPattern.execute(ctx)
    expect(debateSpy).toHaveBeenCalledTimes(1)
    expect(result.pattern).toBe('council')
    expect(result.content).toBe('verdict')
    expect(calls.policyApplied).toEqual([
      { group: 'governance', field: 'judgeModel' },
    ])
    // Only the judge entry surfaces the verdict in `content`; proposers stay empty.
    const judge = result.agentResults.find((r) => r.agentId === 'judge')!
    const proposer = result.agentResults.find((r) => r.agentId === 'p1')!
    expect(judge.content).toBe('verdict')
    expect(proposer.content).toBe('')
  })

  it('falls back to the first participant when no model matches the judgeModel policy', async () => {
    vi.spyOn(AgentOrchestrator, 'debate').mockResolvedValue('verdict')
    const { ctx } = buildContext(
      'council',
      [
        buildResolved('first', { role: 'proposer' }),
        buildResolved('second', { role: 'proposer' }),
      ],
      // Default DEFAULT_GOVERNANCE_MODEL is used; nothing in spawned matches it,
      // so the first participant becomes the judge.
    )
    const result = await councilPattern.execute(ctx)
    const first = result.agentResults.find((r) => r.agentId === 'first')!
    expect(first.content).toBe('verdict')
  })

  it('emits failed completes for everyone when debate throws', async () => {
    vi.spyOn(AgentOrchestrator, 'debate').mockRejectedValue(new Error('judge died'))
    const { ctx, calls } = buildContext('council', [
      buildResolved('judge', { role: 'judge', model: 'claude-opus-4-7' }),
      buildResolved('p1', { role: 'proposer' }),
    ])
    await expect(councilPattern.execute(ctx)).rejects.toThrow('judge died')
    expect(calls.completes.map((c) => c.success)).toEqual([false, false])
  })
})
