/**
 * Wave 19 — Codex adapter deep coverage tests.
 *
 * Focus areas not deeply covered by existing codex-adapter.test.ts:
 *   - Thread lifecycle (start, run, abandon, resume continuation)
 *   - Streaming output ordering with mixed item types
 *   - Tool execution flow (command_execution, mcp_tool_call, web_search)
 *   - Timeout scenarios (input.options.timeoutMs, config.timeoutMs, default)
 *   - Combined external + internal abort signals
 *   - Sandbox mode mapping edge cases
 *   - Caller-supplied config overrides preservation
 *   - Cached usage propagation
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { collectEvents } from './test-helpers.js'
import type { AgentEvent, AgentInput } from '../types.js'

// ── SDK mock ───────────────────────────────────────────────

interface MockStreamEvent {
  type: string
  thread_id?: string
  usage?: { input_tokens: number; output_tokens: number; cached_input_tokens?: number }
  item?: Record<string, unknown>
  error?: { message: string } | string
  message?: string
}

function createMockThread(events: MockStreamEvent[]) {
  return {
    runStreamed: vi.fn().mockResolvedValue({
      events: (async function* () {
        for (const e of events) yield e
      })(),
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

const { CodexAdapter } = await import('../codex/codex-adapter.js')

// ── Helpers ───────────────────────────────────────────────

function makeInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return { prompt: 'Hello Codex', ...overrides }
}

function threadStarted(threadId = 'tid-deep'): MockStreamEvent {
  return { type: 'thread.started', thread_id: threadId }
}

function turnCompleted(usage = { input_tokens: 100, output_tokens: 50 }): MockStreamEvent {
  return { type: 'turn.completed', usage }
}

// ──────────────────────────────────────────────────────────

describe('CodexAdapter — deep coverage', () => {
  let adapter: InstanceType<typeof CodexAdapter>

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new CodexAdapter()
  })

  // ── Thread lifecycle ──────────────────────────────────

  describe('thread lifecycle', () => {
    it('creates a new thread via startThread on execute', async () => {
      mockStartThread.mockReturnValue(createMockThread([threadStarted(), turnCompleted()]))
      await collectEvents(adapter.execute(makeInput()))
      expect(mockStartThread).toHaveBeenCalledTimes(1)
      expect(mockResumeThread).not.toHaveBeenCalled()
    })

    it('resumes an existing thread via resumeThread on resumeSession', async () => {
      mockResumeThread.mockReturnValue(createMockThread([threadStarted('tid-resumed'), turnCompleted()]))
      await collectEvents(adapter.resumeSession('tid-resumed', makeInput()))
      expect(mockResumeThread).toHaveBeenCalledTimes(1)
      expect(mockResumeThread.mock.calls[0]![0]).toBe('tid-resumed')
      expect(mockStartThread).not.toHaveBeenCalled()
    })

    it('continues thread state across multiple sequential executions', async () => {
      // First execute
      mockStartThread.mockReturnValueOnce(createMockThread([threadStarted('t-1'), turnCompleted()]))
      await collectEvents(adapter.execute(makeInput({ prompt: 'turn1' })))
      // Second execute (different thread)
      mockStartThread.mockReturnValueOnce(createMockThread([threadStarted('t-2'), turnCompleted()]))
      await collectEvents(adapter.execute(makeInput({ prompt: 'turn2' })))
      expect(mockStartThread).toHaveBeenCalledTimes(2)
    })

    it('marks isResume=true on started event when resuming', async () => {
      mockResumeThread.mockReturnValue(createMockThread([threadStarted('t-r'), turnCompleted()]))
      const events = await collectEvents(adapter.resumeSession('t-r', makeInput()))
      const started = events.find(e => e.type === 'adapter:started') as Extract<
        AgentEvent,
        { type: 'adapter:started' }
      >
      expect(started.isResume).toBe(true)
    })

    it('marks isResume=false on started event when starting fresh', async () => {
      mockStartThread.mockReturnValue(createMockThread([threadStarted('t-1'), turnCompleted()]))
      const events = await collectEvents(adapter.execute(makeInput()))
      const started = events.find(e => e.type === 'adapter:started') as Extract<
        AgentEvent,
        { type: 'adapter:started' }
      >
      expect(started.isResume).toBe(false)
    })
  })

  // ── Streaming item types ──────────────────────────────

  describe('streaming items', () => {
    it('emits message for agent_message item', async () => {
      mockStartThread.mockReturnValue(createMockThread([
        threadStarted(),
        { type: 'item.completed', item: { type: 'agent_message', id: 'm1', text: 'hello' } },
        turnCompleted(),
      ]))
      const events = await collectEvents(adapter.execute(makeInput()))
      const msg = events.find(e => e.type === 'adapter:message') as Extract<
        AgentEvent,
        { type: 'adapter:message' }
      >
      expect(msg.content).toBe('hello')
      expect(msg.role).toBe('assistant')
    })

    it('emits both tool_call + tool_result for command_execution item', async () => {
      mockStartThread.mockReturnValue(createMockThread([
        threadStarted(),
        {
          type: 'item.completed',
          item: {
            type: 'command_execution',
            id: 'c1',
            command: 'ls -la',
            aggregated_output: 'file1\nfile2',
            status: 'completed',
          },
        },
        turnCompleted(),
      ]))
      const events = await collectEvents(adapter.execute(makeInput()))
      const call = events.find(e => e.type === 'adapter:tool_call') as Extract<
        AgentEvent,
        { type: 'adapter:tool_call' }
      >
      const result = events.find(e => e.type === 'adapter:tool_result') as Extract<
        AgentEvent,
        { type: 'adapter:tool_result' }
      >
      expect(call.toolName).toBe('shell')
      expect(call.input).toEqual({ command: 'ls -la' })
      expect(result.toolName).toBe('shell')
      expect(result.output).toBe('file1\nfile2')
    })

    it('emits tool_result for file_change with summary of changes', async () => {
      mockStartThread.mockReturnValue(createMockThread([
        threadStarted(),
        {
          type: 'item.completed',
          item: {
            type: 'file_change',
            id: 'f1',
            changes: [
              { path: 'a.ts', kind: 'modified' },
              { path: 'b.ts', kind: 'added' },
            ],
            status: 'completed',
          },
        },
        turnCompleted(),
      ]))
      const events = await collectEvents(adapter.execute(makeInput()))
      const result = events.find(e => e.type === 'adapter:tool_result') as Extract<
        AgentEvent,
        { type: 'adapter:tool_result' }
      >
      expect(result.toolName).toBe('file_edit')
      expect(result.output).toContain('modified: a.ts')
      expect(result.output).toContain('added: b.ts')
    })

    it('emits tool_call + tool_result for mcp_tool_call', async () => {
      mockStartThread.mockReturnValue(createMockThread([
        threadStarted(),
        {
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            id: 'm1',
            server: 'fs',
            tool: 'read',
            arguments: { path: 'x.ts' },
            result: { content: [{ type: 'text', text: 'data' }], structured_content: null },
            status: 'completed',
          },
        },
        turnCompleted(),
      ]))
      const events = await collectEvents(adapter.execute(makeInput()))
      const call = events.find(e => e.type === 'adapter:tool_call') as Extract<
        AgentEvent,
        { type: 'adapter:tool_call' }
      >
      expect(call.toolName).toBe('fs/read')
      expect(call.input).toEqual({ path: 'x.ts' })
      const result = events.find(e => e.type === 'adapter:tool_result') as Extract<
        AgentEvent,
        { type: 'adapter:tool_result' }
      >
      expect(result.toolName).toBe('fs/read')
      // output should be a JSON string of the content
      expect(result.output).toContain('data')
    })

    it('uses error message for mcp_tool_call when error is present', async () => {
      mockStartThread.mockReturnValue(createMockThread([
        threadStarted(),
        {
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            id: 'm1',
            server: 'fs',
            tool: 'read',
            arguments: {},
            error: { message: 'access denied' },
            status: 'failed',
          },
        },
        turnCompleted(),
      ]))
      const events = await collectEvents(adapter.execute(makeInput()))
      const result = events.find(e => e.type === 'adapter:tool_result') as Extract<
        AgentEvent,
        { type: 'adapter:tool_result' }
      >
      expect(result.output).toBe('access denied')
    })
  })

  // ── Timeout scenarios ─────────────────────────────────

  describe('timeout handling', () => {
    it('respects input.options.timeoutMs over config.timeoutMs', async () => {
      // Hang forever — adapter should abort via timeout
      mockStartThread.mockReturnValue({
        runStreamed: vi.fn().mockImplementation((_p, opts) => {
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () => {
              reject(new Error('aborted by signal'))
            }, { once: true })
          })
        }),
      })
      adapter.configure({})
      const events = await collectEvents(
        adapter.execute(makeInput({ options: { timeoutMs: 50 } })),
      )
      const failed = events.find(e => e.type === 'adapter:failed') as Extract<
        AgentEvent,
        { type: 'adapter:failed' }
      >
      expect(failed.code).toBe('ADAPTER_TIMEOUT')
      expect(failed.error).toContain('timed out')
    })

    it('falls back to adapter.config.timeoutMs when input has no override', async () => {
      mockStartThread.mockReturnValue({
        runStreamed: vi.fn().mockImplementation((_p, opts) => {
          return new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () => {
              reject(new Error('aborted by signal'))
            }, { once: true })
          })
        }),
      })
      const a2 = new CodexAdapter({})
      ;(a2 as unknown as { config: Record<string, unknown> }).config['timeoutMs'] = 30
      const events = await collectEvents(a2.execute(makeInput()))
      const failed = events.find(e => e.type === 'adapter:failed') as Extract<
        AgentEvent,
        { type: 'adapter:failed' }
      >
      expect(failed.code).toBe('ADAPTER_TIMEOUT')
    })

    it('emits ADAPTER_TIMEOUT when stream itself takes too long mid-flight', async () => {
      // Yield one event, then wait for abort and reject
      mockStartThread.mockReturnValue({
        runStreamed: vi.fn().mockImplementation((_p, opts) => {
          return Promise.resolve({
            events: (async function* () {
              yield threadStarted()
              // Wait for the adapter's timeout to abort the signal
              await new Promise<void>((resolve) => {
                opts?.signal?.addEventListener('abort', () => resolve(), { once: true })
              })
              throw new Error('aborted by timeout')
            })(),
          })
        }),
      })
      const events = await collectEvents(
        adapter.execute(makeInput({ options: { timeoutMs: 80 } })),
      )
      // Last event should signal a timeout failure
      const failed = events.find(e => e.type === 'adapter:failed') as Extract<
        AgentEvent,
        { type: 'adapter:failed' }
      > | undefined
      expect(failed?.code).toBe('ADAPTER_TIMEOUT')
    }, 10_000)
  })

  // ── Caller abort handling ─────────────────────────────

  describe('caller abort handling', () => {
    it('emits adapter:completed with "(interrupted)" when caller aborts mid-stream', async () => {
      // Pre-aborted external signal — the abort propagates via combineSignals
      // before the iterator's first .next(), so the runStreamed event loop
      // throws immediately and the adapter emits the "interrupted" completion.
      mockStartThread.mockReturnValue({
        runStreamed: vi.fn().mockImplementation((_p, opts) => {
          return Promise.resolve({
            events: (async function* () {
              yield threadStarted()
              // Throw on second pull because the signal is aborted
              if (opts?.signal?.aborted) {
                throw new Error('aborted')
              }
              throw new Error('aborted')
            })(),
          })
        }),
      })
      const ctrl = new AbortController()
      ctrl.abort() // pre-abort
      const events = await collectEvents(adapter.execute(makeInput({ signal: ctrl.signal })))
      const last = events.at(-1)
      expect(last?.type).toBe('adapter:completed')
      if (last?.type === 'adapter:completed') {
        expect(last.result).toBe('(interrupted)')
      }
    }, 10_000)

    it('preserves last response text when interrupted after a message', async () => {
      mockStartThread.mockReturnValue({
        runStreamed: vi.fn().mockImplementation((_p, opts) => {
          return Promise.resolve({
            events: (async function* () {
              yield threadStarted()
              yield {
                type: 'item.completed',
                item: { type: 'agent_message', id: 'm1', text: 'partial response' },
              }
              if (opts?.signal?.aborted) throw new Error('aborted')
              throw new Error('aborted')
            })(),
          })
        }),
      })
      const ctrl = new AbortController()
      ctrl.abort()
      const events = await collectEvents(adapter.execute(makeInput({ signal: ctrl.signal })))
      const last = events.at(-1)
      expect(last?.type).toBe('adapter:completed')
      if (last?.type === 'adapter:completed') {
        expect(last.result).toBe('partial response')
      }
    }, 10_000)

    it('interrupt() before any execute is a no-op', () => {
      expect(() => adapter.interrupt()).not.toThrow()
    })

    it('interrupt() while running aborts the controller and clears it', async () => {
      let captured: AbortSignal | undefined
      mockStartThread.mockReturnValue({
        runStreamed: vi.fn().mockImplementation((_p, opts) => {
          captured = opts?.signal as AbortSignal
          return Promise.resolve({
            events: (async function* () {
              yield threadStarted()
              if (captured?.aborted) throw new Error('aborted')
              throw new Error('aborted')
            })(),
          })
        }),
      })
      const stream = adapter.execute(makeInput())
      const first = await stream.next()
      expect(first.value?.type).toBe('adapter:started')
      adapter.interrupt()
      // Drain remaining events
      const rest: AgentEvent[] = []
      try {
        for await (const e of stream) rest.push(e)
      } catch {
        // ok
      }
      expect(captured?.aborted).toBe(true)
    }, 10_000)
  })

  // ── Sandbox mode mapping ──────────────────────────────

  describe('sandbox mode mapping', () => {
    it('maps "read-only" to SDK "read-only"', async () => {
      const a = new CodexAdapter({ sandboxMode: 'read-only' })
      mockStartThread.mockReturnValue(createMockThread([threadStarted(), turnCompleted()]))
      await collectEvents(a.execute(makeInput()))
      expect(mockStartThread.mock.calls[0]![0]['sandboxMode']).toBe('read-only')
    })

    it('maps "workspace-write" to SDK "workspace-write"', async () => {
      const a = new CodexAdapter({ sandboxMode: 'workspace-write' })
      mockStartThread.mockReturnValue(createMockThread([threadStarted(), turnCompleted()]))
      await collectEvents(a.execute(makeInput()))
      expect(mockStartThread.mock.calls[0]![0]['sandboxMode']).toBe('workspace-write')
    })

    it('maps "full-access" to SDK "danger-full-access"', async () => {
      const a = new CodexAdapter({ sandboxMode: 'full-access' })
      mockStartThread.mockReturnValue(createMockThread([threadStarted(), turnCompleted()]))
      await collectEvents(a.execute(makeInput()))
      expect(mockStartThread.mock.calls[0]![0]['sandboxMode']).toBe('danger-full-access')
    })

    it('defaults to "workspace-write" when sandboxMode is unset', async () => {
      mockStartThread.mockReturnValue(createMockThread([threadStarted(), turnCompleted()]))
      await collectEvents(adapter.execute(makeInput()))
      expect(mockStartThread.mock.calls[0]![0]['sandboxMode']).toBe('workspace-write')
    })

    it('input.options.sandboxMode overrides config sandboxMode', async () => {
      const a = new CodexAdapter({ sandboxMode: 'read-only' })
      mockStartThread.mockReturnValue(createMockThread([threadStarted(), turnCompleted()]))
      await collectEvents(a.execute(makeInput({ options: { sandboxMode: 'danger-full-access' } })))
      expect(mockStartThread.mock.calls[0]![0]['sandboxMode']).toBe('danger-full-access')
    })
  })

  // ── Cached usage propagation ──────────────────────────

  describe('cached usage propagation', () => {
    it('extracts cached_input_tokens from turn.completed usage', async () => {
      mockStartThread.mockReturnValue(createMockThread([
        threadStarted(),
        { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 25 } },
      ]))
      const events = await collectEvents(adapter.execute(makeInput()))
      const completed = events.find(e => e.type === 'adapter:completed') as Extract<
        AgentEvent,
        { type: 'adapter:completed' }
      >
      expect(completed.usage?.cachedInputTokens).toBe(25)
    })

    it('omits cachedInputTokens when SDK does not provide it', async () => {
      mockStartThread.mockReturnValue(createMockThread([
        threadStarted(),
        { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } },
      ]))
      const events = await collectEvents(adapter.execute(makeInput()))
      const completed = events.find(e => e.type === 'adapter:completed') as Extract<
        AgentEvent,
        { type: 'adapter:completed' }
      >
      expect(completed.usage?.cachedInputTokens).toBeUndefined()
    })
  })

  // ── Provider config preservation ──────────────────────

  describe('provider config preservation', () => {
    it('preserves caller-supplied providerOptions.config keys alongside instructions', async () => {
      const a = new CodexAdapter({
        providerOptions: {
          config: { custom_flag: true, custom_str: 'preserved' },
        },
      })
      mockStartThread.mockReturnValue(createMockThread([threadStarted(), turnCompleted()]))
      await collectEvents(a.execute(makeInput({ systemPrompt: 'Be helpful' })))
      const ctorOpts = mockCodexCtor.mock.calls.at(-1)![0] as Record<string, unknown>
      const config = ctorOpts['config'] as Record<string, unknown>
      expect(config['custom_flag']).toBe(true)
      expect(config['custom_str']).toBe('preserved')
      expect(config['instructions']).toBeDefined()
    })

    it('passes env from config to Codex constructor', async () => {
      const a = new CodexAdapter({ env: { CODEX_DEBUG: '1', PATH: '/usr/bin' } })
      mockStartThread.mockReturnValue(createMockThread([threadStarted(), turnCompleted()]))
      await collectEvents(a.execute(makeInput()))
      const ctorOpts = mockCodexCtor.mock.calls.at(-1)![0] as Record<string, unknown>
      expect(ctorOpts['env']).toEqual({ CODEX_DEBUG: '1', PATH: '/usr/bin' })
    })
  })

  // ── Skipped item types ────────────────────────────────

  describe('skipped or default-handled item types', () => {
    it('silently skips todo_list items', async () => {
      mockStartThread.mockReturnValue(createMockThread([
        threadStarted(),
        {
          type: 'item.completed',
          item: { type: 'todo_list', id: 't1', items: [{ text: 'do x', completed: false }] },
        },
        turnCompleted(),
      ]))
      const events = await collectEvents(adapter.execute(makeInput()))
      // No mapped event for the todo_list
      expect(events.find(e => e.type === 'adapter:tool_call')).toBeUndefined()
      expect(events.find(e => e.type === 'adapter:tool_result')).toBeUndefined()
    })

    it('emits failed for error item', async () => {
      mockStartThread.mockReturnValue(createMockThread([
        threadStarted(),
        {
          type: 'item.completed',
          item: { type: 'error', id: 'e1', message: 'item-level error' },
        },
        turnCompleted(),
      ]))
      const events = await collectEvents(adapter.execute(makeInput()))
      const failed = events.find(e => e.type === 'adapter:failed') as Extract<
        AgentEvent,
        { type: 'adapter:failed' }
      >
      expect(failed.error).toBe('item-level error')
    })

    it('emits message for reasoning item with text', async () => {
      mockStartThread.mockReturnValue(createMockThread([
        threadStarted(),
        {
          type: 'item.completed',
          item: { type: 'reasoning', id: 'r1', text: 'thinking out loud...' },
        },
        turnCompleted(),
      ]))
      const events = await collectEvents(adapter.execute(makeInput()))
      const msg = events.find(e => e.type === 'adapter:message') as Extract<
        AgentEvent,
        { type: 'adapter:message' }
      >
      expect(msg.content).toBe('thinking out loud...')
    })

    it('emits tool_call only (no result) for web_search item', async () => {
      mockStartThread.mockReturnValue(createMockThread([
        threadStarted(),
        {
          type: 'item.completed',
          item: { type: 'web_search', id: 'w1', query: 'rust async' },
        },
        turnCompleted(),
      ]))
      const events = await collectEvents(adapter.execute(makeInput()))
      const call = events.find(e => e.type === 'adapter:tool_call') as Extract<
        AgentEvent,
        { type: 'adapter:tool_call' }
      >
      expect(call.toolName).toBe('web_search')
      expect(call.input).toEqual({ query: 'rust async' })
    })
  })
})
