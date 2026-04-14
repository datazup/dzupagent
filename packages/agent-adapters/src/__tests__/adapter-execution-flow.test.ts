/**
 * Adapter Execution Flow Tests
 *
 * Tests both Claude and Codex adapters side-by-side through the same
 * execution scenarios. Validates:
 *   1. Event stream integrity (correct events in correct order)
 *   2. Content extraction (no undefined/empty results)
 *   3. Usage/token tracking
 *   4. Monitoring surface (health, capabilities, sessions)
 *   5. Regression: undefinedundefined bug (Codex empty result)
 *   6. End-to-end flow through OrchestratorFacade.run()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { collectEvents } from './test-helpers.js'
import type {
  AgentEvent,
  AgentInput,
  AgentCompletedEvent,
  AgentMessageEvent,
  AgentStartedEvent,
  AgentFailedEvent,
  TokenUsage,
} from '../types.js'

// ---------------------------------------------------------------------------
// Claude SDK mock
// ---------------------------------------------------------------------------

const claudeMockQuery = vi.fn()
const claudeMockListSessions = vi.fn()

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: claudeMockQuery,
  listSessions: claudeMockListSessions,
}))

// ---------------------------------------------------------------------------
// Codex SDK mock
// ---------------------------------------------------------------------------

const codexMockStartThread = vi.fn()
const codexMockResumeThread = vi.fn()
const codexMockCtor = vi.fn().mockImplementation(() => ({
  startThread: codexMockStartThread,
  resumeThread: codexMockResumeThread,
}))

vi.mock('@openai/codex-sdk', () => ({
  Codex: codexMockCtor,
}))

// Import after mocking
const { ClaudeAgentAdapter } = await import('../claude/claude-adapter.js')
const { CodexAdapter } = await import('../codex/codex-adapter.js')

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

// Claude fixtures
function claudeSystem(sessionId = 'claude-sess', model = 'claude-sonnet-4-20250514') {
  return { type: 'system' as const, session_id: sessionId, model, tools: [] }
}

function claudeAssistant(text: string) {
  return { type: 'assistant' as const, content: [{ type: 'text', text }] }
}

function claudeToolStarted(name: string, input: unknown = {}) {
  return { type: 'tool_progress' as const, tool_name: name, input, status: 'started' as const }
}

function claudeToolCompleted(name: string, output: string, durationMs = 50) {
  return { type: 'tool_progress' as const, tool_name: name, output, status: 'completed' as const, duration_ms: durationMs }
}

function claudeStream(delta: string) {
  return { type: 'stream_event' as const, delta }
}

function claudeResult(opts: { result?: string; sessionId?: string; usage?: Record<string, unknown>; durationMs?: number } = {}) {
  return {
    type: 'result' as const,
    subtype: 'success',
    result: opts.result ?? 'Done',
    session_id: opts.sessionId,
    usage: opts.usage,
    duration_ms: opts.durationMs,
  }
}

// Codex fixtures
interface MockCodexStreamEvent {
  type: string
  thread_id?: string
  usage?: { input_tokens: number; output_tokens: number; cached_input_tokens?: number }
  item?: Record<string, unknown>
  error?: string
  message?: string
}

function createCodexThread(events: MockCodexStreamEvent[], finalResponse?: string) {
  return {
    runStreamed: vi.fn().mockResolvedValue({
      events: (async function* () {
        for (const e of events) yield e
      })(),
      finalResponse,
    }),
  }
}

function codexThreadStarted(threadId = 'codex-thread-1'): MockCodexStreamEvent {
  return { type: 'thread.started', thread_id: threadId }
}

function codexAgentMessage(text: string): MockCodexStreamEvent {
  return { type: 'item.completed', item: { type: 'agent_message', id: `msg-${text.slice(0, 8)}`, text } }
}

function codexCommandExec(command: string, aggregated_output: string, exit_code = 0): MockCodexStreamEvent {
  return { type: 'item.completed', item: { type: 'command_execution', id: `cmd-${command.slice(0, 8)}`, command, aggregated_output, exit_code, status: 'completed' } }
}

function codexTurnCompleted(inputTokens = 100, outputTokens = 200): MockCodexStreamEvent {
  return { type: 'turn.completed', usage: { input_tokens: inputTokens, output_tokens: outputTokens } }
}

// Shared assertion helpers
function findEvent<T extends AgentEvent['type']>(
  events: AgentEvent[],
  type: T,
): Extract<AgentEvent, { type: T }> | undefined {
  return events.find((e) => e.type === type) as Extract<AgentEvent, { type: T }> | undefined
}

function findAllEvents<T extends AgentEvent['type']>(
  events: AgentEvent[],
  type: T,
): Extract<AgentEvent, { type: T }>[] {
  return events.filter((e) => e.type === type) as Extract<AgentEvent, { type: T }>[]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Adapter Execution Flow', () => {
  let claude: InstanceType<typeof ClaudeAgentAdapter>
  let codex: InstanceType<typeof CodexAdapter>

  beforeEach(() => {
    vi.clearAllMocks()
    // Re-establish the Codex constructor mock after clearAllMocks
    codexMockCtor.mockImplementation(() => ({
      startThread: codexMockStartThread,
      resumeThread: codexMockResumeThread,
    }))
    claude = new ClaudeAgentAdapter()
    codex = new CodexAdapter()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // =========================================================================
  // 1. Side-by-side: same prompt, both adapters
  // =========================================================================

  describe('side-by-side execution', () => {
    const prompt = 'Explain how async generators work in TypeScript'
    const expectedAnswer = 'Async generators use the async function* syntax...'

    it('both adapters return non-empty content for the same prompt', async () => {
      // Claude setup
      claudeMockQuery.mockReturnValue(asyncIterableOf([
        claudeSystem(),
        claudeAssistant(expectedAnswer),
        claudeResult({ result: expectedAnswer, usage: { input_tokens: 50, output_tokens: 120 } }),
      ]))

      // Codex setup
      const codexThread = createCodexThread([
        codexThreadStarted(),
        codexAgentMessage(expectedAnswer),
        codexTurnCompleted(50, 120),
      ])
      codexMockStartThread.mockReturnValue(codexThread)

      // Execute both
      const claudeEvents = await collectEvents(claude.execute({ prompt }))
      const codexEvents = await collectEvents(codex.execute({ prompt }))

      // Both should have started + message + completed
      const claudeCompleted = findEvent(claudeEvents, 'adapter:completed')!
      const codexCompleted = findEvent(codexEvents, 'adapter:completed')!

      expect(claudeCompleted).toBeDefined()
      expect(codexCompleted).toBeDefined()

      // CRITICAL: neither result should be empty or undefined
      expect(claudeCompleted.result).toBe(expectedAnswer)
      expect(codexCompleted.result).toBe(expectedAnswer)
      expect(claudeCompleted.result.length).toBeGreaterThan(0)
      expect(codexCompleted.result.length).toBeGreaterThan(0)
    })

    it('both adapters emit events in the correct structural order', async () => {
      claudeMockQuery.mockReturnValue(asyncIterableOf([
        claudeSystem(),
        claudeAssistant('Hello'),
        claudeToolStarted('read_file', { path: 'test.ts' }),
        claudeToolCompleted('read_file', 'content'),
        claudeAssistant('Done analyzing'),
        claudeResult({ result: 'Analysis complete' }),
      ]))

      const codexThread = createCodexThread([
        codexThreadStarted(),
        codexAgentMessage('Hello'),
        codexCommandExec('cat test.ts', 'content'),
        codexAgentMessage('Done analyzing'),
        codexTurnCompleted(),
      ])
      codexMockStartThread.mockReturnValue(codexThread)

      const claudeEvents = await collectEvents(claude.execute({ prompt: 'analyze test.ts' }))
      const codexEvents = await collectEvents(codex.execute({ prompt: 'analyze test.ts' }))

      const claudeTypes = claudeEvents.map((e) => e.type)
      const codexTypes = codexEvents.map((e) => e.type)

      // Both should start with adapter:started and end with adapter:completed
      expect(claudeTypes[0]).toBe('adapter:started')
      expect(claudeTypes[claudeTypes.length - 1]).toBe('adapter:completed')
      expect(codexTypes[0]).toBe('adapter:started')
      expect(codexTypes[codexTypes.length - 1]).toBe('adapter:completed')

      // Both should have message events
      expect(claudeTypes.filter((t) => t === 'adapter:message').length).toBeGreaterThanOrEqual(1)
      expect(codexTypes.filter((t) => t === 'adapter:message').length).toBeGreaterThanOrEqual(1)
    })

    it('both adapters track token usage', async () => {
      const usage = { input_tokens: 200, output_tokens: 500, cached_input_tokens: 50 }

      claudeMockQuery.mockReturnValue(asyncIterableOf([
        claudeSystem(),
        claudeResult({ result: 'ok', usage: { ...usage, cost_cents: 3 } }),
      ]))

      const codexThread = createCodexThread([
        codexThreadStarted(),
        { type: 'turn.completed', usage },
      ])
      codexMockStartThread.mockReturnValue(codexThread)

      const claudeEvents = await collectEvents(claude.execute({ prompt }))
      const codexEvents = await collectEvents(codex.execute({ prompt }))

      const claudeCompleted = findEvent(claudeEvents, 'adapter:completed')!
      const codexCompleted = findEvent(codexEvents, 'adapter:completed')!

      // Claude has cost_cents, Codex doesn't
      expect(claudeCompleted.usage).toEqual({
        inputTokens: 200,
        outputTokens: 500,
        cachedInputTokens: 50,
        costCents: 3,
      })
      expect(codexCompleted.usage).toEqual({
        inputTokens: 200,
        outputTokens: 500,
        cachedInputTokens: 50,
      })
    })

    it('both adapters report correct providerId on all events', async () => {
      claudeMockQuery.mockReturnValue(asyncIterableOf([
        claudeSystem(),
        claudeAssistant('hi'),
        claudeResult({ result: 'done' }),
      ]))

      const codexThread = createCodexThread([
        codexThreadStarted(),
        codexAgentMessage('hi'),
        codexTurnCompleted(),
      ])
      codexMockStartThread.mockReturnValue(codexThread)

      const claudeEvents = await collectEvents(claude.execute({ prompt }))
      const codexEvents = await collectEvents(codex.execute({ prompt }))

      for (const event of claudeEvents) {
        expect((event as { providerId: string }).providerId).toBe('claude')
      }
      for (const event of codexEvents) {
        expect((event as { providerId: string }).providerId).toBe('codex')
      }
    })
  })

  // =========================================================================
  // 2. Regression: undefinedundefined bug
  // =========================================================================

  describe('regression: undefinedundefined bug', () => {
    it('Codex returns non-empty result when turn.completed follows agent_message', async () => {
      // This is the exact scenario that caused the original bug:
      // agent_message has content -> turn.completed has usage -> adapter:completed should carry the content
      const thread = createCodexThread([
        codexThreadStarted(),
        codexAgentMessage('Here is the answer to your question.'),
        codexTurnCompleted(100, 200),
      ])
      codexMockStartThread.mockReturnValue(thread)

      const events = await collectEvents(codex.execute({ prompt: 'test' }))
      const completed = findEvent(events, 'adapter:completed')!

      expect(completed).toBeDefined()
      expect(completed.result).toBe('Here is the answer to your question.')
      expect(completed.result).not.toBe('')
      expect(completed.result).not.toContain('undefined')
    })

    it('Codex returns empty string (not undefined) when no message content', async () => {
      // No agent_message events at all, just turn.completed
      const thread = createCodexThread([
        codexThreadStarted(),
        codexTurnCompleted(),
      ])
      codexMockStartThread.mockReturnValue(thread)

      const events = await collectEvents(codex.execute({ prompt: 'test' }))
      const completed = findEvent(events, 'adapter:completed')!

      expect(completed).toBeDefined()
      expect(completed.result).toBe('')
      expect(typeof completed.result).toBe('string')
    })

    it('Codex handles missing text in agent_message gracefully', async () => {
      // SDK returns an item where text is undefined (guard against bad data)
      const thread = createCodexThread([
        codexThreadStarted(),
        { type: 'item.completed', item: { type: 'agent_message', id: 'msg-1' } },
        codexTurnCompleted(),
      ])
      codexMockStartThread.mockReturnValue(thread)

      const events = await collectEvents(codex.execute({ prompt: 'test' }))
      const completed = findEvent(events, 'adapter:completed')!

      expect(completed).toBeDefined()
      // Should be empty string, NOT "undefined"
      expect(completed.result).toBe('')
      expect(completed.result).not.toContain('undefined')
    })

    it('Codex handles two missing text messages without producing undefinedundefined', async () => {
      // This is the EXACT reproduction: two messages with no text field
      const thread = createCodexThread([
        codexThreadStarted(),
        { type: 'item.completed', item: { type: 'agent_message', id: 'msg-1' } },
        { type: 'item.completed', item: { type: 'agent_message', id: 'msg-2' } },
        codexTurnCompleted(),
      ])
      codexMockStartThread.mockReturnValue(thread)

      const events = await collectEvents(codex.execute({ prompt: 'test' }))
      const completed = findEvent(events, 'adapter:completed')!
      const messages = findAllEvents(events, 'adapter:message')

      // Messages should have empty content, not "undefined"
      for (const msg of messages) {
        expect(msg.content).toBe('')
        expect(typeof msg.content).toBe('string')
      }

      // Completed result should not be "undefinedundefined"
      expect(completed.result).not.toContain('undefined')
    })

    it('Codex uses last agent_message as final result when turn.completed has usage', async () => {
      // The last agent_message text should be captured as the final result
      const thread = createCodexThread([
        codexThreadStarted(),
        codexAgentMessage('intermediate'),
        codexTurnCompleted(100, 200),
      ])
      codexMockStartThread.mockReturnValue(thread)

      const events = await collectEvents(codex.execute({ prompt: 'test' }))
      const completed = findEvent(events, 'adapter:completed')!

      expect(completed.result).toBe('intermediate')
      expect(completed.usage).toEqual({ inputTokens: 100, outputTokens: 200, cachedInputTokens: undefined })
    })

    it('Codex emits exactly one adapter:completed event per execution', async () => {
      const thread = createCodexThread([
        codexThreadStarted(),
        codexAgentMessage('response text'),
        codexTurnCompleted(50, 100),
      ])
      codexMockStartThread.mockReturnValue(thread)

      const events = await collectEvents(codex.execute({ prompt: 'test' }))
      const completedEvents = findAllEvents(events, 'adapter:completed')

      expect(completedEvents).toHaveLength(1)
    })
  })

  // =========================================================================
  // 3. Monitoring: capabilities comparison
  // =========================================================================

  describe('monitoring: capabilities', () => {
    it('Claude and Codex report accurate capability profiles', () => {
      const claudeCaps = claude.getCapabilities()
      const codexCaps = codex.getCapabilities()

      // Claude has more capabilities
      expect(claudeCaps.supportsResume).toBe(true)
      expect(claudeCaps.supportsFork).toBe(true)
      expect(claudeCaps.supportsToolCalls).toBe(true)
      expect(claudeCaps.supportsStreaming).toBe(true)
      expect(claudeCaps.supportsCostUsage).toBe(true)

      // Codex supports most but not fork
      expect(codexCaps.supportsResume).toBe(true)
      expect(codexCaps.supportsFork).toBe(false)
      expect(codexCaps.supportsToolCalls).toBe(true)
      expect(codexCaps.supportsStreaming).toBe(true)
      expect(codexCaps.supportsCostUsage).toBe(true)
    })

    it('Claude has listSessions, Codex does not', () => {
      expect(typeof claude.listSessions).toBe('function')
      expect((codex as Record<string, unknown>).listSessions).toBeUndefined()
    })

    it('Claude has forkSession, Codex does not', () => {
      expect(typeof claude.forkSession).toBe('function')
      expect((codex as Record<string, unknown>).forkSession).toBeUndefined()
    })
  })

  // =========================================================================
  // 4. Health checks
  // =========================================================================

  describe('monitoring: health checks', () => {
    it('both adapters report healthy when SDK is available', async () => {
      const claudeHealth = await claude.healthCheck()
      const codexHealth = await codex.healthCheck()

      expect(claudeHealth.healthy).toBe(true)
      expect(claudeHealth.providerId).toBe('claude')
      expect(claudeHealth.sdkInstalled).toBe(true)

      expect(codexHealth.healthy).toBe(true)
      expect(codexHealth.providerId).toBe('codex')
      expect(codexHealth.sdkInstalled).toBe(true)
    })

    it('health check returns structured HealthStatus shape', async () => {
      const health = await claude.healthCheck()

      expect(health).toHaveProperty('healthy')
      expect(health).toHaveProperty('providerId')
      expect(health).toHaveProperty('sdkInstalled')
      expect(health).toHaveProperty('cliAvailable')
      expect(typeof health.healthy).toBe('boolean')
      expect(typeof health.providerId).toBe('string')
    })
  })

  // =========================================================================
  // 5. Model override
  // =========================================================================

  describe('model override', () => {
    it('Claude respects model override via config', async () => {
      const claudeOpus = new ClaudeAgentAdapter({ model: 'claude-opus-4-6' })
      claudeMockQuery.mockReturnValue(asyncIterableOf([
        claudeSystem('s1', 'claude-sonnet-4-20250514'),
        claudeResult({ result: 'ok' }),
      ]))

      const events = await collectEvents(claudeOpus.execute({ prompt: 'test' }))
      const started = findEvent(events, 'adapter:started')!
      // Config model overrides SDK-reported model
      expect(started.model).toBe('claude-opus-4-6')
    })

    it('Codex respects model override via config', async () => {
      const codexCustom = new CodexAdapter({ model: 'gpt-5.3-codex' })
      const thread = createCodexThread([codexThreadStarted(), codexTurnCompleted()])
      codexMockStartThread.mockReturnValue(thread)

      const events = await collectEvents(codexCustom.execute({ prompt: 'test' }))
      const started = findEvent(events, 'adapter:started')!
      expect(started.model).toBe('gpt-5.3-codex')

      // Also verify it was passed to the SDK
      expect(codexMockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.3-codex' }),
      )
    })

    it('Codex respects model override via input.options', async () => {
      const thread = createCodexThread([codexThreadStarted(), codexTurnCompleted()])
      codexMockStartThread.mockReturnValue(thread)

      await collectEvents(
        codex.execute({ prompt: 'test', options: { model: 'gpt-5.3-codex' } }),
      )

      expect(codexMockStartThread).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.3-codex' }),
      )
    })
  })

  // =========================================================================
  // 6. Tool call events (monitoring tool usage)
  // =========================================================================

  describe('tool call monitoring', () => {
    it('Claude emits tool_call with input and tool_result with output', async () => {
      claudeMockQuery.mockReturnValue(asyncIterableOf([
        claudeSystem(),
        claudeToolStarted('read_file', { path: 'src/main.ts' }),
        claudeToolCompleted('read_file', 'export default 42', 30),
        claudeResult({ result: 'ok' }),
      ]))

      const events = await collectEvents(claude.execute({ prompt: 'read main.ts' }))
      const toolCall = findEvent(events, 'adapter:tool_call')!
      const toolResult = findEvent(events, 'adapter:tool_result')!

      expect(toolCall.toolName).toBe('read_file')
      expect(toolCall.input).toEqual({ path: 'src/main.ts' })
      expect(toolResult.toolName).toBe('read_file')
      expect(toolResult.output).toBe('export default 42')
      expect(toolResult.durationMs).toBe(30)
    })

    it('Codex emits tool_call/tool_result pairs for command_execution', async () => {
      const thread = createCodexThread([
        codexThreadStarted(),
        codexCommandExec('npm test', 'All tests pass\n5 passed', 0),
        codexTurnCompleted(),
      ])
      codexMockStartThread.mockReturnValue(thread)

      const events = await collectEvents(codex.execute({ prompt: 'run tests' }))
      const toolCall = findEvent(events, 'adapter:tool_call')!
      const toolResult = findEvent(events, 'adapter:tool_result')!

      expect(toolCall.toolName).toBe('shell')
      expect(toolCall.input).toEqual({ command: 'npm test' })
      expect(toolResult.toolName).toBe('shell')
      expect(toolResult.output).toBe('All tests pass\n5 passed')
    })

    it('Codex maps MCP tool calls correctly', async () => {
      const thread = createCodexThread([
        codexThreadStarted(),
        {
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            id: 'mcp-1',
            server: 'docs-server',
            tool: 'search_docs',
            arguments: { query: 'async' },
            result: { content: ['Found 3 results'], structured_content: null },
            status: 'completed',
          },
        },
        codexTurnCompleted(),
      ])
      codexMockStartThread.mockReturnValue(thread)

      const events = await collectEvents(codex.execute({ prompt: 'search' }))
      const toolCalls = findAllEvents(events, 'adapter:tool_call')
      const toolResults = findAllEvents(events, 'adapter:tool_result')

      expect(toolCalls).toHaveLength(1)
      expect(toolCalls[0].toolName).toBe('docs-server/search_docs')
      expect(toolResults).toHaveLength(1)
      expect(toolResults[0].output).toBe(JSON.stringify(['Found 3 results']))
    })
  })

  // =========================================================================
  // 7. Correlation ID propagation
  // =========================================================================

  describe('correlation ID propagation', () => {
    it('Claude propagates correlationId to all events', async () => {
      claudeMockQuery.mockReturnValue(asyncIterableOf([
        claudeSystem(),
        claudeAssistant('answer'),
        claudeResult({ result: 'done' }),
      ]))

      const events = await collectEvents(
        claude.execute({ prompt: 'test', correlationId: 'req-123' }),
      )

      // All events should carry the correlationId
      for (const event of events) {
        expect((event as { correlationId?: string }).correlationId).toBe('req-123')
      }
    })

    it('Codex propagates correlationId to all events', async () => {
      const thread = createCodexThread([
        codexThreadStarted(),
        codexAgentMessage('answer'),
        codexTurnCompleted(),
      ])
      codexMockStartThread.mockReturnValue(thread)

      const events = await collectEvents(
        codex.execute({ prompt: 'test', correlationId: 'req-456' }),
      )

      for (const event of events) {
        expect((event as { correlationId?: string }).correlationId).toBe('req-456')
      }
    })
  })

  // =========================================================================
  // 8. Session management (Claude only)
  // =========================================================================

  describe('Claude session management', () => {
    it('listSessions returns mapped SessionInfo array', async () => {
      claudeMockListSessions.mockResolvedValue([
        {
          session_id: 'sess-1',
          created_at: '2026-01-15T10:00:00Z',
          last_active_at: '2026-01-15T11:00:00Z',
          cwd: '/project/a',
          metadata: { branch: 'main' },
        },
      ])

      const sessions = await claude.listSessions()

      expect(sessions).toHaveLength(1)
      expect(sessions[0].sessionId).toBe('sess-1')
      expect(sessions[0].providerId).toBe('claude')
      expect(sessions[0].workingDirectory).toBe('/project/a')
      expect(sessions[0].metadata).toEqual({ branch: 'main' })
    })

    it('resumeSession sets isResume=true on started event', async () => {
      claudeMockQuery.mockReturnValue(asyncIterableOf([
        claudeSystem('sess-resumed'),
        claudeResult({ result: 'continued' }),
      ]))

      const events = await collectEvents(
        claude.resumeSession('sess-to-resume', { prompt: 'continue' }),
      )

      const started = findEvent(events, 'adapter:started')!
      expect(started.isResume).toBe(true)
    })

    it('Codex resumeSession uses resumeThread', async () => {
      const thread = createCodexThread([
        codexThreadStarted('thread-resume'),
        codexAgentMessage('continued'),
        codexTurnCompleted(),
      ])
      codexMockResumeThread.mockReturnValue(thread)

      const events = await collectEvents(
        codex.resumeSession('thread-resume', { prompt: 'continue' }),
      )

      expect(codexMockResumeThread).toHaveBeenCalledWith(
        'thread-resume',
        expect.any(Object),
      )
      const started = findEvent(events, 'adapter:started')!
      expect(started.isResume).toBe(true)
      const completed = findEvent(events, 'adapter:completed')!
      expect(completed.result).toBe('continued')
    })
  })

  // =========================================================================
  // 9. Error handling comparison
  // =========================================================================

  describe('error handling', () => {
    it('Claude emits adapter:failed on error result subtype', async () => {
      claudeMockQuery.mockReturnValue(asyncIterableOf([
        claudeSystem('sess-err'),
        { type: 'result' as const, subtype: 'error_max_turns', error: 'Max turns exceeded', session_id: 'sess-err' },
      ]))

      const events = await collectEvents(claude.execute({ prompt: 'test' }))
      const failed = findEvent(events, 'adapter:failed')!

      expect(failed.providerId).toBe('claude')
      expect(failed.error).toBe('Max turns exceeded')
      expect(failed.code).toBe('error_max_turns')
    })

    it('Codex emits adapter:failed on turn.failed', async () => {
      const thread = createCodexThread([
        codexThreadStarted(),
        { type: 'turn.failed', error: 'Rate limit exceeded' },
      ])
      codexMockStartThread.mockReturnValue(thread)

      const events = await collectEvents(codex.execute({ prompt: 'test' }))
      const failed = findEvent(events, 'adapter:failed')!

      expect(failed.providerId).toBe('codex')
      expect(failed.error).toBe('Rate limit exceeded')
    })

    it('Codex emits adapter:failed when runStreamed throws', async () => {
      const thread = {
        runStreamed: vi.fn().mockRejectedValue(new Error('API key invalid')),
      }
      codexMockStartThread.mockReturnValue(thread)

      const events = await collectEvents(codex.execute({ prompt: 'test' }))
      const failed = findEvent(events, 'adapter:failed')!

      expect(failed.error).toBe('API key invalid')
      expect(failed.code).toBe('ADAPTER_EXECUTION_FAILED')
    })
  })

  // =========================================================================
  // 10. Streaming comparison
  // =========================================================================

  describe('streaming', () => {
    it('Claude emits stream_delta events for incremental output', async () => {
      claudeMockQuery.mockReturnValue(asyncIterableOf([
        claudeSystem(),
        claudeStream('Hello '),
        claudeStream('world'),
        claudeResult({ result: 'Hello world' }),
      ]))

      const events = await collectEvents(claude.execute({ prompt: 'greet' }))
      const deltas = findAllEvents(events, 'adapter:stream_delta')

      expect(deltas).toHaveLength(2)
      expect(deltas[0].content).toBe('Hello ')
      expect(deltas[1].content).toBe('world')
    })

    it('Codex does not produce stream_delta (SDK does not expose them)', async () => {
      // Codex SDK only provides item.completed, not incremental deltas
      const thread = createCodexThread([
        codexThreadStarted(),
        codexAgentMessage('Full response'),
        codexTurnCompleted(),
      ])
      codexMockStartThread.mockReturnValue(thread)

      const events = await collectEvents(codex.execute({ prompt: 'greet' }))
      const deltas = findAllEvents(events, 'adapter:stream_delta')

      expect(deltas).toHaveLength(0)
    })
  })

  // =========================================================================
  // 11. Complex multi-step execution (full conversation)
  // =========================================================================

  describe('complex multi-step execution', () => {
    it('Claude handles full conversation with tools and multiple messages', async () => {
      claudeMockQuery.mockReturnValue(asyncIterableOf([
        claudeSystem('full-conv'),
        claudeAssistant('Let me check the code'),
        claudeToolStarted('read_file', { path: 'src/app.ts' }),
        claudeToolCompleted('read_file', 'export const app = express()', 25),
        claudeStream('I see '),
        claudeStream('an Express app'),
        claudeAssistant('The project uses Express for the HTTP server.'),
        claudeResult({
          result: 'Analysis complete. The project uses Express.',
          sessionId: 'full-conv',
          usage: { input_tokens: 500, output_tokens: 300, cost_cents: 5 },
          durationMs: 3000,
        }),
      ]))

      const events = await collectEvents(claude.execute({ prompt: 'analyze the project' }))
      const types = events.map((e) => e.type)

      expect(types).toEqual([
        'adapter:started',
        'adapter:message',
        'adapter:tool_call',
        'adapter:tool_result',
        'adapter:stream_delta',
        'adapter:stream_delta',
        'adapter:message',
        'adapter:completed',
      ])
    })

    it('Codex handles full conversation with commands and file changes', async () => {
      const thread = createCodexThread([
        codexThreadStarted('full-thread'),
        codexAgentMessage('I will fix the bug'),
        codexCommandExec('cat src/bug.ts', 'const x = undefined + undefined', 0),
        { type: 'item.completed', item: { type: 'file_change', id: 'patch-1', changes: [{ path: 'src/bug.ts', kind: 'update' }], status: 'completed' } },
        codexAgentMessage('Fixed the undefined concatenation bug'),
        codexTurnCompleted(300, 500),
      ])
      codexMockStartThread.mockReturnValue(thread)

      const events = await collectEvents(codex.execute({ prompt: 'fix the bug in src/bug.ts' }))
      const types = events.map((e) => e.type)

      expect(types).toEqual([
        'adapter:started',
        'adapter:message',      // I will fix the bug
        'adapter:tool_call',    // shell cat
        'adapter:tool_result',  // shell output
        'adapter:tool_result',  // file_edit
        'adapter:message',      // Fixed the bug
        'adapter:completed',
      ])

      const completed = findEvent(events, 'adapter:completed')!
      expect(completed.result).toBe('Fixed the undefined concatenation bug')
      expect(completed.usage).toEqual({ inputTokens: 300, outputTokens: 500, cachedInputTokens: undefined })
    })
  })

  // =========================================================================
  // 12. Adapter feature matrix validation
  // =========================================================================

  describe('adapter feature matrix', () => {
    const adapters = [
      { name: 'Claude', create: () => new ClaudeAgentAdapter() },
      { name: 'Codex', create: () => new CodexAdapter() },
    ] as const

    for (const { name, create } of adapters) {
      describe(name, () => {
        it('implements providerId', () => {
          const adapter = create()
          expect(adapter.providerId).toBeTruthy()
          expect(typeof adapter.providerId).toBe('string')
        })

        it('implements execute()', () => {
          const adapter = create()
          expect(typeof adapter.execute).toBe('function')
        })

        it('implements healthCheck()', async () => {
          const adapter = create()
          const health = await adapter.healthCheck()
          expect(health).toHaveProperty('healthy')
          expect(health).toHaveProperty('providerId')
        })

        it('implements configure()', () => {
          const adapter = create()
          // Should not throw
          adapter.configure({ model: 'test-model' })
        })

        it('implements getCapabilities()', () => {
          const adapter = create()
          const caps = adapter.getCapabilities()
          expect(caps).toHaveProperty('supportsResume')
          expect(caps).toHaveProperty('supportsFork')
          expect(caps).toHaveProperty('supportsToolCalls')
          expect(caps).toHaveProperty('supportsStreaming')
          expect(caps).toHaveProperty('supportsCostUsage')
        })

        it('implements interrupt() without throwing', () => {
          const adapter = create()
          expect(() => adapter.interrupt()).not.toThrow()
        })
      })
    }
  })
})
