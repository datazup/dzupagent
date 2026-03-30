import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ForgeError } from '@dzipagent/core'

import { CrushAdapter } from '../crush/crush-adapter.js'
import type { AgentEvent } from '../types.js'
import { isBinaryAvailable, spawnAndStreamJsonl } from '../utils/process-helpers.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn(),
  spawnAndStreamJsonl: vi.fn(),
}))

async function collectEvents(gen: AsyncGenerator<AgentEvent, void, undefined>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of gen) {
    events.push(event)
  }
  return events
}

describe('CrushAdapter', () => {
  const mockIsBinaryAvailable = vi.mocked(isBinaryAvailable)
  const mockSpawnAndStreamJsonl = vi.mocked(spawnAndStreamJsonl)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws ADAPTER_SDK_NOT_INSTALLED when crush binary is missing', async () => {
    mockIsBinaryAvailable.mockResolvedValue(false)
    const adapter = new CrushAdapter()

    await expect(adapter.execute({ prompt: 'hello' }).next()).rejects.toMatchObject({
      code: 'ADAPTER_SDK_NOT_INSTALLED',
    })
  })

  it('maps completion records and includes started event', async () => {
    mockIsBinaryAvailable.mockResolvedValue(true)
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed', result: 'local result', duration_ms: 7 }
    })

    const adapter = new CrushAdapter({ model: 'q4' })
    const events = await collectEvents(adapter.execute({ prompt: 'build', maxTurns: 1 }))

    expect(events.map((e) => e.type)).toEqual(['adapter:started', 'adapter:completed'])
    const completed = events[1]
    expect(completed?.type).toBe('adapter:completed')
    if (completed?.type === 'adapter:completed') {
      expect(completed.providerId).toBe('crush')
      expect(completed.result).toBe('local result')
    }

    const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).toContain('--model')
    expect(args).toContain('q4')
  })

  it('emits adapter:failed and does not rethrow for non-Forge errors', async () => {
    mockIsBinaryAvailable.mockResolvedValue(true)
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      throw new Error('crush failed')
    })

    const adapter = new CrushAdapter()
    const events = await collectEvents(adapter.execute({ prompt: 'x' }))

    expect(events.map((e) => e.type)).toEqual(['adapter:started', 'adapter:failed'])
    const failed = events[1]
    expect(failed?.type).toBe('adapter:failed')
    if (failed?.type === 'adapter:failed') {
      expect(failed.error).toBe('crush failed')
    }
  })

  it('throws ADAPTER_SESSION_NOT_FOUND on resumeSession', async () => {
    const adapter = new CrushAdapter()

    await expect(collectEvents(adapter.resumeSession('sess', { prompt: 'resume' }))).rejects.toMatchObject({
      code: 'ADAPTER_SESSION_NOT_FOUND',
    })
  })

  it('rethrows ForgeError after emitting adapter:failed', async () => {
    mockIsBinaryAvailable.mockResolvedValue(true)
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      throw new ForgeError({
        code: 'ADAPTER_TIMEOUT',
        message: 'timeout',
        recoverable: true,
      })
    })

    const adapter = new CrushAdapter()
    await expect(collectEvents(adapter.execute({ prompt: 'x' }))).rejects.toMatchObject({
      code: 'ADAPTER_TIMEOUT',
    })
  })

  it('exposes runtime capabilities', () => {
    const adapter = new CrushAdapter()
    expect(adapter.getCapabilities?.()).toEqual({
      supportsResume: false,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: false,
    })
  })
})
