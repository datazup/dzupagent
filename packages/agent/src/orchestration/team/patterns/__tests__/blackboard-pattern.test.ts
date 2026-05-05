/**
 * Unit tests for the blackboard coordination pattern.
 */
import { describe, expect, it } from 'vitest'
import { blackboardPattern } from '../blackboard-pattern.js'
import { buildContext, buildResolved } from './test-helpers.js'

describe('blackboardPattern', () => {
  it('exposes the canonical id', () => {
    expect(blackboardPattern.id).toBe('blackboard')
  })

  it('throws when participants is empty', async () => {
    const { ctx } = buildContext('blackboard', [])
    await expect(blackboardPattern.execute(ctx)).rejects.toThrow(
      /no participants/,
    )
  })

  it('runs all participants across the default 3 rounds and surfaces final content', async () => {
    const { ctx, calls } = buildContext('blackboard', [
      buildResolved('a1', { role: 'specialist', response: 'note-a' }),
      buildResolved('a2', { role: 'specialist', response: 'note-b' }),
    ])

    const result = await blackboardPattern.execute(ctx)
    expect(result.pattern).toBe('blackboard')
    expect(result.agentResults).toHaveLength(2)
    expect(result.agentResults.every((r) => r.success)).toBe(true)
    // Workspace context contains both contributors' final values.
    expect(result.content).toContain('note-a')
    expect(result.content).toContain('note-b')
    // Each participant should have a single start event (per pattern contract).
    expect(calls.starts).toEqual(['a1', 'a2'])
    expect(calls.completes).toHaveLength(2)
  })

  it('records success=false when a participant throws and continues with the rest', async () => {
    const { ctx } = buildContext('blackboard', [
      buildResolved('healthy', { role: 'specialist', response: 'good-note' }),
      buildResolved('flaky', { role: 'specialist', shouldThrow: true }),
    ])

    const result = await blackboardPattern.execute(ctx)
    const healthy = result.agentResults.find((r) => r.agentId === 'healthy')!
    const flaky = result.agentResults.find((r) => r.agentId === 'flaky')!
    expect(healthy.success).toBe(true)
    expect(flaky.success).toBe(false)
    expect(flaky.error).toMatch(/mock model failed/)
  })

  it('rejects oversized contributions when overflowBehavior=reject', async () => {
    const longResponse = 'x'.repeat(20)
    const { ctx } = buildContext(
      'blackboard',
      [buildResolved('a1', { response: longResponse })],
      {
        policies: {
          memory: {
            tier: 'ephemeral',
            shareAcrossParticipants: true,
            blackboardContext: {
              maxSerializedChars: 100,
              maxEntryChars: 5,
              overflowBehavior: 'reject',
            },
          },
        },
      },
    )

    const result = await blackboardPattern.execute(ctx)
    const entry = result.agentResults[0]!
    expect(entry.success).toBe(false)
    expect(entry.error).toMatch(/exceeds maxEntryChars/)
  })
})
