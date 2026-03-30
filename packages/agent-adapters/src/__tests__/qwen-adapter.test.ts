import { describe, it, expect, vi, beforeEach } from 'vitest'

import { QwenAdapter } from '../qwen/qwen-adapter.js'
import { ForgeError } from '@dzipagent/core'
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

describe('QwenAdapter', () => {
  const mockIsBinaryAvailable = vi.mocked(isBinaryAvailable)
  const mockSpawnAndStreamJsonl = vi.mocked(spawnAndStreamJsonl)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws ADAPTER_SDK_NOT_INSTALLED when qwen binary is missing', async () => {
    mockIsBinaryAvailable.mockResolvedValue(false)
    const adapter = new QwenAdapter()

    await expect(adapter.execute({ prompt: 'hello' }).next()).rejects.toMatchObject({
      code: 'ADAPTER_SDK_NOT_INSTALLED',
    })
  })

  it('maps stream records into adapter events', async () => {
    mockIsBinaryAvailable.mockResolvedValue(true)
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'message', content: 'hello' }
      yield { type: 'completed', result: 'done', duration_ms: 12 }
    })

    const adapter = new QwenAdapter({ apiKey: 'k1' })
    const events = await collectEvents(adapter.execute({ prompt: 'hello', maxTurns: 2 }))

    expect(events.map((e) => e.type)).toEqual(['adapter:started', 'adapter:message', 'adapter:completed'])
    const completed = events.find((e) => e.type === 'adapter:completed')
    expect(completed).toBeDefined()
    if (completed?.type === 'adapter:completed') {
      expect(completed.providerId).toBe('qwen')
      expect(completed.result).toBe('done')
    }

    expect(mockSpawnAndStreamJsonl).toHaveBeenCalled()
    const [, args, opts] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).toContain('--prompt')
    expect(args).toContain('hello')
    expect(args).toContain('--max-turns')
    expect((opts as { env?: Record<string, string> }).env?.['DASHSCOPE_API_KEY']).toBe('k1')
  })

  it('emits adapter:failed and does not rethrow for non-Forge errors', async () => {
    mockIsBinaryAvailable.mockResolvedValue(true)
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      throw new Error('boom')
    })

    const adapter = new QwenAdapter()
    const events = await collectEvents(adapter.execute({ prompt: 'x' }))

    expect(events.map((e) => e.type)).toEqual(['adapter:started', 'adapter:failed'])
    const failed = events[1]
    expect(failed?.type).toBe('adapter:failed')
    if (failed?.type === 'adapter:failed') {
      expect(failed.error).toBe('boom')
    }
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

    const adapter = new QwenAdapter()
    await expect(collectEvents(adapter.execute({ prompt: 'x' }))).rejects.toMatchObject({
      code: 'ADAPTER_TIMEOUT',
    })
  })

  it('exposes runtime capabilities', () => {
    const adapter = new QwenAdapter()
    expect(adapter.getCapabilities?.()).toEqual({
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: false,
    })
  })
})
