import { describe, it, expect, vi, beforeEach } from 'vitest'
import { collectEvents } from './test-helpers.js'
import type { AgentEvent, AgentInput } from '../types.js'

// ---------------------------------------------------------------------------
// SDK mock types (mirrors the shapes consumed by CodexAdapter)
// ---------------------------------------------------------------------------

interface MockStreamEvent {
  type: string
  thread_id?: string
  usage?: { input_tokens: number; output_tokens: number; cached_input_tokens?: number }
  item?: Record<string, unknown>
  error?: string
  message?: string
}

function createMockThread(events: MockStreamEvent[], finalResponse?: string) {
  return {
    runStreamed: vi.fn().mockResolvedValue({
      events: (async function* () {
        for (const e of events) yield e
      })(),
      finalResponse,
    }),
  }
}

const mockStartThread = vi.fn()
const mockResumeThread = vi.fn()
const mockCodexCtor = vi.fn().mockImplementation(() => ({
  startThread: mockStartThread,
  resumeThread: mockResumeThread,
}))

vi.mock('@openai/codex-sdk', () => ({
  Codex: mockCodexCtor,
}))

// Must import after mocking
const { CodexAdapter } = await import('../codex/codex-adapter.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return { prompt: 'Hello Codex', ...overrides }
}

function threadStartedEvent(threadId = 'thread-123'): MockStreamEvent {
  return { type: 'thread.started', thread_id: threadId }
}

function itemCompletedEvent(item: Record<string, unknown>): MockStreamEvent {
  return { type: 'item.completed', item }
}

function turnCompletedEvent(
  usage = { input_tokens: 50, output_tokens: 100 },
): MockStreamEvent {
  return { type: 'turn.completed', usage }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodexAdapter', () => {
  let adapter: InstanceType<typeof CodexAdapter>

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new CodexAdapter()
  })

  // ---- getCapabilities ---------------------------------------------------

  describe('getCapabilities', () => {
    it('returns correct profile with resume=true and fork=false', () => {
      const caps = adapter.getCapabilities()
      expect(caps).toEqual({
        supportsResume: true,
        supportsFork: false,
        supportsToolCalls: true,
        supportsStreaming: true,
        supportsCostUsage: true,
      })
    })
  })

  // ---- configure ---------------------------------------------------------

  describe('configure', () => {
    it('merges config options', () => {
      adapter.configure({ model: 'o3', apiKey: 'sk-test' })
      // Verify by executing — the model should appear in the started event
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      // After configure, the model should be used
      const gen = adapter.execute(makeInput())
      // Just verify no throw; model propagation checked in dedicated test
      expect(gen).toBeDefined()
    })
  })

  // ---- execute -----------------------------------------------------------

  describe('execute', () => {
    it('emits started event with enriched fields from thread.started', async () => {
      const thread = createMockThread([
        threadStartedEvent('thread-abc'),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(
        adapter.execute(makeInput({ systemPrompt: 'Be helpful', workingDirectory: '/tmp' })),
      )

      const started = events.find((e) => e.type === 'adapter:started')
      expect(started).toBeDefined()
      if (started?.type === 'adapter:started') {
        expect(started.providerId).toBe('codex')
        expect(started.sessionId).toBe('thread-abc')
        expect(started.prompt).toBe('Hello Codex')
        expect(started.systemPrompt).toBe('Be helpful')
        expect(started.model).toBe('gpt-5.4')
        expect(started.workingDirectory).toBe('/tmp')
        expect(started.isResume).toBe(false)
      }
    })

    it('maps agent_message item to message event', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        itemCompletedEvent({ type: 'agent_message', id: 'msg-1', text: 'Hello world!' }),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      const msg = events.find((e) => e.type === 'adapter:message')
      expect(msg).toBeDefined()
      if (msg?.type === 'adapter:message') {
        expect(msg.providerId).toBe('codex')
        expect(msg.content).toBe('Hello world!')
        expect(msg.role).toBe('assistant')
      }
    })

    it('maps command_execution item to tool_call + tool_result events', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        itemCompletedEvent({
          type: 'command_execution',
          id: 'cmd-1',
          command: 'ls -la',
          aggregated_output: 'file1.txt\nfile2.txt',
          exit_code: 0,
          status: 'completed',
        }),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      const toolCall = events.find((e) => e.type === 'adapter:tool_call')
      const toolResult = events.find((e) => e.type === 'adapter:tool_result')

      expect(toolCall).toBeDefined()
      if (toolCall?.type === 'adapter:tool_call') {
        expect(toolCall.toolName).toBe('shell')
        expect(toolCall.input).toEqual({ command: 'ls -la' })
      }

      expect(toolResult).toBeDefined()
      if (toolResult?.type === 'adapter:tool_result') {
        expect(toolResult.toolName).toBe('shell')
        expect(toolResult.output).toBe('file1.txt\nfile2.txt')
        expect(toolResult.durationMs).toBe(0)
      }
    })

    it('maps file_change item to tool_result event', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        itemCompletedEvent({
          type: 'file_change',
          id: 'patch-1',
          changes: [{ path: 'src/index.ts', kind: 'update' }],
          status: 'completed',
        }),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      const result = events.find((e) => e.type === 'adapter:tool_result')
      expect(result).toBeDefined()
      if (result?.type === 'adapter:tool_result') {
        expect(result.toolName).toBe('file_edit')
        expect(result.output).toBe('update: src/index.ts')
      }
    })

    it('maps mcp_tool_call item to tool_call + tool_result events', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        itemCompletedEvent({
          type: 'mcp_tool_call',
          id: 'mcp-1',
          server: 'my-server',
          tool: 'my-mcp-tool',
          arguments: { foo: 'bar' },
          result: { content: ['result data'], structured_content: null },
          status: 'completed',
        }),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      const toolCall = events.find((e) => e.type === 'adapter:tool_call')
      const toolResult = events.find((e) => e.type === 'adapter:tool_result')

      expect(toolCall).toBeDefined()
      if (toolCall?.type === 'adapter:tool_call') {
        expect(toolCall.toolName).toBe('my-server/my-mcp-tool')
        expect(toolCall.input).toEqual({ foo: 'bar' })
      }

      expect(toolResult).toBeDefined()
      if (toolResult?.type === 'adapter:tool_result') {
        expect(toolResult.toolName).toBe('my-server/my-mcp-tool')
        expect(toolResult.output).toBe(JSON.stringify(['result data']))
      }
    })

    it('maps web_search item to tool_call + tool_result events', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        itemCompletedEvent({
          type: 'web_search',
          id: 'search-1',
          query: 'TypeScript generics',
          // SDK does not have a results field on WebSearchItem
        }),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      const toolCall = events.find((e) => e.type === 'adapter:tool_call')

      expect(toolCall).toBeDefined()
      if (toolCall?.type === 'adapter:tool_call') {
        expect(toolCall.toolName).toBe('web_search')
        expect(toolCall.input).toEqual({ query: 'TypeScript generics' })
      }

      // SDK WebSearchItem has no results field, so no tool_result is emitted
      const toolResult = events.find((e) => e.type === 'adapter:tool_result')
      expect(toolResult).toBeUndefined()
    })

    it('maps reasoning item to assistant message event', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        itemCompletedEvent({ type: 'reasoning', id: 'rsn-1', text: 'Let me think about this...' }),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      const msg = events.find((e) => e.type === 'adapter:message')
      expect(msg).toBeDefined()
      if (msg?.type === 'adapter:message') {
        expect(msg.content).toBe('Let me think about this...')
        expect(msg.role).toBe('assistant')
      }
    })

    it('maps error item to failed event', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        itemCompletedEvent({ type: 'error', message: 'Something went wrong' }),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      const failed = events.find((e) => e.type === 'adapter:failed')
      expect(failed).toBeDefined()
      if (failed?.type === 'adapter:failed') {
        expect(failed.error).toBe('Something went wrong')
        expect(failed.code).toBe('ADAPTER_EXECUTION_FAILED')
      }
    })

    it('silently skips todo_list items', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        itemCompletedEvent({
          type: 'todo_list',
          items: [{ text: 'Step 1', completed: false }],
        }),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      const types = events.map((e) => e.type)
      expect(types).not.toContain('adapter:message')
      expect(types).not.toContain('adapter:tool_call')
    })

    it('emits completed event with usage from turn.completed', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent({ input_tokens: 100, output_tokens: 200 }),
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      const completed = events.find((e) => e.type === 'adapter:completed')
      expect(completed).toBeDefined()
      if (completed?.type === 'adapter:completed') {
        expect(completed.providerId).toBe('codex')
        expect(completed.usage).toEqual({
          inputTokens: 100,
          outputTokens: 200,
          cachedInputTokens: undefined,
        })
        expect(completed.durationMs).toBeGreaterThanOrEqual(0)
      }
    })

    it('emits completed with cachedInputTokens when present', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent({
          input_tokens: 100,
          output_tokens: 200,
          cached_input_tokens: 50,
        } as { input_tokens: number; output_tokens: number; cached_input_tokens: number }),
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      const completed = events.find((e) => e.type === 'adapter:completed')
      if (completed?.type === 'adapter:completed') {
        expect(completed.usage?.cachedInputTokens).toBe(50)
      }
    })

    it('emits failed event when SDK throws during runStreamed', async () => {
      const thread = {
        runStreamed: vi.fn().mockRejectedValue(new Error('Connection refused')),
      }
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      const failed = events.find((e) => e.type === 'adapter:failed')
      expect(failed).toBeDefined()
      if (failed?.type === 'adapter:failed') {
        expect(failed.error).toBe('Connection refused')
        expect(failed.code).toBe('ADAPTER_EXECUTION_FAILED')
      }
    })

    it('emits ADAPTER_TIMEOUT when runStreamed aborts before stream start due timeout', async () => {
      const thread = {
        runStreamed: vi.fn().mockImplementation((_prompt: string, opts?: { signal?: AbortSignal }) => (
          new Promise((_resolve, reject) => {
            const signal = opts?.signal
            if (signal?.aborted) {
              reject(new DOMException('Aborted', 'AbortError'))
              return
            }
            signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            )
          })
        )),
      }
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(
        adapter.execute(makeInput({ options: { timeoutMs: 5 } })),
      )
      const failed = events.find((e) => e.type === 'adapter:failed')
      expect(failed).toBeDefined()
      if (failed?.type === 'adapter:failed') {
        expect(failed.code).toBe('ADAPTER_TIMEOUT')
        expect(failed.error).toContain('timed out')
      }
    })

    it('emits failed on turn.failed event', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        { type: 'turn.failed', error: { message: 'Rate limit exceeded' } },
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      const failed = events.find((e) => e.type === 'adapter:failed')
      expect(failed).toBeDefined()
      if (failed?.type === 'adapter:failed') {
        expect(failed.error).toBe('Rate limit exceeded')
      }
    })

    it('emits failed on error event', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        { type: 'error', message: 'Unknown error occurred' },
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      const failed = events.find((e) => e.type === 'adapter:failed')
      expect(failed).toBeDefined()
      if (failed?.type === 'adapter:failed') {
        expect(failed.error).toBe('Unknown error occurred')
      }
    })

    it('passes model from config to thread options', async () => {
      const customAdapter = new CodexAdapter({ model: 'o3-pro' })
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(customAdapter.execute(makeInput()))
      const started = events.find((e) => e.type === 'adapter:started')
      if (started?.type === 'adapter:started') {
        expect(started.model).toBe('o3-pro')
      }

      // Verify thread options passed to startThread
      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'o3-pro' }),
      )
    })

    it('passes sandbox mode to thread options', async () => {
      const customAdapter = new CodexAdapter({ sandboxMode: 'full-access' })
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      await collectEvents(customAdapter.execute(makeInput()))

      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxMode: 'danger-full-access' }),
      )
    })

    it('defaults model to gpt-5.4', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      await collectEvents(adapter.execute(makeInput()))

      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.4' }),
      )
    })

    it('defaults sandbox mode to workspace-write', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      await collectEvents(adapter.execute(makeInput()))

      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxMode: 'workspace-write' }),
      )
    })

    it('passes working directory from input', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      await collectEvents(
        adapter.execute(makeInput({ workingDirectory: '/my/project' })),
      )

      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({ workingDirectory: '/my/project' }),
      )
    })

    it('passes apiKey to Codex constructor', async () => {
      const authedAdapter = new CodexAdapter({ apiKey: 'sk-test-key' })
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      await collectEvents(authedAdapter.execute(makeInput()))

      expect(mockCodexCtor).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'sk-test-key' }),
      )
    })

    it('passes env to Codex constructor', async () => {
      const envAdapter = new CodexAdapter({ env: { MY_VAR: 'value' } })
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      await collectEvents(envAdapter.execute(makeInput()))

      expect(mockCodexCtor).toHaveBeenCalledWith(
        expect.objectContaining({ env: { MY_VAR: 'value' } }),
      )
    })

    it('passes codexPathOverride from providerOptions', async () => {
      const customAdapter = new CodexAdapter({
        providerOptions: { codexPathOverride: '/usr/local/bin/codex' },
      })
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      await collectEvents(customAdapter.execute(makeInput()))

      expect(mockCodexCtor).toHaveBeenCalledWith(
        expect.objectContaining({ codexPathOverride: '/usr/local/bin/codex' }),
      )
    })

    it('passes systemPrompt from input as config.instructions to Codex constructor', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      await collectEvents(
        adapter.execute(makeInput({ systemPrompt: 'You are a helpful assistant.' })),
      )

      expect(mockCodexCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          config: { instructions: 'You are a helpful assistant.' },
        }),
      )
    })

    it('uses static systemPrompt from providerOptions when input has none', async () => {
      const staticAdapter = new CodexAdapter({
        providerOptions: { systemPrompt: 'Default static prompt.' },
      })
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      await collectEvents(staticAdapter.execute(makeInput()))

      expect(mockCodexCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          config: { instructions: 'Default static prompt.' },
        }),
      )
    })

    it('input.systemPrompt takes priority over providerOptions.systemPrompt', async () => {
      const staticAdapter = new CodexAdapter({
        providerOptions: { systemPrompt: 'Static prompt.' },
      })
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      await collectEvents(
        staticAdapter.execute(makeInput({ systemPrompt: 'Per-request prompt.' })),
      )

      expect(mockCodexCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          config: { instructions: 'Per-request prompt.' },
        }),
      )
    })

    it('merges systemPrompt with existing providerOptions.config overrides', async () => {
      const cfgAdapter = new CodexAdapter({
        providerOptions: { config: { model_reasoning_effort: 'high' } },
      })
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      await collectEvents(
        cfgAdapter.execute(makeInput({ systemPrompt: 'Be concise.' })),
      )

      expect(mockCodexCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          config: { model_reasoning_effort: 'high', instructions: 'Be concise.' },
        }),
      )
    })

    it('does not set config.instructions when no systemPrompt is provided', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      await collectEvents(adapter.execute(makeInput()))

      const ctorCall = mockCodexCtor.mock.calls[0]?.[0] as Record<string, unknown> | undefined
      expect(ctorCall?.['config']).toBeUndefined()
    })

    it('passes developerInstructions from providerOptions as config.developer_instructions', async () => {
      const devAdapter = new CodexAdapter({
        providerOptions: { developerInstructions: 'Always use structured output.' },
      })
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      await collectEvents(devAdapter.execute(makeInput()))

      expect(mockCodexCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ developer_instructions: 'Always use structured output.' }),
        }),
      )
    })

    it('can set both instructions and developer_instructions together', async () => {
      const bothAdapter = new CodexAdapter({
        providerOptions: { developerInstructions: 'Use JSON output.' },
      })
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      await collectEvents(bothAdapter.execute(makeInput({ systemPrompt: 'Be brief.' })))

      expect(mockCodexCtor).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            instructions: 'Be brief.',
            developer_instructions: 'Use JSON output.',
          }),
        }),
      )
    })

    it('overrides model from input.options', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      await collectEvents(
        adapter.execute(makeInput({ options: { model: 'gpt-4o' } })),
      )

      expect(mockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4o' }),
      )
    })

    it('prefers input.options.timeoutMs over adapter config timeout', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      try {
        const thread = createMockThread([
          threadStartedEvent(),
          turnCompletedEvent(),
        ])
        mockStartThread.mockReturnValue(thread)

        const customAdapter = new CodexAdapter({ timeoutMs: 60_000 })
        await collectEvents(
          customAdapter.execute(makeInput({ options: { timeoutMs: 25 } })),
        )

        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 25)
      } finally {
        setTimeoutSpy.mockRestore()
      }
    })

    it('emits completed with result from agent_message when no turn.completed usage', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        itemCompletedEvent({ type: 'agent_message', id: 'msg-1', text: 'Final answer here' }),
        // No turn.completed — so usage should be undefined
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      const completed = events.find((e) => e.type === 'adapter:completed')
      expect(completed).toBeDefined()
      if (completed?.type === 'adapter:completed') {
        expect(completed.result).toBe('Final answer here')
        expect(completed.usage).toBeUndefined()
      }
    })

    it('skips item.completed events with no item', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        { type: 'item.completed' }, // no item field
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      // Should just have started + completed, no crash
      const types = events.map((e) => e.type)
      expect(types).toContain('adapter:started')
      expect(types).toContain('adapter:completed')
    })

    it('ignores unknown event types', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        { type: 'item.started' },
        { type: 'turn.started' },
        { type: 'some.future.event' },
        turnCompletedEvent(),
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      // Only started + completed
      expect(events).toHaveLength(2)
    })

    it('captures final response from assistant messages', async () => {
      const thread = createMockThread([
        threadStartedEvent(),
        itemCompletedEvent({ type: 'agent_message', id: 'msg-1', text: 'Step 1' }),
        itemCompletedEvent({ type: 'agent_message', id: 'msg-2', text: 'Final answer' }),
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      const completed = events.find((e) => e.type === 'adapter:completed')
      expect(completed).toBeDefined()
      if (completed?.type === 'adapter:completed') {
        // The last assistant message content should be the result
        expect(completed.result).toBe('Final answer')
      }
    })
  })

  // ---- resumeSession -----------------------------------------------------

  describe('resumeSession', () => {
    it('passes thread ID for resume via resumeThread', async () => {
      const thread = createMockThread([
        threadStartedEvent('thread-resume-456'),
        turnCompletedEvent(),
      ])
      mockResumeThread.mockReturnValue(thread)

      const events = await collectEvents(
        adapter.resumeSession('thread-resume-456', makeInput()),
      )

      expect(mockResumeThread).toHaveBeenCalledWith(
        'thread-resume-456',
        expect.objectContaining({ model: 'gpt-5.4' }),
      )

      const started = events.find((e) => e.type === 'adapter:started')
      expect(started).toBeDefined()
    })

    it('marks isResume on started event', async () => {
      const thread = createMockThread([
        threadStartedEvent('thread-resume-789'),
        turnCompletedEvent(),
      ])
      mockResumeThread.mockReturnValue(thread)

      const events = await collectEvents(
        adapter.resumeSession('thread-resume-789', makeInput()),
      )

      const started = events.find((e) => e.type === 'adapter:started')
      expect(started).toBeDefined()
      if (started?.type === 'adapter:started') {
        expect(started.isResume).toBe(true)
      }
    })
  })

  // ---- interrupt ---------------------------------------------------------

  describe('interrupt', () => {
    it('aborts current execution via AbortController', async () => {
      // Create a thread that yields one event then throws on abort
      let rejectHang: ((err: Error) => void) | undefined
      const hangPromise = new Promise<void>((_, reject) => {
        rejectHang = reject
      })

      const thread = {
        runStreamed: vi.fn().mockResolvedValue({
          events: (async function* () {
            yield threadStartedEvent()
            // Hang until abort — real SDKs throw AbortError when signal fires
            await hangPromise
          })(),
        }),
      }
      mockStartThread.mockReturnValue(thread)

      const events: AgentEvent[] = []
      const gen = adapter.execute(makeInput())

      // Collect first event
      const first = await gen.next()
      if (!first.done && first.value) {
        events.push(first.value)
      }

      // Now interrupt — this aborts the internal signal
      adapter.interrupt()
      // Simulate the SDK throwing when aborted (as real SDKs do)
      rejectHang?.(new DOMException('Aborted', 'AbortError'))

      // Drain remaining events
      for await (const event of gen) {
        events.push(event)
      }

      // Should have a started event and a completed event (interrupted)
      expect(events.some((e) => e.type === 'adapter:started')).toBe(true)
      const completed = events.find((e) => e.type === 'adapter:completed')
      if (completed?.type === 'adapter:completed') {
        expect(completed.result).toBe('(interrupted)')
      }
    })

    it('is a no-op when nothing is running', () => {
      // Should not throw
      expect(() => adapter.interrupt()).not.toThrow()
    })
  })

  // ---- healthCheck -------------------------------------------------------

  describe('healthCheck', () => {
    it('returns healthy when SDK is available', async () => {
      const status = await adapter.healthCheck()
      expect(status.healthy).toBe(true)
      expect(status.providerId).toBe('codex')
      expect(status.sdkInstalled).toBe(true)
      expect(status.cliAvailable).toBe(true)
      expect(status.lastSuccessTimestamp).toBeGreaterThan(0)
    })

    it('returns unhealthy when SDK is missing', async () => {
      // Create a fresh adapter and break the cached SDK
      const brokenAdapter = new CodexAdapter()
      // Access private sdkModule to force a reload that fails
       
      const anyAdapter = brokenAdapter as unknown as Record<string, unknown>
      anyAdapter['sdkModule'] = null

      // Temporarily make the dynamic import fail
      const origMock = vi.mocked(await import('@openai/codex-sdk'))
      vi.doMock('@openai/codex-sdk', () => {
        throw new Error('Cannot find module')
      })

      // Since the module is already cached by vi.mock, we need a different approach.
      // Instead, we test by clearing the cached module and making loadSdk fail.
      // We'll use a fresh adapter that overrides loadSdk to throw.
      const failAdapter = new CodexAdapter()
      // Override the private loadSdk
      Object.defineProperty(failAdapter, 'loadSdk', {
        value: async () => {
          throw new Error('@openai/codex-sdk is not installed')
        },
      })

      const status = await failAdapter.healthCheck()
      expect(status.healthy).toBe(false)
      expect(status.providerId).toBe('codex')
      expect(status.sdkInstalled).toBe(false)
      expect(status.cliAvailable).toBe(false)
      expect(status.lastError).toContain('not installed')

      // Restore
      vi.doMock('@openai/codex-sdk', () => origMock)
    })
  })

  // ---- providerId --------------------------------------------------------

  describe('providerId', () => {
    it('is "codex"', () => {
      expect(adapter.providerId).toBe('codex')
    })
  })

  // ---- combineSignals (tested via execute behavior) ----------------------

  describe('signal handling', () => {
    it('respects external abort signal', async () => {
      const ac = new AbortController()
      let rejectHang: ((err: Error) => void) | undefined
      const hangPromise = new Promise<void>((_, reject) => {
        rejectHang = reject
      })

      const thread = {
        runStreamed: vi.fn().mockResolvedValue({
          events: (async function* () {
            yield threadStartedEvent()
            // Real SDKs throw when the abort signal fires
            await hangPromise
          })(),
        }),
      }
      mockStartThread.mockReturnValue(thread)

      const events: AgentEvent[] = []
      const gen = adapter.execute(makeInput({ signal: ac.signal }))

      // Get the first event
      const first = await gen.next()
      if (!first.done && first.value) events.push(first.value)

      // Abort via external signal
      ac.abort()
      rejectHang?.(new DOMException('Aborted', 'AbortError'))

      for await (const event of gen) {
        events.push(event)
      }

      const completed = events.find((e) => e.type === 'adapter:completed')
      if (completed?.type === 'adapter:completed') {
        expect(completed.result).toBe('(interrupted)')
      }
    })

    it('handles pre-aborted external signal', async () => {
      const ac = new AbortController()
      ac.abort() // Already aborted

      const thread = {
        runStreamed: vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')),
      }
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput({ signal: ac.signal })))

      // Should get a failed event since runStreamed throws
      const failed = events.find((e) => e.type === 'adapter:failed')
      expect(failed).toBeDefined()
    })
  })

  // ---- full event sequence -----------------------------------------------

  describe('full event sequence', () => {
    it('produces correct event sequence for a typical run', async () => {
      const thread = createMockThread([
        threadStartedEvent('thread-full'),
        itemCompletedEvent({ type: 'agent_message', id: 'msg-1', text: 'Analyzing...' }),
        itemCompletedEvent({
          type: 'command_execution',
          id: 'cmd-1',
          command: 'cat package.json',
          aggregated_output: '{"name": "test"}',
          exit_code: 0,
          status: 'completed',
        }),
        itemCompletedEvent({
          type: 'file_change',
          id: 'patch-1',
          changes: [{ path: 'README.md', kind: 'add' }],
          status: 'completed',
        }),
        itemCompletedEvent({ type: 'agent_message', id: 'msg-2', text: 'Done!' }),
        turnCompletedEvent({ input_tokens: 200, output_tokens: 400 }),
      ])
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      const types = events.map((e) => e.type)

      expect(types).toEqual([
        'adapter:started',
        'adapter:message',       // Analyzing...
        'adapter:tool_call',     // shell
        'adapter:tool_result',   // shell output
        'adapter:tool_result',   // file_edit
        'adapter:message',       // Done!
        'adapter:completed',
      ])
    })
  })

  // ---- stream error during iteration -------------------------------------

  describe('stream errors', () => {
    it('emits failed when stream iteration throws', async () => {
      const thread = {
        runStreamed: vi.fn().mockResolvedValue({
          events: (async function* () {
            yield threadStartedEvent()
            throw new Error('Stream interrupted')
          })(),
        }),
      }
      mockStartThread.mockReturnValue(thread)

      const events = await collectEvents(adapter.execute(makeInput()))
      const failed = events.find((e) => e.type === 'adapter:failed')
      expect(failed).toBeDefined()
      if (failed?.type === 'adapter:failed') {
        expect(failed.error).toBe('Stream interrupted')
      }
    })
  })
})
