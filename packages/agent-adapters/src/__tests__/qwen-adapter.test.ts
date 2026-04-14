import { describe, it, expect, vi, beforeEach } from 'vitest'

import { QwenAdapter } from '../qwen/qwen-adapter.js'
import { ForgeError } from '@dzupagent/core'
import { collectEvents, getProcessHelperMocks } from './test-helpers.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn(),
  spawnAndStreamJsonl: vi.fn(),
}))

describe('QwenAdapter', () => {
  const { mockIsBinaryAvailable, mockSpawnAndStreamJsonl } = getProcessHelperMocks()

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
      yield { type: 'tool_call', tool: { name: 'search', arguments: { query: 'dzip' } } }
      yield { type: 'tool_result', tool_result: { name: 'search', result: { hits: 2 }, durationMs: 21 } }
      yield { type: 'stream_delta', text: 'partial' }
      yield {
        type: 'completed',
        content: 'done',
        durationMs: 12,
        usage: {
          input_tokens: 120,
          output_tokens: 45,
          cached_input_tokens: 15,
          cost_cents: 9.5,
        },
      }
    })

    const adapter = new QwenAdapter({ apiKey: 'k1' })
    const events = await collectEvents(adapter.execute({ prompt: 'hello', maxTurns: 2 }))

    expect(events.map((e) => e.type)).toEqual([
      'adapter:started',
      'adapter:message',
      'adapter:tool_call',
      'adapter:tool_result',
      'adapter:stream_delta',
      'adapter:completed',
    ])
    const toolCall = events.find((e) => e.type === 'adapter:tool_call')
    expect(toolCall).toBeDefined()
    if (toolCall?.type === 'adapter:tool_call') {
      expect(toolCall.toolName).toBe('search')
      expect(toolCall.input).toEqual({ query: 'dzip' })
    }
    const toolResult = events.find((e) => e.type === 'adapter:tool_result')
    expect(toolResult).toBeDefined()
    if (toolResult?.type === 'adapter:tool_result') {
      expect(toolResult.toolName).toBe('search')
      expect(toolResult.output).toBe('{"hits":2}')
      expect(toolResult.durationMs).toBe(21)
    }
    const completed = events.find((e) => e.type === 'adapter:completed')
    expect(completed).toBeDefined()
    if (completed?.type === 'adapter:completed') {
      expect(completed.providerId).toBe('qwen')
      expect(completed.result).toBe('done')
      expect(completed.usage).toEqual({
        inputTokens: 120,
        outputTokens: 45,
        cachedInputTokens: 15,
        costCents: 9.5,
      })
    }

    expect(mockSpawnAndStreamJsonl).toHaveBeenCalled()
    const [, args, opts] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).toContain('--prompt')
    expect(args).toContain('hello')
    expect(args).toContain('--max-turns')
    expect((opts as { env?: Record<string, string> }).env?.['DASHSCOPE_API_KEY']).toBe('k1')
  })

  it('ignores malformed records without type or event fields', async () => {
    mockIsBinaryAvailable.mockResolvedValue(true)
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { content: { text: 'ignored' }, payload: 'no-type' }
      yield { type: 'completed', output: { text: 'done' }, duration_ms: 9 }
    })

    const adapter = new QwenAdapter()
    const events = await collectEvents(adapter.execute({ prompt: 'x' }))

    expect(events.map((e) => e.type)).toEqual([
      'adapter:started',
      'adapter:completed',
    ])
    const completed = events[1]
    expect(completed?.type).toBe('adapter:completed')
    if (completed?.type === 'adapter:completed') {
      expect(completed.result).toBe('done')
    }
  })

  it('normalizes nested error payloads and mixed result shapes', async () => {
    mockIsBinaryAvailable.mockResolvedValue(true)
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'error', error: 'string failure' }
      yield { event: 'error', error: { error: { message: 'deep failure', code: 'QWEN_DEEP' } } }
      yield {
        type: 'tool_result',
        function_response: {
          name: 'search',
          output: { hits: 2 },
          durationMs: 11,
        },
      }
      yield { type: 'completed', output: { text: 'done' }, duration_ms: 12 }
    })

    const adapter = new QwenAdapter()
    const events = await collectEvents(adapter.execute({ prompt: 'x' }))

    expect(events.map((e) => e.type)).toEqual([
      'adapter:started',
      'adapter:failed',
      'adapter:failed',
      'adapter:tool_result',
      'adapter:completed',
    ])

    const firstFailed = events[1]
    expect(firstFailed?.type).toBe('adapter:failed')
    if (firstFailed?.type === 'adapter:failed') {
      expect(firstFailed.error).toBe('string failure')
    }

    const secondFailed = events[2]
    expect(secondFailed?.type).toBe('adapter:failed')
    if (secondFailed?.type === 'adapter:failed') {
      expect(secondFailed.error).toBe('deep failure')
      expect(secondFailed.code).toBe('QWEN_DEEP')
    }

    const toolResult = events[3]
    expect(toolResult?.type).toBe('adapter:tool_result')
    if (toolResult?.type === 'adapter:tool_result') {
      expect(toolResult.toolName).toBe('search')
      expect(toolResult.output).toBe('{"hits":2}')
      expect(toolResult.durationMs).toBe(11)
    }

    const completed = events[4]
    expect(completed?.type).toBe('adapter:completed')
    if (completed?.type === 'adapter:completed') {
      expect(completed.result).toBe('done')
      expect(completed.durationMs).toBe(12)
    }
  })

  it('maps usage from alternate tokenUsage shape on completion', async () => {
    mockIsBinaryAvailable.mockResolvedValue(true)
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield {
        type: 'completed',
        output: 'done',
        duration_ms: 18,
        tokenUsage: {
          promptTokens: 64,
          completionTokens: 12,
        },
      }
    })

    const adapter = new QwenAdapter()
    const events = await collectEvents(adapter.execute({ prompt: 'x' }))

    const completed = events[1]
    expect(completed?.type).toBe('adapter:completed')
    if (completed?.type === 'adapter:completed') {
      expect(completed.usage).toEqual({
        inputTokens: 64,
        outputTokens: 12,
      })
    }
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

  it('emits fallback adapter:completed when provider stream has no completed record', async () => {
    mockIsBinaryAvailable.mockResolvedValue(true)
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'message', content: 'still running' }
    })

    const adapter = new QwenAdapter()
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

  it('does not emit synthetic adapter:completed after provider adapter:failed event', async () => {
    mockIsBinaryAvailable.mockResolvedValue(true)
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'error', error: { message: 'provider failure', code: 'QWEN_ERR' } }
    })

    const adapter = new QwenAdapter()
    const events = await collectEvents(adapter.execute({ prompt: 'x' }))

    expect(events.map((e) => e.type)).toEqual([
      'adapter:started',
      'adapter:failed',
    ])
  })

  it('maps sandbox mode to --sandbox value', async () => {
    mockIsBinaryAvailable.mockResolvedValue(true)
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed', result: 'ok' }
    })

    const adapter = new QwenAdapter({ sandboxMode: 'workspace-write' })
    await collectEvents(adapter.execute({ prompt: 'x' }))

    const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).toContain('--sandbox')
    expect(args).toContain('workspace')
  })

  it('maps sandbox read-only mode to sandbox value', async () => {
    mockIsBinaryAvailable.mockResolvedValue(true)
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed', result: 'ok' }
    })

    const adapter = new QwenAdapter({ sandboxMode: 'read-only' })
    await collectEvents(adapter.execute({ prompt: 'x' }))

    const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).toContain('--sandbox')
    expect(args).toContain('sandbox')
  })

  it('maps sandbox full-access mode to none value', async () => {
    mockIsBinaryAvailable.mockResolvedValue(true)
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed', result: 'ok' }
    })

    const adapter = new QwenAdapter({ sandboxMode: 'full-access' })
    await collectEvents(adapter.execute({ prompt: 'x' }))

    const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).toContain('--sandbox')
    expect(args).toContain('none')
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
