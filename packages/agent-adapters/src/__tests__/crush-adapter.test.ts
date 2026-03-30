import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ForgeError } from '@dzipagent/core'

import { CrushAdapter } from '../crush/crush-adapter.js'
import { collectEvents, getProcessHelperMocks } from './test-helpers.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn(),
  spawnAndStreamJsonl: vi.fn(),
}))

describe('CrushAdapter', () => {
  const { mockIsBinaryAvailable, mockSpawnAndStreamJsonl } = getProcessHelperMocks()

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
      yield { event: 'message', text: 'working' }
      yield { type: 'tool_call', name: 'bash', input: { cmd: 'pwd' } }
      yield { type: 'tool_result', name: 'bash', output: 'ok', durationMs: 9 }
      yield { type: 'completed', output: 'local result', duration_ms: 7 }
    })

    const adapter = new CrushAdapter({
      model: 'q4',
      providerOptions: {
        quantization: 'q4_k_m',
        gpuLayers: 24,
        contextSize: '8192',
      },
    })
    const events = await collectEvents(adapter.execute({ prompt: 'build', maxTurns: 1 }))

    expect(events.map((e) => e.type)).toEqual([
      'adapter:started',
      'adapter:message',
      'adapter:tool_call',
      'adapter:tool_result',
      'adapter:completed',
    ])
    const toolCall = events.find((e) => e.type === 'adapter:tool_call')
    expect(toolCall).toBeDefined()
    if (toolCall?.type === 'adapter:tool_call') {
      expect(toolCall.toolName).toBe('bash')
      expect(toolCall.input).toEqual({ cmd: 'pwd' })
    }
    const toolResult = events.find((e) => e.type === 'adapter:tool_result')
    expect(toolResult).toBeDefined()
    if (toolResult?.type === 'adapter:tool_result') {
      expect(toolResult.toolName).toBe('bash')
      expect(toolResult.output).toBe('ok')
      expect(toolResult.durationMs).toBe(9)
    }
    const completed = events.find((e) => e.type === 'adapter:completed')
    expect(completed?.type).toBe('adapter:completed')
    if (completed?.type === 'adapter:completed') {
      expect(completed.providerId).toBe('crush')
      expect(completed.result).toBe('local result')
    }

    const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).toContain('--model')
    expect(args).toContain('q4')
    expect(args).toContain('--quantization')
    expect(args).toContain('q4_k_m')
    expect(args).toContain('--gpu-layers')
    expect(args).toContain('24')
    expect(args).toContain('--context-size')
    expect(args).toContain('8192')
  })

  it('ignores invalid provider options when building args', async () => {
    mockIsBinaryAvailable.mockResolvedValue(true)
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed', result: 'ok' }
    })

    const adapter = new CrushAdapter({
      providerOptions: {
        quantization: '   ',
        gpuLayers: -1,
        contextSize: 'bad',
      },
    })
    await collectEvents(adapter.execute({ prompt: 'hello' }))

    const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).not.toContain('--quantization')
    expect(args).not.toContain('--gpu-layers')
    expect(args).not.toContain('--context-size')
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

  it('emits fallback adapter:completed when provider stream has no completed record', async () => {
    mockIsBinaryAvailable.mockResolvedValue(true)
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'message', content: 'still running' }
    })

    const adapter = new CrushAdapter()
    const events = await collectEvents(adapter.execute({ prompt: 'x' }))

    expect(events.map((e) => e.type)).toEqual([
      'adapter:started',
      'adapter:message',
      'adapter:completed',
    ])
    const completed = events[events.length - 1]
    expect(completed?.type).toBe('adapter:completed')
    if (completed?.type === 'adapter:completed') {
      expect(completed.result).toBe('')
      expect(completed.durationMs).toBeGreaterThanOrEqual(0)
    }
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
