import { describe, it, expect, vi, beforeEach } from 'vitest'

import { GooseAdapter } from '../goose/goose-adapter.js'
import { collectEvents, getProcessHelperMocks } from './test-helpers.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn(),
  spawnAndStreamJsonl: vi.fn(),
}))

describe('GooseAdapter', () => {
  const { mockIsBinaryAvailable, mockSpawnAndStreamJsonl } = getProcessHelperMocks()

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsBinaryAvailable.mockResolvedValue(true)
  })

  it('getBinaryName returns goose', () => {
    const adapter = new GooseAdapter()
    // Verify via healthCheck which uses getBinaryName internally
    mockIsBinaryAvailable.mockResolvedValue(true)
    void adapter.healthCheck().then((status) => {
      expect(status.healthy).toBe(true)
    })
    expect(mockIsBinaryAvailable).toHaveBeenCalledWith('goose')
  })

  it('buildArgs includes --headless --output-format jsonl', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed', result: 'done', duration_ms: 10 }
    })

    const adapter = new GooseAdapter()
    await collectEvents(adapter.execute({ prompt: 'hello' }))

    const [binary, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(binary).toBe('goose')
    expect(args).toContain('run')
    expect(args).toContain('--headless')
    expect(args).toContain('--output-format')
    expect(args).toContain('jsonl')
    expect(args).toContain('--prompt')
    expect(args).toContain('hello')
  })

  it('buildArgs includes --recipe when provided', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed', result: 'done', duration_ms: 10 }
    })

    const adapter = new GooseAdapter()
    await collectEvents(
      adapter.execute({
        prompt: 'test',
        options: { recipe: 'code-review' },
      }),
    )

    const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).toContain('--recipe')
    expect(args).toContain('code-review')
  })

  it('buildArgs includes --permission-mode when provided', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed', result: 'done', duration_ms: 10 }
    })

    const adapter = new GooseAdapter()
    await collectEvents(
      adapter.execute({
        prompt: 'test',
        options: { permissionMode: 'sandbox' },
      }),
    )

    const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).toContain('--permission-mode')
    expect(args).toContain('sandbox')
  })

  it('buildArgs includes --system when systemPrompt is set', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed', result: 'done', duration_ms: 10 }
    })

    const adapter = new GooseAdapter()
    await collectEvents(
      adapter.execute({
        prompt: 'test',
        systemPrompt: 'you are a helpful assistant',
      }),
    )

    const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).toContain('--system')
    expect(args).toContain('you are a helpful assistant')
  })

  it('buildArgs includes --max-turns when maxTurns is set', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed', result: 'done', duration_ms: 10 }
    })

    const adapter = new GooseAdapter()
    await collectEvents(
      adapter.execute({ prompt: 'test', maxTurns: 5 }),
    )

    const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).toContain('--max-turns')
    expect(args).toContain('5')
  })

  it('buildArgs includes --working-directory when set', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed', result: 'done', duration_ms: 10 }
    })

    const adapter = new GooseAdapter()
    await collectEvents(
      adapter.execute({ prompt: 'test', workingDirectory: '/tmp/project' }),
    )

    const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).toContain('--working-directory')
    expect(args).toContain('/tmp/project')
  })

  it('buildArgs includes --session for resume', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'completed', result: 'done', duration_ms: 10 }
    })

    const adapter = new GooseAdapter()
    await collectEvents(
      adapter.resumeSession('sess-abc', { prompt: 'continue' }),
    )

    const [, args] = mockSpawnAndStreamJsonl.mock.calls[0]!
    expect(args).toContain('--session')
    expect(args).toContain('sess-abc')
  })

  describe('mapProviderEvent', () => {
    it('handles message events', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'message', role: 'assistant', content: 'Starting analysis...' }
        yield { type: 'completed', result: 'done', duration_ms: 10 }
      })

      const adapter = new GooseAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      const message = events.find((e) => e.type === 'adapter:message')
      expect(message).toBeDefined()
      if (message?.type === 'adapter:message') {
        expect(message.content).toBe('Starting analysis...')
        expect(message.role).toBe('assistant')
      }
    })

    it('handles response event type as message', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'response', text: 'response text' }
        yield { type: 'completed', result: 'done', duration_ms: 10 }
      })

      const adapter = new GooseAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      const message = events.find((e) => e.type === 'adapter:message')
      expect(message).toBeDefined()
      if (message?.type === 'adapter:message') {
        expect(message.content).toBe('response text')
        expect(message.role).toBe('assistant')
      }
    })

    it('handles tool_call events', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'tool_call', tool: { name: 'read_file', arguments: { path: 'src/main.ts' } } }
        yield { type: 'completed', result: 'done', duration_ms: 10 }
      })

      const adapter = new GooseAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      const toolCall = events.find((e) => e.type === 'adapter:tool_call')
      expect(toolCall).toBeDefined()
      if (toolCall?.type === 'adapter:tool_call') {
        expect(toolCall.toolName).toBe('read_file')
        expect(toolCall.input).toEqual({ path: 'src/main.ts' })
      }
    })

    it('handles function_call event type', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'function_call', function_call: { name: 'search', arguments: { q: 'test' } } }
        yield { type: 'completed', result: 'done', duration_ms: 10 }
      })

      const adapter = new GooseAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      const toolCall = events.find((e) => e.type === 'adapter:tool_call')
      expect(toolCall).toBeDefined()
      if (toolCall?.type === 'adapter:tool_call') {
        expect(toolCall.toolName).toBe('search')
        expect(toolCall.input).toEqual({ q: 'test' })
      }
    })

    it('handles tool_result events', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'tool_result', tool_result: { name: 'read_file', output: 'file contents', duration_ms: 50 } }
        yield { type: 'completed', result: 'done', duration_ms: 10 }
      })

      const adapter = new GooseAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      const toolResult = events.find((e) => e.type === 'adapter:tool_result')
      expect(toolResult).toBeDefined()
      if (toolResult?.type === 'adapter:tool_result') {
        expect(toolResult.toolName).toBe('read_file')
        expect(toolResult.output).toBe('file contents')
        expect(toolResult.durationMs).toBe(50)
      }
    })

    it('handles completed events', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', result: 'Analysis complete', duration_ms: 2500 }
      })

      const adapter = new GooseAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      const completed = events.find((e) => e.type === 'adapter:completed')
      expect(completed).toBeDefined()
      if (completed?.type === 'adapter:completed') {
        expect(completed.result).toBe('Analysis complete')
        expect(completed.durationMs).toBe(2500)
      }
    })

    it('handles done event type as completed', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'done', output: 'Finished', elapsed_ms: 1200 }
      })

      const adapter = new GooseAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      const completed = events.find((e) => e.type === 'adapter:completed')
      expect(completed).toBeDefined()
      if (completed?.type === 'adapter:completed') {
        expect(completed.result).toBe('Finished')
        expect(completed.durationMs).toBe(1200)
      }
    })

    it('handles error events', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'error', error: { message: 'Permission denied', code: 'EPERM' } }
      })

      const adapter = new GooseAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      const failed = events.find((e) => e.type === 'adapter:failed')
      expect(failed).toBeDefined()
      if (failed?.type === 'adapter:failed') {
        expect(failed.error).toBe('Permission denied')
        expect(failed.code).toBe('EPERM')
      }
    })

    it('handles stream_delta events', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'stream_delta', content: 'partial output' }
        yield { type: 'completed', result: 'done', duration_ms: 10 }
      })

      const adapter = new GooseAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      const delta = events.find((e) => e.type === 'adapter:stream_delta')
      expect(delta).toBeDefined()
      if (delta?.type === 'adapter:stream_delta') {
        expect(delta.content).toBe('partial output')
      }
    })

    it('handles delta event type as stream_delta', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'delta', delta: 'chunk' }
        yield { type: 'completed', result: 'done', duration_ms: 10 }
      })

      const adapter = new GooseAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      const delta = events.find((e) => e.type === 'adapter:stream_delta')
      expect(delta).toBeDefined()
      if (delta?.type === 'adapter:stream_delta') {
        expect(delta.content).toBe('chunk')
      }
    })

    it('skips empty stream_delta content', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'stream_delta' }
        yield { type: 'completed', result: 'done', duration_ms: 10 }
      })

      const adapter = new GooseAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      expect(events.map((e) => e.type)).not.toContain('adapter:stream_delta')
    })

    it('skips unknown event types', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'heartbeat', timestamp: 12345 }
        yield { type: 'completed', result: 'done', duration_ms: 10 }
      })

      const adapter = new GooseAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      expect(events.map((e) => e.type)).toEqual([
        'adapter:started',
        'adapter:completed',
      ])
    })
  })

  it('maps full stream into adapter events', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'message', role: 'assistant', content: 'Starting analysis...' }
      yield { type: 'tool_call', tool: { name: 'read_file', arguments: { path: 'src/main.ts' } } }
      yield { type: 'tool_result', tool_result: { name: 'read_file', output: 'file contents', duration_ms: 50 } }
      yield { type: 'completed', result: 'Analysis complete', duration_ms: 2500 }
    })

    const adapter = new GooseAdapter()
    const events = await collectEvents(adapter.execute({ prompt: 'analyze code' }))

    expect(events.map((e) => e.type)).toEqual([
      'adapter:started',
      'adapter:message',
      'adapter:tool_call',
      'adapter:tool_result',
      'adapter:completed',
    ])
  })

  it('getCapabilities returns correct profile', () => {
    const adapter = new GooseAdapter()
    expect(adapter.getCapabilities()).toEqual({
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: false,
    })
  })

  it('healthCheck delegates to binary check', async () => {
    mockIsBinaryAvailable.mockResolvedValue(true)
    const adapter = new GooseAdapter()

    const status = await adapter.healthCheck()

    expect(mockIsBinaryAvailable).toHaveBeenCalledWith('goose')
    expect(status.healthy).toBe(true)
    expect(status.cliAvailable).toBe(true)
    expect(status.sdkInstalled).toBe(true)
  })

  it('healthCheck reports unhealthy when binary is missing', async () => {
    mockIsBinaryAvailable.mockResolvedValue(false)
    const adapter = new GooseAdapter()

    const status = await adapter.healthCheck()

    expect(status.healthy).toBe(false)
    expect(status.cliAvailable).toBe(false)
    expect(status.lastError).toContain('goose')
  })

  it('emits fallback adapter:completed when provider stream has no completed record', async () => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'message', content: 'still running' }
    })

    const adapter = new GooseAdapter()
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
      yield { type: 'error', error: { message: 'provider failure', code: 'GOOSE_ERR' } }
    })

    const adapter = new GooseAdapter()
    const events = await collectEvents(adapter.execute({ prompt: 'x' }))

    expect(events.map((e) => e.type)).toEqual([
      'adapter:started',
      'adapter:failed',
    ])
  })
})
