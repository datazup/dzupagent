import { describe, expect, it, vi } from 'vitest'
import { launchDaemon } from '../agent/daemon-launcher.js'
import type { GenerateResult } from '../agent/agent-types.js'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function result(content: string): GenerateResult {
  return {
    content,
    messages: [],
    usage: {
      totalInputTokens: 1,
      totalOutputTokens: 1,
      llmCalls: 1,
    },
    hitIterationLimit: false,
    stopReason: 'complete',
    toolStats: [],
  }
}

describe('launchDaemon legacy control characterization', () => {
  it('pause changes handle state but does not stop background completion', async () => {
    const generation = deferred<GenerateResult>()
    const generate = vi.fn(() => generation.promise)
    const handle = await launchDaemon({ agentId: 'agent-1', generate }, [], {
      runId: 'run-pause',
    })

    await handle.pause()
    expect(handle.currentStatus).toBe('paused')
    expect(handle.controlCapabilities.pause).toBe('handle-state-only')

    generation.resolve(result('completed while handle was paused'))

    await expect(handle.result()).resolves.toMatchObject({
      status: 'completed',
      output: 'completed while handle was paused',
    })
    expect(generate).toHaveBeenCalledOnce()
  })

  it('cancel resolves the handle but does not abort background generation', async () => {
    const generation = deferred<GenerateResult>()
    let backgroundSettled = false
    const generate = vi.fn(async () => {
      const generated = await generation.promise
      backgroundSettled = true
      return generated
    })
    const handle = await launchDaemon({ agentId: 'agent-1', generate }, [], {
      runId: 'run-cancel',
    })

    await handle.cancel('operator request')
    await expect(handle.result()).resolves.toMatchObject({
      status: 'cancelled',
      error: 'operator request',
    })
    expect(handle.controlCapabilities.cancel).toBe('handle-state-only')

    generation.resolve(result('late output'))
    await vi.waitFor(() => expect(backgroundSettled).toBe(true))

    expect(handle.currentStatus).toBe('cancelled')
    expect(generate).toHaveBeenCalledOnce()
  })
})
