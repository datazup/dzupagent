import { describe, it, expect, vi, beforeEach } from 'vitest'

import { GeminiCLIAdapter } from '../gemini/gemini-adapter.js'
import { ForgeError } from '@dzupagent/core'
import { collectEvents, getProcessHelperMocks } from './test-helpers.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn().mockResolvedValue(true),
  spawnAndStreamJsonl: vi.fn(),
}))

describe('GeminiCLIAdapter', () => {
  const { mockSpawnAndStreamJsonl } = getProcessHelperMocks()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps stream records into adapter events', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { event: 'message', text: 'hello' }
      yield { type: 'function_call', tool: { name: 'search', input: { query: 'dzip' } } }
      yield { type: 'function_response', function_response: { name: 'search', result: { hits: 2 }, durationMs: 11 } }
      yield { type: 'stream_delta', text: 'partial' }
      yield { type: 'completed', output: 'done', durationMs: 12 }
    })

    const adapter = new GeminiCLIAdapter({ model: 'gemini-2.5-pro' })
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
      expect(toolResult.durationMs).toBe(11)
    }

    const completed = events.find((e) => e.type === 'adapter:completed')
    expect(completed).toBeDefined()
    if (completed?.type === 'adapter:completed') {
      expect(completed.providerId).toBe('gemini')
      expect(completed.result).toBe('done')
    }

    expect(mockSpawnAndStreamJsonl).toHaveBeenCalled()
    const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).toContain('--model')
    expect(args).toContain('gemini-2.5-pro')
    expect(args).toContain('--max-turns')
    expect(args).toContain('2')
  })

  it('handles malformed and mixed Gemini records deterministically', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { payload: 'ignored' }
      yield { event: 'message', text: { parts: ['hello from gemini'] } }
      yield { type: 'function_call', tool: { name: 'search', input: { query: 'dzip' } } }
      yield { type: 'function_response', function_response: { name: 'search', content: { hits: 2 }, durationMs: 11 } }
      yield { type: 'error', error: { cause: { message: 'nested failure', code: 'GEMINI_NESTED' } } }
      yield { type: 'completed', output: { text: 'gemini recovered', meta: { ok: true } }, duration_ms: 33 }
    })

    const adapter = new GeminiCLIAdapter()
    const events = await collectEvents(adapter.execute({ prompt: 'x' }))

    expect(events.map((e) => e.type)).toEqual([
      'adapter:started',
      'adapter:message',
      'adapter:tool_call',
      'adapter:tool_result',
      'adapter:failed',
      'adapter:completed',
    ])

    const message = events.find((e) => e.type === 'adapter:message')
    expect(message).toBeDefined()
    if (message?.type === 'adapter:message') {
      expect(message.content).toBe('{"parts":["hello from gemini"]}')
    }

    const toolResult = events.find((e) => e.type === 'adapter:tool_result')
    expect(toolResult).toBeDefined()
    if (toolResult?.type === 'adapter:tool_result') {
      expect(toolResult.output).toBe('{"hits":2}')
      expect(toolResult.durationMs).toBe(11)
    }

    const failed = events.find((e) => e.type === 'adapter:failed')
    expect(failed).toBeDefined()
    if (failed?.type === 'adapter:failed') {
      expect(failed.error).toBe('nested failure')
      expect(failed.code).toBe('GEMINI_NESTED')
    }

    const completed = events.find((e) => e.type === 'adapter:completed')
    expect(completed).toBeDefined()
    if (completed?.type === 'adapter:completed') {
      expect(completed.result).toBe('{"text":"gemini recovered","meta":{"ok":true}}')
      expect(completed.durationMs).toBe(33)
    }
  })

  it('emits adapter:failed and does not rethrow for non-Forge errors', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      throw new Error('boom')
    })

    const adapter = new GeminiCLIAdapter()
    const events = await collectEvents(adapter.execute({ prompt: 'x' }))

    expect(events.map((e) => e.type)).toEqual(['adapter:started', 'adapter:failed'])
    const failed = events[1]
    expect(failed?.type).toBe('adapter:failed')
    if (failed?.type === 'adapter:failed') {
      expect(failed.error).toBe('boom')
    }
  })

  it('rethrows ForgeError after emitting adapter:failed', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      throw new ForgeError({
        code: 'ADAPTER_TIMEOUT',
        message: 'timeout',
        recoverable: true,
      })
    })

    const adapter = new GeminiCLIAdapter()
    await expect(collectEvents(adapter.execute({ prompt: 'x' }))).rejects.toMatchObject({
      code: 'ADAPTER_TIMEOUT',
    })
  })

  it('maps sandbox mode to --sandbox value', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed', result: 'ok' }
    })

    const adapter = new GeminiCLIAdapter({ sandboxMode: 'workspace-write' })
    await collectEvents(adapter.execute({ prompt: 'x' }))

    const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).toContain('--sandbox')
    expect(args).toContain('workspace')
  })

  it('emits fallback adapter:completed when provider stream has no completed record', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'message', content: 'still running' }
    })

    const adapter = new GeminiCLIAdapter()
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
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'error', error: { message: 'provider failure', code: 'GEMINI_ERR' } }
    })

    const adapter = new GeminiCLIAdapter()
    const events = await collectEvents(adapter.execute({ prompt: 'x' }))

    expect(events.map((e) => e.type)).toEqual([
      'adapter:started',
      'adapter:failed',
    ])
  })
})
