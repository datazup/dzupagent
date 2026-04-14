import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ForgeError } from '@dzupagent/core'
import { collectEvents } from './test-helpers.js'
import type { AgentEvent, AgentInput } from '../types.js'

// ---------------------------------------------------------------------------
// SDK mock setup
// ---------------------------------------------------------------------------

/** Creates an async iterable from an array of messages. */
function asyncIterableOf<T>(items: T[]): AsyncIterable<T> & { interrupt: ReturnType<typeof vi.fn> } {
  const interruptFn = vi.fn()
  return {
    interrupt: interruptFn,
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        async next() {
          if (index < items.length) {
            return { value: items[index++], done: false as const }
          }
          return { value: undefined, done: true as const }
        },
      }
    },
  }
}

const mockQuery = vi.fn()
const mockListSessions = vi.fn()
const mockGetSessionInfo = vi.fn()

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
  listSessions: mockListSessions,
  getSessionInfo: mockGetSessionInfo,
}))

// Import after mock setup
const { ClaudeAgentAdapter } = await import('../claude/claude-adapter.js')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSystemMessage(sessionId = 'sess-123', model = 'claude-sonnet-4-20250514') {
  return { type: 'system' as const, session_id: sessionId, model, tools: [] }
}

function makeAssistantMessage(text: string) {
  return {
    type: 'assistant' as const,
    content: [{ type: 'text', text }],
  }
}

function makeToolProgressStarted(toolName: string, input: unknown = {}) {
  return {
    type: 'tool_progress' as const,
    tool_name: toolName,
    input,
    status: 'started' as const,
  }
}

function makeToolProgressCompleted(toolName: string, output: string, durationMs?: number) {
  return {
    type: 'tool_progress' as const,
    tool_name: toolName,
    output,
    status: 'completed' as const,
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
  }
}

function makeToolProgressFailed(toolName: string, output: string) {
  return {
    type: 'tool_progress' as const,
    tool_name: toolName,
    output,
    status: 'failed' as const,
  }
}

function makeStreamEvent(delta: string) {
  return { type: 'stream_event' as const, delta }
}

function makeResultSuccess(opts: {
  result?: string
  sessionId?: string
  usage?: Record<string, unknown>
  durationMs?: number
} = {}) {
  return {
    type: 'result' as const,
    subtype: 'success',
    result: opts.result ?? 'Done',
    session_id: opts.sessionId,
    usage: opts.usage,
    duration_ms: opts.durationMs,
  }
}

function makeResultError(opts: { error?: string; subtype?: string; sessionId?: string } = {}) {
  return {
    type: 'result' as const,
    subtype: opts.subtype ?? 'error_max_turns',
    error: opts.error,
    session_id: opts.sessionId,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeAgentAdapter', () => {
  let adapter: InstanceType<typeof ClaudeAgentAdapter>

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new ClaudeAgentAdapter()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -----------------------------------------------------------------------
  // getCapabilities
  // -----------------------------------------------------------------------

  describe('getCapabilities', () => {
    it('returns correct capability profile', () => {
      const caps = adapter.getCapabilities()

      expect(caps).toEqual({
        supportsResume: true,
        supportsFork: true,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsCostUsage: true,
      })
    })
  })

  // -----------------------------------------------------------------------
  // configure
  // -----------------------------------------------------------------------

  describe('configure', () => {
    it('merges partial config', async () => {
      adapter.configure({ model: 'claude-opus-4-20250514', timeoutMs: 60000 })
      adapter.configure({ workingDirectory: '/tmp' })

      // Verify the config is reflected in query options
      const messages = [makeSystemMessage(), makeResultSuccess()]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      // Execute to observe the query options
      await collectEvents(adapter.execute({ prompt: 'test' }))

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'test',
          options: expect.objectContaining({
            cwd: '/tmp',
          }),
        }),
      )
    })
  })

  // -----------------------------------------------------------------------
  // execute
  // -----------------------------------------------------------------------

  describe('execute', () => {
    it('emits started event with enriched fields', async () => {
      const messages = [
        makeSystemMessage('sess-abc', 'claude-sonnet-4-20250514'),
        makeResultSuccess({ result: 'ok', sessionId: 'sess-abc' }),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(
        adapter.execute({
          prompt: 'hello',
          systemPrompt: 'You are helpful',
          workingDirectory: '/project',
        }),
      )

      const started = events.find((e) => e.type === 'adapter:started')
      expect(started).toBeDefined()
      expect(started).toMatchObject({
        type: 'adapter:started',
        providerId: 'claude',
        sessionId: 'sess-abc',
        prompt: 'hello',
        systemPrompt: 'You are helpful',
        model: 'claude-sonnet-4-20250514',
        workingDirectory: '/project',
        isResume: false,
      })
    })

    it('uses config model over SDK model', async () => {
      const adapterWithModel = new ClaudeAgentAdapter({ model: 'claude-opus-4-20250514' })
      const messages = [
        makeSystemMessage('sess-1', 'claude-sonnet-4-20250514'),
        makeResultSuccess(),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapterWithModel.execute({ prompt: 'test' }))
      const started = events.find((e) => e.type === 'adapter:started') as Extract<
        AgentEvent,
        { type: 'adapter:started' }
      >
      expect(started.model).toBe('claude-opus-4-20250514')
    })

    it('emits message events for assistant responses', async () => {
      const messages = [
        makeSystemMessage(),
        makeAssistantMessage('Hello world'),
        makeResultSuccess(),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'hi' }))

      const msg = events.find((e) => e.type === 'adapter:message') as Extract<
        AgentEvent,
        { type: 'adapter:message' }
      >
      expect(msg).toBeDefined()
      expect(msg.providerId).toBe('claude')
      expect(msg.content).toBe('Hello world')
      expect(msg.role).toBe('assistant')
    })

    it('skips assistant messages with empty text content', async () => {
      const messages = [
        makeSystemMessage(),
        { type: 'assistant' as const, content: [{ type: 'text', text: '' }] },
        makeResultSuccess(),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'hi' }))
      expect(events.find((e) => e.type === 'adapter:message')).toBeUndefined()
    })

    it('joins multiple text blocks with newline', async () => {
      const messages = [
        makeSystemMessage(),
        {
          type: 'assistant' as const,
          content: [
            { type: 'text', text: 'Line 1' },
            { type: 'text', text: 'Line 2' },
          ],
        },
        makeResultSuccess(),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'hi' }))
      const msg = events.find((e) => e.type === 'adapter:message') as Extract<
        AgentEvent,
        { type: 'adapter:message' }
      >
      expect(msg.content).toBe('Line 1\nLine 2')
    })

    it('emits tool_call events for started tool progress', async () => {
      const messages = [
        makeSystemMessage(),
        makeToolProgressStarted('read_file', { path: 'test.ts' }),
        makeToolProgressCompleted('read_file', 'file contents', 50),
        makeResultSuccess(),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'read test.ts' }))

      const toolCall = events.find((e) => e.type === 'adapter:tool_call') as Extract<
        AgentEvent,
        { type: 'adapter:tool_call' }
      >
      expect(toolCall).toBeDefined()
      expect(toolCall.providerId).toBe('claude')
      expect(toolCall.toolName).toBe('read_file')
      expect(toolCall.input).toEqual({ path: 'test.ts' })
    })

    it('emits tool_result events with duration from SDK', async () => {
      const messages = [
        makeSystemMessage(),
        makeToolProgressStarted('bash', { command: 'ls' }),
        makeToolProgressCompleted('bash', 'file1\nfile2', 120),
        makeResultSuccess(),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'list files' }))

      const toolResult = events.find((e) => e.type === 'adapter:tool_result') as Extract<
        AgentEvent,
        { type: 'adapter:tool_result' }
      >
      expect(toolResult).toBeDefined()
      expect(toolResult.providerId).toBe('claude')
      expect(toolResult.toolName).toBe('bash')
      expect(toolResult.output).toBe('file1\nfile2')
      expect(toolResult.durationMs).toBe(120)
    })

    it('computes duration when SDK does not provide duration_ms', async () => {
      const messages = [
        makeSystemMessage(),
        makeToolProgressStarted('write_file', {}),
        makeToolProgressCompleted('write_file', 'ok'),
        makeResultSuccess(),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'write' }))

      const toolResult = events.find((e) => e.type === 'adapter:tool_result') as Extract<
        AgentEvent,
        { type: 'adapter:tool_result' }
      >
      expect(toolResult).toBeDefined()
      // Should be >= 0 (computed from Date.now() difference)
      expect(toolResult.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('emits tool_result for failed tool progress', async () => {
      const messages = [
        makeSystemMessage(),
        makeToolProgressStarted('bash', { command: 'exit 1' }),
        makeToolProgressFailed('bash', 'command failed'),
        makeResultSuccess(),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'run' }))

      const toolResult = events.find((e) => e.type === 'adapter:tool_result') as Extract<
        AgentEvent,
        { type: 'adapter:tool_result' }
      >
      expect(toolResult).toBeDefined()
      expect(toolResult.toolName).toBe('bash')
      expect(toolResult.output).toBe('command failed')
    })

    it('uses empty input when tool_progress has no input', async () => {
      const messages = [
        makeSystemMessage(),
        { type: 'tool_progress' as const, tool_name: 'test_tool', status: 'started' as const },
        makeToolProgressCompleted('test_tool', 'done', 10),
        makeResultSuccess(),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'test' }))
      const toolCall = events.find((e) => e.type === 'adapter:tool_call') as Extract<
        AgentEvent,
        { type: 'adapter:tool_call' }
      >
      expect(toolCall.input).toEqual({})
    })

    it('emits stream_delta events', async () => {
      const messages = [
        makeSystemMessage(),
        makeStreamEvent('chunk1'),
        makeStreamEvent('chunk2'),
        makeResultSuccess(),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'stream' }))

      const deltas = events.filter((e) => e.type === 'adapter:stream_delta') as Extract<
        AgentEvent,
        { type: 'adapter:stream_delta' }
      >[]
      expect(deltas).toHaveLength(2)
      expect(deltas[0].content).toBe('chunk1')
      expect(deltas[1].content).toBe('chunk2')
      expect(deltas[0].providerId).toBe('claude')
    })

    it('ignores stream_event with empty delta', async () => {
      const messages = [
        makeSystemMessage(),
        makeStreamEvent(''),
        { type: 'stream_event' as const },
        makeResultSuccess(),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'test' }))
      expect(events.filter((e) => e.type === 'adapter:stream_delta')).toHaveLength(0)
    })

    it('emits completed event with result and usage', async () => {
      const messages = [
        makeSystemMessage('sess-done'),
        makeResultSuccess({
          result: 'Task completed',
          sessionId: 'sess-done',
          usage: { input_tokens: 100, output_tokens: 200, cached_input_tokens: 30, cost_cents: 5 },
          durationMs: 1500,
        }),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'do something' }))

      const completed = events.find((e) => e.type === 'adapter:completed') as Extract<
        AgentEvent,
        { type: 'adapter:completed' }
      >
      expect(completed).toBeDefined()
      expect(completed.providerId).toBe('claude')
      expect(completed.sessionId).toBe('sess-done')
      expect(completed.result).toBe('Task completed')
      expect(completed.durationMs).toBe(1500)
      expect(completed.usage).toEqual({
        inputTokens: 100,
        outputTokens: 200,
        cachedInputTokens: 30,
        costCents: 5,
      })
    })

    it('uses fallback duration when result has no duration_ms', async () => {
      const messages = [
        makeSystemMessage(),
        makeResultSuccess({ result: 'ok' }),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      const completed = events.find((e) => e.type === 'adapter:completed') as Extract<
        AgentEvent,
        { type: 'adapter:completed' }
      >
      expect(completed.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('uses fallback session_id from system message when result has none', async () => {
      const messages = [
        makeSystemMessage('sess-from-system'),
        makeResultSuccess({ result: 'ok' }),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      const completed = events.find((e) => e.type === 'adapter:completed') as Extract<
        AgentEvent,
        { type: 'adapter:completed' }
      >
      expect(completed.sessionId).toBe('sess-from-system')
    })

    it('handles result with no usage', async () => {
      const messages = [
        makeSystemMessage(),
        makeResultSuccess({ result: 'ok' }),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      const completed = events.find((e) => e.type === 'adapter:completed') as Extract<
        AgentEvent,
        { type: 'adapter:completed' }
      >
      expect(completed.usage).toBeUndefined()
    })

    it('handles result with empty string instead of result text', async () => {
      const messages = [
        makeSystemMessage(),
        { type: 'result' as const, subtype: 'success', session_id: 's1' },
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      const completed = events.find((e) => e.type === 'adapter:completed') as Extract<
        AgentEvent,
        { type: 'adapter:completed' }
      >
      expect(completed.result).toBe('')
    })

    it('emits failed event on error result subtype', async () => {
      const messages = [
        makeSystemMessage('sess-err'),
        makeResultError({
          error: 'Max turns exceeded',
          subtype: 'error_max_turns',
          sessionId: 'sess-err',
        }),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      const failed = events.find((e) => e.type === 'adapter:failed') as Extract<
        AgentEvent,
        { type: 'adapter:failed' }
      >
      expect(failed).toBeDefined()
      expect(failed.providerId).toBe('claude')
      expect(failed.sessionId).toBe('sess-err')
      expect(failed.error).toBe('Max turns exceeded')
      expect(failed.code).toBe('error_max_turns')
    })

    it('emits failed with default error message when error field is missing', async () => {
      const messages = [
        makeSystemMessage('sess-1'),
        makeResultError({ subtype: 'error_unknown' }),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      const failed = events.find((e) => e.type === 'adapter:failed') as Extract<
        AgentEvent,
        { type: 'adapter:failed' }
      >
      expect(failed.error).toBe('Claude agent failed with subtype: error_unknown')
    })

    it('throws ForgeError when sdk.query() throws', async () => {
      mockQuery.mockImplementation(() => {
        throw new Error('SDK init failure')
      })

      await expect(collectEvents(adapter.execute({ prompt: 'test' }))).rejects.toThrow(ForgeError)
      await expect(collectEvents(adapter.execute({ prompt: 'test' }))).rejects.toMatchObject({
        code: 'ADAPTER_EXECUTION_FAILED',
      })
    })

    it('throws ForgeError when iteration throws (non-abort)', async () => {
      const iterable = {
        interrupt: vi.fn(),
        [Symbol.asyncIterator]() {
          let called = false
          return {
            async next() {
              if (!called) {
                called = true
                return { value: makeSystemMessage(), done: false as const }
              }
              throw new Error('Connection lost')
            },
          }
        },
      }
      mockQuery.mockReturnValue(iterable)

      await expect(collectEvents(adapter.execute({ prompt: 'test' }))).rejects.toThrow(ForgeError)
    })

    it('silently returns when iteration error occurs after abort', async () => {
      const adapterForAbort = new ClaudeAgentAdapter()
      let yieldCount = 0

      const iterable = {
        interrupt: vi.fn(),
        [Symbol.asyncIterator]() {
          return {
            async next() {
              yieldCount++
              if (yieldCount === 1) {
                return { value: makeSystemMessage(), done: false as const }
              }
              // Simulate abort happening during iteration
              adapterForAbort.interrupt()
              // Return done after abort
              return { value: undefined, done: true as const }
            },
          }
        },
      }
      mockQuery.mockReturnValue(iterable)

      const events = await collectEvents(adapterForAbort.execute({ prompt: 'test' }))
      // Should have the started event, then stop due to abort
      expect(events.some((e) => e.type === 'adapter:started')).toBe(true)
    })

    it('passes systemPrompt as preset append object by default', async () => {
      mockQuery.mockReturnValue(asyncIterableOf([makeSystemMessage(), makeResultSuccess()]))

      await collectEvents(
        adapter.execute({ prompt: 'hello', systemPrompt: 'Be concise' }),
      )

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'hello',
          options: expect.objectContaining({
            systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Be concise' },
          }),
        }),
      )
    })

    it('passes systemPrompt as plain string when systemPromptMode is replace', async () => {
      mockQuery.mockReturnValue(asyncIterableOf([makeSystemMessage(), makeResultSuccess()]))

      await collectEvents(
        adapter.execute({
          prompt: 'hello',
          systemPrompt: 'Custom system',
          options: { systemPromptMode: 'replace' },
        }),
      )

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ systemPrompt: 'Custom system' }),
        }),
      )
    })

    it('does not set systemPrompt option when input has no systemPrompt', async () => {
      mockQuery.mockReturnValue(asyncIterableOf([makeSystemMessage(), makeResultSuccess()]))

      await collectEvents(adapter.execute({ prompt: 'hello' }))

      const call = mockQuery.mock.calls[0][0] as Record<string, unknown>
      expect((call['options'] as Record<string, unknown> | undefined)?.['systemPrompt']).toBeUndefined()
    })

    it('passes workingDirectory to SDK as cwd', async () => {
      mockQuery.mockReturnValue(asyncIterableOf([makeSystemMessage(), makeResultSuccess()]))

      await collectEvents(
        adapter.execute({ prompt: 'test', workingDirectory: '/home/user/project' }),
      )

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ cwd: '/home/user/project' }),
        }),
      )
    })

    it('uses config workingDirectory when input has none', async () => {
      const adapterWithCwd = new ClaudeAgentAdapter({ workingDirectory: '/default/dir' })
      mockQuery.mockReturnValue(asyncIterableOf([makeSystemMessage(), makeResultSuccess()]))

      await collectEvents(adapterWithCwd.execute({ prompt: 'test' }))

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ cwd: '/default/dir' }),
        }),
      )
    })

    it('passes maxTurns to SDK', async () => {
      mockQuery.mockReturnValue(asyncIterableOf([makeSystemMessage(), makeResultSuccess()]))

      await collectEvents(adapter.execute({ prompt: 'test', maxTurns: 5 }))

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ maxTurns: 5 }),
        }),
      )
    })

    it('passes maxBudgetUsd to SDK', async () => {
      mockQuery.mockReturnValue(asyncIterableOf([makeSystemMessage(), makeResultSuccess()]))

      await collectEvents(adapter.execute({ prompt: 'test', maxBudgetUsd: 1.5 }))

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ maxBudgetUsd: 1.5 }),
        }),
      )
    })

    it('maps sandboxMode to permissionMode', async () => {
      const fullAccessAdapter = new ClaudeAgentAdapter({ sandboxMode: 'full-access' })
      mockQuery.mockReturnValue(asyncIterableOf([makeSystemMessage(), makeResultSuccess()]))

      await collectEvents(fullAccessAdapter.execute({ prompt: 'test' }))

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ permissionMode: 'bypassPermissions' }),
        }),
      )
    })

    it('maps read-only sandboxMode to default permissionMode', async () => {
      const readOnlyAdapter = new ClaudeAgentAdapter({ sandboxMode: 'read-only' })
      mockQuery.mockReturnValue(asyncIterableOf([makeSystemMessage(), makeResultSuccess()]))

      await collectEvents(readOnlyAdapter.execute({ prompt: 'test' }))

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ permissionMode: 'default' }),
        }),
      )
    })

    it('forwards adapter-specific options (continue, forkSession, resume)', async () => {
      mockQuery.mockReturnValue(asyncIterableOf([makeSystemMessage(), makeResultSuccess()]))

      await collectEvents(
        adapter.execute({
          prompt: 'test',
          options: { continue: true, forkSession: true, resume: 'sess-x', ignoredKey: 'ignored' },
        }),
      )

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            continue: true,
            forkSession: true,
            resume: 'sess-x',
          }),
        }),
      )

      // ignoredKey should not be forwarded
      const calledOptions = (mockQuery.mock.calls[0] as [Record<string, unknown>])[0][
        'options'
      ] as Record<string, unknown>
      expect(calledOptions['ignoredKey']).toBeUndefined()
    })

    it('merges providerOptions from config', async () => {
      const adapterWithProviderOpts = new ClaudeAgentAdapter({
        providerOptions: { customFlag: true, model: 'custom-model' },
      })
      mockQuery.mockReturnValue(asyncIterableOf([makeSystemMessage(), makeResultSuccess()]))

      await collectEvents(adapterWithProviderOpts.execute({ prompt: 'test' }))

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({ customFlag: true, model: 'custom-model' }),
        }),
      )
    })

    it('handles abort signal from input', async () => {
      const abortController = new AbortController()
      let yieldCount = 0

      const iterable = {
        interrupt: vi.fn(),
        [Symbol.asyncIterator]() {
          return {
            async next() {
              yieldCount++
              if (yieldCount === 1) {
                return { value: makeSystemMessage(), done: false as const }
              }
              if (yieldCount === 2) {
                // Abort after first message
                abortController.abort()
                return { value: makeAssistantMessage('partial'), done: false as const }
              }
              return { value: undefined, done: true as const }
            },
          }
        },
      }
      mockQuery.mockReturnValue(iterable)

      const events = await collectEvents(
        adapter.execute({ prompt: 'test', signal: abortController.signal }),
      )

      // Should have started event, then stop due to abort
      expect(events.some((e) => e.type === 'adapter:started')).toBe(true)
    })

    it('emits all event types in full conversation flow', async () => {
      const messages = [
        makeSystemMessage('full-sess'),
        makeAssistantMessage('Let me check that'),
        makeToolProgressStarted('read_file', { path: 'src/index.ts' }),
        makeToolProgressCompleted('read_file', 'export const x = 1', 45),
        makeStreamEvent('Analyzing'),
        makeAssistantMessage('Found the answer'),
        makeResultSuccess({
          result: 'Analysis complete',
          sessionId: 'full-sess',
          usage: { input_tokens: 500, output_tokens: 300 },
          durationMs: 3000,
        }),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'analyze' }))

      expect(events.map((e) => e.type)).toEqual([
        'adapter:started',
        'adapter:message',
        'adapter:tool_call',
        'adapter:tool_result',
        'adapter:stream_delta',
        'adapter:message',
        'adapter:completed',
      ])
    })

    it('ignores unknown message types', async () => {
      const messages = [
        makeSystemMessage(),
        { type: 'unknown_type' as const, data: 'whatever' },
        makeResultSuccess(),
      ]
      mockQuery.mockReturnValue(asyncIterableOf(messages))

      const events = await collectEvents(adapter.execute({ prompt: 'test' }))

      // Only started + completed, unknown is silently skipped
      expect(events.map((e) => e.type)).toEqual(['adapter:started', 'adapter:completed'])
    })
  })

  // -----------------------------------------------------------------------
  // resumeSession
  // -----------------------------------------------------------------------

  describe('resumeSession', () => {
    it('passes sessionId to SDK via resume option', async () => {
      mockQuery.mockReturnValue(asyncIterableOf([makeSystemMessage('sess-resumed'), makeResultSuccess()]))

      await collectEvents(adapter.resumeSession('sess-to-resume', { prompt: 'continue' }))

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'continue',
          options: expect.objectContaining({ resume: 'sess-to-resume' }),
        }),
      )
    })

    it('sets isResume to true on started event', async () => {
      mockQuery.mockReturnValue(asyncIterableOf([makeSystemMessage('sess-r'), makeResultSuccess()]))

      const events = await collectEvents(
        adapter.resumeSession('sess-r', { prompt: 'continue' }),
      )

      const started = events.find((e) => e.type === 'adapter:started') as Extract<
        AgentEvent,
        { type: 'adapter:started' }
      >
      expect(started).toBeDefined()
      expect(started.isResume).toBe(true)
    })

    it('merges existing input options with resume', async () => {
      mockQuery.mockReturnValue(asyncIterableOf([makeSystemMessage(), makeResultSuccess()]))

      await collectEvents(
        adapter.resumeSession('sess-x', { prompt: 'go', options: { continue: true } }),
      )

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            resume: 'sess-x',
            continue: true,
          }),
        }),
      )
    })
  })

  // -----------------------------------------------------------------------
  // interrupt
  // -----------------------------------------------------------------------

  describe('interrupt', () => {
    it('calls interrupt on active conversation and aborts controller', async () => {
      let resolveIteration: (() => void) | undefined
      const blockingPromise = new Promise<void>((r) => { resolveIteration = r })

      const interruptFn = vi.fn()
      const iterable = {
        interrupt: interruptFn,
        [Symbol.asyncIterator]() {
          let called = false
          return {
            async next() {
              if (!called) {
                called = true
                return { value: makeSystemMessage(), done: false as const }
              }
              await blockingPromise
              return { value: undefined, done: true as const }
            },
          }
        },
      }
      mockQuery.mockReturnValue(iterable)

      const gen = adapter.execute({ prompt: 'test' })
      // Read the first event to ensure execute is running
      const first = await gen.next()
      expect(first.value).toMatchObject({ type: 'adapter:started' })

      // Now interrupt
      adapter.interrupt()
      expect(interruptFn).toHaveBeenCalled()

      // Unblock so the generator can finish
      resolveIteration?.()

      // Drain remaining
      const remaining: AgentEvent[] = []
      for await (const event of gen) {
        remaining.push(event)
      }
      // Should be empty or minimal after abort
    })

    it('does nothing when no active conversation', () => {
      // Should not throw
      adapter.interrupt()
    })
  })

  // -----------------------------------------------------------------------
  // healthCheck
  // -----------------------------------------------------------------------

  describe('healthCheck', () => {
    it('returns healthy when SDK is available', async () => {
      const status = await adapter.healthCheck()

      expect(status.healthy).toBe(true)
      expect(status.providerId).toBe('claude')
      expect(status.sdkInstalled).toBe(true)
    })

    it('returns unhealthy when SDK import fails', async () => {
      // Force a fresh adapter with cleared SDK cache
      const freshAdapter = new ClaudeAgentAdapter()
      // Null out cached SDK to force reload
      ;(freshAdapter as unknown as Record<string, unknown>)['sdk'] = null

      // Make the mock throw on next import
      mockQuery.mockImplementation(() => {
        throw new Error('not installed')
      })
      // The loadSDK caches on first success, so we need to break the cache
      // Actually loadSDK checks this.sdk, set it to null
      ;(freshAdapter as unknown as Record<string, unknown>)['sdk'] = null

      // Override loadSDK behavior by making the dynamic import fail
      // Since vi.mock already mocked the module, we need a different approach.
      // We can spy on the private loadSDK method
      const loadSpy = vi.spyOn(
        freshAdapter as unknown as { loadSDK: () => Promise<unknown> },
        'loadSDK',
      ).mockRejectedValue(new Error('SDK not found'))

      const status = await freshAdapter.healthCheck()

      expect(status.healthy).toBe(false)
      expect(status.sdkInstalled).toBe(false)
      expect(status.lastError).toBe('SDK not found')

      loadSpy.mockRestore()
    })
  })

  // -----------------------------------------------------------------------
  // forkSession
  // -----------------------------------------------------------------------

  describe('forkSession', () => {
    it('creates new session from existing and returns new session ID', async () => {
      const iterable = {
        interrupt: vi.fn(),
        [Symbol.asyncIterator]() {
          let called = false
          return {
            async next() {
              if (!called) {
                called = true
                return { value: makeSystemMessage('new-forked-sess'), done: false as const }
              }
              return { value: undefined, done: true as const }
            },
          }
        },
      }
      mockQuery.mockReturnValue(iterable)

      const newSessionId = await adapter.forkSession('original-sess')

      expect(newSessionId).toBe('new-forked-sess')
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: '',
          options: expect.objectContaining({
            resume: 'original-sess',
            forkSession: true,
          }),
        }),
      )
    })

    it('rejects with ForgeError when no system event is received', async () => {
      mockQuery.mockReturnValue(asyncIterableOf([]))

      await expect(adapter.forkSession('sess-missing')).rejects.toThrow(ForgeError)
      await expect(adapter.forkSession('sess-missing')).rejects.toMatchObject({
        code: 'ADAPTER_SESSION_NOT_FOUND',
      })
    })

    it('rejects with ForgeError when iteration throws', async () => {
      const iterable = {
        interrupt: vi.fn(),
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw new Error('Connection refused')
            },
          }
        },
      }
      mockQuery.mockReturnValue(iterable)

      await expect(adapter.forkSession('sess-fail')).rejects.toThrow(ForgeError)
    })
  })

  // -----------------------------------------------------------------------
  // listSessions
  // -----------------------------------------------------------------------

  describe('listSessions', () => {
    it('returns mapped SessionInfo array', async () => {
      const rawSessions = [
        {
          session_id: 'sess-1',
          created_at: '2025-01-15T10:00:00Z',
          last_active_at: '2025-01-15T11:00:00Z',
          cwd: '/project/a',
          metadata: { branch: 'main' },
        },
        {
          id: 'sess-2',
          created_at: new Date('2025-01-16T10:00:00Z'),
          last_active_at: new Date('2025-01-16T12:00:00Z'),
        },
      ]
      mockListSessions.mockResolvedValue(rawSessions)

      const sessions = await adapter.listSessions()

      expect(sessions).toHaveLength(2)

      expect(sessions[0].sessionId).toBe('sess-1')
      expect(sessions[0].providerId).toBe('claude')
      expect(sessions[0].createdAt).toEqual(new Date('2025-01-15T10:00:00Z'))
      expect(sessions[0].lastActiveAt).toEqual(new Date('2025-01-15T11:00:00Z'))
      expect(sessions[0].workingDirectory).toBe('/project/a')
      expect(sessions[0].metadata).toEqual({ branch: 'main' })

      expect(sessions[1].sessionId).toBe('sess-2')
      expect(sessions[1].createdAt).toEqual(new Date('2025-01-16T10:00:00Z'))
      expect(sessions[1].lastActiveAt).toEqual(new Date('2025-01-16T12:00:00Z'))
      expect(sessions[1].workingDirectory).toBeUndefined()
      expect(sessions[1].metadata).toBeUndefined()
    })

    it('returns empty array when listSessions is not available on SDK', async () => {
      // Override SDK to not have listSessions
      const freshAdapter = new ClaudeAgentAdapter()
      const loadSpy = vi.spyOn(
        freshAdapter as unknown as { loadSDK: () => Promise<unknown> },
        'loadSDK',
      ).mockResolvedValue({ query: mockQuery })

      const sessions = await freshAdapter.listSessions()
      expect(sessions).toEqual([])

      loadSpy.mockRestore()
    })

    it('throws ForgeError when listSessions call fails', async () => {
      mockListSessions.mockRejectedValue(new Error('API error'))

      await expect(adapter.listSessions()).rejects.toThrow(ForgeError)
      await expect(adapter.listSessions()).rejects.toMatchObject({
        code: 'ADAPTER_EXECUTION_FAILED',
      })
    })

    it('handles sessions with numeric created_at', async () => {
      const timestamp = Date.now()
      mockListSessions.mockResolvedValue([
        { session_id: 's1', created_at: timestamp, last_active_at: timestamp },
      ])

      const sessions = await adapter.listSessions()
      expect(sessions[0].createdAt).toEqual(new Date(timestamp))
    })

    it('handles sessions with missing date fields', async () => {
      mockListSessions.mockResolvedValue([
        { session_id: 's1' },
      ])

      const sessions = await adapter.listSessions()
      expect(sessions[0].createdAt).toEqual(new Date(0))
      // lastActiveAt defaults to Date.now(), so it should be recent
      expect(sessions[0].lastActiveAt.getTime()).toBeGreaterThan(0)
    })
  })

  // -----------------------------------------------------------------------
  // providerId
  // -----------------------------------------------------------------------

  describe('providerId', () => {
    it('is "claude"', () => {
      expect(adapter.providerId).toBe('claude')
    })
  })
})
