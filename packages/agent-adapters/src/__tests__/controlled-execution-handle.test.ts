import { describe, expect, it } from 'vitest'
import { createControlledExecutionHandle } from '../controlled-execution/create-controlled-handle.js'
import type { AgentEvent, AgentInput } from '../types.js'

describe('controlled execution handle', () => {
  it('completes eagerly even when events are not consumed', async () => {
    const handle = createControlledExecutionHandle({
      providerId: 'claude', backend: 'cli', input: { prompt: 'hello' },
      execute: async function* (input: AgentInput): AsyncGenerator<AgentEvent> {
        yield { type: 'adapter:completed', providerId: 'claude', sessionId: 's1', result: input.prompt, durationMs: 1, timestamp: Date.now() }
      },
    })
    await expect(handle.completion).resolves.toMatchObject({ status: 'succeeded', backend: 'cli', output: 'hello' })
  })

  it('waits for terminal cancellation and preserves the operator reason', async () => {
    const handle = createControlledExecutionHandle({
      providerId: 'claude', backend: 'cli', input: { prompt: 'hello' },
      execute: async function* (input: AgentInput): AsyncGenerator<AgentEvent> {
        await new Promise<void>((resolve) => input.signal?.addEventListener('abort', () => resolve(), { once: true }))
        yield { type: 'adapter:failed', providerId: 'claude', error: 'aborted', code: 'AGENT_ABORTED', timestamp: Date.now() }
      },
    })
    await handle.cancel('operator requested')
    await expect(handle.completion).resolves.toMatchObject({ status: 'cancelled', metadata: { cancelReason: 'operator requested' } })
  })
})

