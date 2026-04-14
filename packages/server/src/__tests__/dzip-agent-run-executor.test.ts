import { describe, it, expect } from 'vitest'
import { InMemoryRunStore, ModelRegistry, createEventBus } from '@dzupagent/core'
import { createDzupAgentRunExecutor } from '../runtime/dzip-agent-run-executor.js'
import type { RunExecutionContext } from '../runtime/run-worker.js'

function baseContext(overrides?: Partial<RunExecutionContext>): RunExecutionContext {
  return {
    runId: 'run-1',
    agentId: 'agent-1',
    input: { message: 'hello' },
    metadata: {},
    agent: {
      id: 'agent-1',
      name: 'Agent 1',
      instructions: 'You are helpful',
      modelTier: 'chat',
    },
    runStore: new InMemoryRunStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    ...overrides,
  }
}

describe('dzip-agent-run-executor', () => {
  it('uses structured fallback result when DzupAgent execution fails', async () => {
    const executor = createDzupAgentRunExecutor({
      fallback: async () => ({
        output: { message: 'fallback' },
        tokenUsage: { input: 1, output: 2 },
        metadata: { source: 'fallback' },
      }),
    })

    const result = await executor(baseContext())

    expect(result).toEqual({
      output: { message: 'fallback' },
      tokenUsage: { input: 1, output: 2 },
      metadata: {
        source: 'fallback',
        fallbackUsed: true,
        fallbackReason: expect.any(String),
      },
    })
  })

  it('wraps plain fallback output into structured result', async () => {
    const executor = createDzupAgentRunExecutor({
      fallback: async () => ({ message: 'plain-fallback' }),
    })

    const result = await executor(baseContext())

    expect(result.output).toEqual({ message: 'plain-fallback' })
    expect(result.metadata?.['fallbackUsed']).toBe(true)
    expect(typeof result.metadata?.['fallbackReason']).toBe('string')
  })
})
