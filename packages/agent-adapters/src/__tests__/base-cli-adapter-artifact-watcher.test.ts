import { describe, it, expect, vi, beforeEach } from 'vitest'

import { BaseCliAdapter } from '../base/base-cli-adapter.js'
import type { AgentEvent, AgentInput } from '../types.js'
import { collectEvents, getProcessHelperMocks } from './test-helpers.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn().mockResolvedValue(true),
  spawnAndStreamJsonl: vi.fn(),
}))

/**
 * Minimal concrete BaseCliAdapter used to exercise the run lifecycle. Maps
 * the handful of stream records it cares about into AgentEvents so tests can
 * simulate success, failure, and cancellation paths.
 */
class TestCliAdapter extends BaseCliAdapter {
  constructor() {
    super('claude')
  }
  protected getBinaryName(): string {
    return 'test-bin'
  }
  protected buildArgs(): string[] {
    return []
  }
  protected mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string,
  ): AgentEvent | undefined {
    if (record['type'] === 'completed') {
      return {
        type: 'adapter:completed',
        providerId: this.providerId,
        sessionId,
        result: 'ok',
        durationMs: 0,
        timestamp: Date.now(),
      }
    }
    if (record['type'] === 'failed') {
      return {
        type: 'adapter:failed',
        providerId: this.providerId,
        sessionId,
        error: 'provider failure',
        timestamp: Date.now(),
      }
    }
    return undefined
  }
}

describe('BaseCliAdapter ArtifactWatcher lifecycle', () => {
  const { mockSpawnAndStreamJsonl } = getProcessHelperMocks()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts a watcher on run begin and stops it when the run completes', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed' }
    })

    const stop = vi.fn()
    const factory = vi.fn(() => ({ stop }))

    const adapter = new TestCliAdapter()
    adapter.setArtifactWatcherFactory(factory)

    const input: AgentInput = { prompt: 'hello', workingDirectory: '/tmp/work' }
    const events = await collectEvents(adapter.execute(input))

    expect(events.map((e) => e.type)).toContain('adapter:started')
    expect(factory).toHaveBeenCalledTimes(1)
    const [paths, providerId] = factory.mock.calls[0]!
    expect(providerId).toBe('claude')
    expect(paths).toEqual(
      expect.arrayContaining([expect.stringContaining('.claude')]),
    )
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('stops the watcher even when the provider run fails', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'failed' }
    })

    const stop = vi.fn()
    const factory = vi.fn(() => ({ stop }))

    const adapter = new TestCliAdapter()
    adapter.setArtifactWatcherFactory(factory)

    const events = await collectEvents(adapter.execute({ prompt: 'x' }))

    expect(events.some((e) => e.type === 'adapter:failed')).toBe(true)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('stops the watcher when the spawn throws (unexpected error path)', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      throw new Error('boom')
    })

    const stop = vi.fn()
    const factory = vi.fn(() => ({ stop }))

    const adapter = new TestCliAdapter()
    adapter.setArtifactWatcherFactory(factory)

    const events = await collectEvents(adapter.execute({ prompt: 'x' }))

    expect(events.map((e) => e.type)).toEqual(['adapter:started', 'adapter:failed'])
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when no watcher factory has been wired', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed' }
    })

    const adapter = new TestCliAdapter()
    // Deliberately do not wire a factory — integration must remain a no-op.

    await expect(collectEvents(adapter.execute({ prompt: 'x' }))).resolves.toBeDefined()
  })
})
