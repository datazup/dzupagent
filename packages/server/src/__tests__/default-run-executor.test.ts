import { describe, it, expect } from 'vitest'
import { InMemoryRunStore, ModelRegistry, createEventBus } from '@dzipagent/core'
import { createDefaultRunExecutor } from '../runtime/default-run-executor.js'

describe('default-run-executor', () => {
  it('returns deterministic fallback when model registry is not configured', async () => {
    const runStore = new InMemoryRunStore()
    const modelRegistry = new ModelRegistry()
    const run = await runStore.create({ agentId: 'a1', input: { message: 'hello' } })
    const execute = createDefaultRunExecutor(modelRegistry)

    const output = await execute({
      runId: run.id,
      agentId: 'a1',
      input: { message: 'hello' },
      agent: {
        id: 'a1',
        name: 'Agent One',
        instructions: 'You are helpful',
        modelTier: 'chat',
      },
      metadata: {},
      runStore,
      eventBus: createEventBus(),
      modelRegistry,
    })

    expect(output).toEqual({ message: '[Agent One] hello' })
  })
})
