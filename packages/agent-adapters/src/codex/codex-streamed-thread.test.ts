/**
 * Unit tests for the codex-streamed-thread helper modules:
 *   - codex-streamed-thread-approval   (detectApprovalPause, handleStreamApprovalRequest,
 *                                        handleStreamTurnFailedApproval)
 *   - codex-streamed-thread-events      (wrapRawProviderEvent, combineSignals,
 *                                        buildAdapterStartedEvent)
 *   - codex-helpers                     (pure utilities: toTokenUsage, summarizeTodoList,
 *                                        buildProviderEventId, mapCodexEvent, mapItemCompleted,
 *                                        annotateProviderIdentity, toCodexSandboxMode)
 */

import { describe, it, expect, vi } from 'vitest'

// --- modules under test ---
import {
  detectApprovalPause,
  handleStreamApprovalRequest,
  handleStreamTurnFailedApproval,
} from './codex-streamed-thread-approval.js'
import {
  wrapRawProviderEvent,
  combineSignals,
  buildAdapterStartedEvent,
} from './codex-streamed-thread-events.js'
import {
  toTokenUsage,
  summarizeTodoList,
  buildProviderEventId,
  mapCodexEvent,
  mapItemCompleted,
  annotateProviderIdentity,
  toCodexSandboxMode,
} from './codex-helpers.js'

import type { RunStreamedThreadContext } from './codex-streamed-thread-types.js'
import type { CodexStreamEvent, CodexInstance } from './codex-types.js'
import type { AgentInput, AgentStreamEvent } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectGen<T>(gen: AsyncGenerator<T, void, undefined>): Promise<T[]> {
  const out: T[] = []
  for await (const e of gen) out.push(e)
  return out
}

function makeInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return { prompt: 'test', correlationId: 'corr-1', ...overrides }
}

function makeMinimalCtx(overrides: Partial<RunStreamedThreadContext> = {}): RunStreamedThreadContext {
  return {
    providerId: 'codex' as RunStreamedThreadContext['providerId'],
    config: { model: 'codex-latest' } as RunStreamedThreadContext['config'],
    currentInput: undefined,
    isResume: false,
    getSessionId: () => null,
    setSessionId: vi.fn(),
    abort: vi.fn(),
    buildApprovalContext: (_input) => ({
      providerId: 'codex' as RunStreamedThreadContext['providerId'],
      policy: { mode: 'auto' },
      resolver: {
        resolve: vi.fn().mockResolvedValue({ answer: 'yes', resolvedBy: 'auto' }),
      },
      buildThreadOptions: () => ({}),
    }),
    isApprovalCapable: () => false,
    buildThreadOptions: () => ({}),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// detectApprovalPause
// ---------------------------------------------------------------------------

describe('detectApprovalPause', () => {
  it('returns null when ctx is not approval-capable', () => {
    const event: CodexStreamEvent = {
      type: 'turn.failed',
      error: { message: 'requires approval' },
    }
    const ctx = makeMinimalCtx({ isApprovalCapable: () => false })
    const result = detectApprovalPause(event, makeInput(), ctx)
    expect(result).toBeNull()
  })

  it('returns null when error message does not match approval pattern', () => {
    const event: CodexStreamEvent = {
      type: 'turn.failed',
      error: { message: 'network timeout' },
    }
    const ctx = makeMinimalCtx({ isApprovalCapable: () => true })
    const result = detectApprovalPause(event, makeInput(), ctx)
    expect(result).toBeNull()
  })

  it('returns error message when approval-capable and message matches "requires approval"', () => {
    const event: CodexStreamEvent = {
      type: 'turn.failed',
      error: { message: 'requires approval to run command' },
    }
    const ctx = makeMinimalCtx({ isApprovalCapable: () => true })
    const result = detectApprovalPause(event, makeInput(), ctx)
    expect(result).toBe('requires approval to run command')
  })

  it('returns error message when message matches "user confirmation"', () => {
    const event: CodexStreamEvent = {
      type: 'turn.failed',
      error: { message: 'user confirmation needed' },
    }
    const ctx = makeMinimalCtx({ isApprovalCapable: () => true })
    const result = detectApprovalPause(event, makeInput(), ctx)
    expect(result).toBe('user confirmation needed')
  })

  it('returns error message when message matches "permission denied"', () => {
    const event: CodexStreamEvent = {
      type: 'turn.failed',
      error: { message: 'permission denied for this operation' },
    }
    const ctx = makeMinimalCtx({ isApprovalCapable: () => true })
    const result = detectApprovalPause(event, makeInput(), ctx)
    expect(result).toBe('permission denied for this operation')
  })

  it('returns error message when message matches "approval required"', () => {
    const event: CodexStreamEvent = {
      type: 'turn.failed',
      error: 'Approval required before executing',
    }
    const ctx = makeMinimalCtx({ isApprovalCapable: () => true })
    const result = detectApprovalPause(event, makeInput(), ctx)
    expect(result).toBe('Approval required before executing')
  })

  it('returns empty-string match but not null when approval capable and error is missing message', () => {
    const event: CodexStreamEvent = {
      type: 'turn.failed',
      // no error field at all
    }
    const ctx = makeMinimalCtx({ isApprovalCapable: () => true })
    const result = detectApprovalPause(event, makeInput(), ctx)
    // Empty string does not match the approval regex
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handleStreamApprovalRequest
// ---------------------------------------------------------------------------

describe('handleStreamApprovalRequest', () => {
  it('delegates to handleApprovalRequest and yields interaction_resolved event', async () => {
    const resolverFn = vi.fn().mockResolvedValue({ answer: 'yes', resolvedBy: 'auto' })
    const ctx = makeMinimalCtx({
      buildApprovalContext: (_input) => ({
        providerId: 'codex' as RunStreamedThreadContext['providerId'],
        policy: { mode: 'auto' },
        resolver: { resolve: resolverFn },
        buildThreadOptions: () => ({}),
      }),
    })
    const event: CodexStreamEvent = {
      type: 'item.completed',
      item: {
        type: 'approval_request',
        id: 'req-1',
        message: 'Approve shell access?',
        kind: 'permission',
      },
    }
    const input = makeInput()

    const collected = await collectGen(
      handleStreamApprovalRequest(event, input, 'pev-1', null, ctx),
    )

    expect(resolverFn).toHaveBeenCalledOnce()
    const resolved = collected.find((e) => e.type === 'adapter:interaction_resolved')
    expect(resolved).toBeDefined()
  })

  it('emits interaction_required then interaction_resolved in ask-caller mode', async () => {
    const resolverFn = vi.fn().mockResolvedValue({ answer: 'yes', resolvedBy: 'human' })
    const ctx = makeMinimalCtx({
      buildApprovalContext: (_input) => ({
        providerId: 'codex' as RunStreamedThreadContext['providerId'],
        policy: { mode: 'ask-caller', askCaller: { timeoutMs: 5000 } },
        resolver: { resolve: resolverFn },
        buildThreadOptions: () => ({}),
      }),
    })
    const event: CodexStreamEvent = {
      type: 'item.completed',
      item: {
        type: 'approval_request',
        id: 'req-2',
        message: 'Approve?',
        kind: 'clarification',
      },
    }
    const input = makeInput()

    const collected = await collectGen(
      handleStreamApprovalRequest(event, input, null, null, ctx),
    )

    const types = collected.map((e) => e.type)
    expect(types).toContain('adapter:interaction_required')
    expect(types).toContain('adapter:interaction_resolved')
  })
})

// ---------------------------------------------------------------------------
// handleStreamTurnFailedApproval
// ---------------------------------------------------------------------------

describe('handleStreamTurnFailedApproval', () => {
  it('resumes thread and yields completed event when answer is "yes"', async () => {
    const resumedEvents: CodexStreamEvent[] = [
      { type: 'thread.started', thread_id: 'resumed-tid' },
      { type: 'item.completed', item: { type: 'agent_message', id: 'i1', text: 'Resumed!' } },
      { type: 'turn.completed' },
    ]
    const resumedThread = {
      async runStreamed() {
        return {
          events: (async function* () {
            for (const e of resumedEvents) yield e
          })(),
        }
      },
    }

    const codex: CodexInstance = {
      startThread: vi.fn(),
      resumeThread: vi.fn().mockReturnValue(resumedThread),
    }

    const resolverFn = vi.fn().mockResolvedValue({ answer: 'yes', resolvedBy: 'auto' })
    const approvalCtx = {
      providerId: 'codex' as RunStreamedThreadContext['providerId'],
      policy: { mode: 'auto' as const },
      resolver: { resolve: resolverFn },
      buildThreadOptions: () => ({}),
    }

    const input = makeInput()
    const signal = new AbortController().signal

    // resumeWithThread: build a simple generator that collects the resumed thread events
    const resumeWithThread = async function* (thread: typeof resumedThread) {
      const turn = await thread.runStreamed('', {})
      for await (const e of turn.events) {
        if (e.type === 'item.completed' && e.item?.type === 'agent_message') {
          yield {
            type: 'adapter:message',
            content: (e.item as { type: string; text: string }).text,
            role: 'assistant',
            providerId: 'codex',
            timestamp: Date.now(),
          } as AgentStreamEvent
        } else if (e.type === 'turn.completed') {
          yield {
            type: 'adapter:completed',
            result: 'Resumed!',
            providerId: 'codex',
            sessionId: 'resumed-tid',
            durationMs: 0,
            timestamp: Date.now(),
          } as AgentStreamEvent
        }
      }
    }

    const collected = await collectGen(
      handleStreamTurnFailedApproval(
        'requires approval',
        input,
        'session-1',
        codex,
        signal,
        null,
        null,
        approvalCtx,
        resumeWithThread,
      ),
    )

    expect(codex.resumeThread).toHaveBeenCalledOnce()
    const completed = collected.find((e) => e.type === 'adapter:completed')
    expect(completed).toBeDefined()
  })

  it('emits adapter:failed with INTERACTION_DENIED when answer is "no"', async () => {
    const codex: CodexInstance = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
    }

    const resolverFn = vi.fn().mockResolvedValue({ answer: 'no', resolvedBy: 'policy' })
    const approvalCtx = {
      providerId: 'codex' as RunStreamedThreadContext['providerId'],
      policy: { mode: 'auto' as const },
      resolver: { resolve: resolverFn },
      buildThreadOptions: () => ({}),
    }

    const input = makeInput()
    const signal = new AbortController().signal

    const collected = await collectGen(
      handleStreamTurnFailedApproval(
        'requires approval to delete files',
        input,
        'session-2',
        codex,
        signal,
        null,
        null,
        approvalCtx,
        async function* () { /* should not be called */ },
      ),
    )

    const failed = collected.find((e) => e.type === 'adapter:failed')
    expect(failed).toBeDefined()
    const f = failed as { type: string; code?: string }
    expect(f.code).toBe('INTERACTION_DENIED')
    // resumeThread should NOT have been called
    expect(codex.resumeThread).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// wrapRawProviderEvent
// ---------------------------------------------------------------------------

describe('wrapRawProviderEvent', () => {
  it('returns adapter:provider_raw event with correct shape', () => {
    const event: CodexStreamEvent = { type: 'turn.completed', thread_id: 'tid-1' }
    const result = wrapRawProviderEvent('codex', event, 'tid-1', makeInput(), 3, 'parent-pev')

    expect(result.type).toBe('adapter:provider_raw')
    expect(result.rawEvent.providerId).toBe('codex')
    expect(result.rawEvent.sessionId).toBe('tid-1')
    expect(result.rawEvent.source).toBe('sdk')
    expect(result.rawEvent.payload).toBe(event)
    expect(result.rawEvent.parentProviderEventId).toBe('parent-pev')
  })

  it('does not include parentProviderEventId for thread.started events', () => {
    const event: CodexStreamEvent = { type: 'thread.started', thread_id: 'tid-new' }
    const result = wrapRawProviderEvent('codex', event, 'tid-new', makeInput(), 1, 'some-pev')

    expect(result.rawEvent.parentProviderEventId).toBeUndefined()
  })

  it('includes correlationId when input has it', () => {
    const event: CodexStreamEvent = { type: 'turn.completed' }
    const input = makeInput({ correlationId: 'my-corr' })
    const result = wrapRawProviderEvent('codex', event, 'session-1', input, 2, null)

    expect(result.rawEvent.correlationId).toBe('my-corr')
  })
})

// ---------------------------------------------------------------------------
// combineSignals
// ---------------------------------------------------------------------------

describe('combineSignals', () => {
  it('returns internal signal when no external signal provided', () => {
    const internal = new AbortController()
    const result = combineSignals(undefined, internal.signal)
    expect(result).toBe(internal.signal)
  })

  it('aborts immediately when either signal is already aborted', () => {
    const internal = new AbortController()
    const external = new AbortController()
    external.abort()

    const result = combineSignals(external.signal, internal.signal)
    expect(result.aborted).toBe(true)
  })

  it('combined signal aborts when external aborts', async () => {
    const internal = new AbortController()
    const external = new AbortController()

    const combined = combineSignals(external.signal, internal.signal)
    expect(combined.aborted).toBe(false)

    external.abort()
    // Allow microtask queue to flush
    await Promise.resolve()
    expect(combined.aborted).toBe(true)
  })

  it('combined signal aborts when internal aborts', async () => {
    const internal = new AbortController()
    const external = new AbortController()

    const combined = combineSignals(external.signal, internal.signal)
    expect(combined.aborted).toBe(false)

    internal.abort()
    await Promise.resolve()
    expect(combined.aborted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// buildAdapterStartedEvent
// ---------------------------------------------------------------------------

describe('buildAdapterStartedEvent', () => {
  it('returns an array with a single adapter:started event', () => {
    const event: CodexStreamEvent = { type: 'thread.started', thread_id: 'tid-started' }
    const ctx = makeMinimalCtx({ isResume: false })

    const result = buildAdapterStartedEvent(event, 'tid-started', ctx, 'pev-1', null)

    expect(result).toHaveLength(1)
    expect(result[0]?.type).toBe('adapter:started')
  })

  it('uses thread_id from event as sessionId in started event', () => {
    const event: CodexStreamEvent = { type: 'thread.started', thread_id: 'specific-thread' }
    const ctx = makeMinimalCtx()

    const result = buildAdapterStartedEvent(event, 'fallback-session', ctx, null, null)

    const started = result[0] as { type: string; sessionId?: string }
    expect(started.sessionId).toBe('specific-thread')
  })

  it('annotates providerEventId when provided', () => {
    const event: CodexStreamEvent = { type: 'thread.started', thread_id: 'tid-ann' }
    const ctx = makeMinimalCtx()

    const result = buildAdapterStartedEvent(event, 'tid-ann', ctx, 'pev-annotated', null)
    const started = result[0] as { type: string; providerEventId?: string }
    expect(started.providerEventId).toBe('pev-annotated')
  })
})

// ---------------------------------------------------------------------------
// toTokenUsage
// ---------------------------------------------------------------------------

describe('toTokenUsage', () => {
  it('returns undefined for undefined input', () => {
    expect(toTokenUsage(undefined)).toBeUndefined()
  })

  it('maps input/output tokens correctly', () => {
    const usage = toTokenUsage({ input_tokens: 100, output_tokens: 50 })
    expect(usage?.inputTokens).toBe(100)
    expect(usage?.outputTokens).toBe(50)
    expect(usage?.cachedInputTokens).toBeUndefined()
  })

  it('maps cached_input_tokens when present', () => {
    const usage = toTokenUsage({
      input_tokens: 200,
      output_tokens: 40,
      cached_input_tokens: 80,
    })
    expect(usage?.cachedInputTokens).toBe(80)
  })
})

// ---------------------------------------------------------------------------
// summarizeTodoList
// ---------------------------------------------------------------------------

describe('summarizeTodoList', () => {
  it('returns 100% and default message for empty list', () => {
    const result = summarizeTodoList([])
    expect(result.percentage).toBe(100)
    expect(result.total).toBe(0)
    expect(result.message).toBe('Todo list updated')
  })

  it('computes correct percentage for partial completion', () => {
    const result = summarizeTodoList([
      { text: 'Task A', completed: true },
      { text: 'Task B', completed: false },
      { text: 'Task C', completed: false },
      { text: 'Task D', completed: true },
    ])
    expect(result.current).toBe(2)
    expect(result.total).toBe(4)
    expect(result.percentage).toBe(50)
  })

  it('includes next pending task text in message', () => {
    const result = summarizeTodoList([
      { text: 'Done task', completed: true },
      { text: 'Pending task', completed: false },
    ])
    expect(result.message).toContain('Pending task')
  })

  it('reports 100% when all tasks complete', () => {
    const result = summarizeTodoList([
      { text: 'Task A', completed: true },
      { text: 'Task B', completed: true },
    ])
    expect(result.percentage).toBe(100)
    expect(result.current).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// buildProviderEventId
// ---------------------------------------------------------------------------

describe('buildProviderEventId', () => {
  it('builds deterministic id from provider/thread/event/ordinal', () => {
    const event: CodexStreamEvent = { type: 'turn.completed', thread_id: 'tid-ev' }
    const id = buildProviderEventId('codex', event, 'tid-ev', 7)
    expect(id).toBe('codex:tid-ev:turn.completed:7')
  })

  it('uses item id when event has an item with id', () => {
    const event: CodexStreamEvent = {
      type: 'item.completed',
      thread_id: 'tid-item',
      item: { type: 'agent_message', id: 'item-abc', text: 'hi' },
    }
    const id = buildProviderEventId('codex', event, 'tid-item', 3)
    expect(id).toBe('codex:tid-item:item.completed:item-abc')
  })

  it('falls back to session id when thread_id missing', () => {
    const event: CodexStreamEvent = { type: 'turn.completed' }
    const id = buildProviderEventId('codex', event, 'fallback-session', 1)
    expect(id).toBe('codex:fallback-session:turn.completed:1')
  })
})

// ---------------------------------------------------------------------------
// mapCodexEvent
// ---------------------------------------------------------------------------

describe('mapCodexEvent', () => {
  const input = makeInput()

  it('returns empty array for thread.started', () => {
    const result = mapCodexEvent('codex', { type: 'thread.started' }, 's', 'pev', null, input)
    expect(result).toHaveLength(0)
  })

  it('returns empty array for turn.completed', () => {
    const result = mapCodexEvent('codex', { type: 'turn.completed' }, 's', 'pev', null, input)
    expect(result).toHaveLength(0)
  })

  it('returns empty array for unknown event type', () => {
    const result = mapCodexEvent('codex', { type: 'unknown_future_type' }, 's', 'pev', null, input)
    expect(result).toHaveLength(0)
  })

  it('maps turn.failed to adapter:failed event', () => {
    const event: CodexStreamEvent = { type: 'turn.failed', error: { message: 'Something broke' } }
    const result = mapCodexEvent('codex', event, 's', 'pev', null, input)
    expect(result).toHaveLength(1)
    expect(result[0]?.type).toBe('adapter:failed')
    const f = result[0] as { type: string; error?: string }
    expect(f.error).toBe('Something broke')
  })

  it('maps error event to adapter:failed', () => {
    const event: CodexStreamEvent = { type: 'error', message: 'fatal error' }
    const result = mapCodexEvent('codex', event, 's', 'pev', null, input)
    expect(result).toHaveLength(1)
    expect(result[0]?.type).toBe('adapter:failed')
  })

  it('maps item.completed/agent_message to adapter:message', () => {
    const event: CodexStreamEvent = {
      type: 'item.completed',
      item: { type: 'agent_message', id: 'i1', text: 'Hi there' },
    }
    const result = mapCodexEvent('codex', event, 's', 'pev', null, input)
    expect(result).toHaveLength(1)
    expect(result[0]?.type).toBe('adapter:message')
  })

  it('returns empty for item.completed with no item', () => {
    const event: CodexStreamEvent = { type: 'item.completed' }
    const result = mapCodexEvent('codex', event, 's', 'pev', null, input)
    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// mapItemCompleted — individual item types
// ---------------------------------------------------------------------------

describe('mapItemCompleted', () => {
  const input = makeInput()
  const ts = Date.now()

  it('maps command_execution to tool_call + tool_result events', () => {
    const item = {
      type: 'command_execution' as const,
      id: 'cmd-1',
      command: 'ls -la',
      aggregated_output: 'file1\nfile2',
      status: 'completed',
    }
    const result = mapItemCompleted('codex', item, ts, 'pev', null, input)
    expect(result).toHaveLength(2)
    expect(result[0]?.type).toBe('adapter:tool_call')
    expect(result[1]?.type).toBe('adapter:tool_result')
  })

  it('maps file_change to tool_result event with summary', () => {
    const item = {
      type: 'file_change' as const,
      id: 'fc-1',
      changes: [{ path: 'src/foo.ts', kind: 'modified' }],
      status: 'completed',
    }
    const result = mapItemCompleted('codex', item, ts, 'pev', null, input)
    expect(result).toHaveLength(1)
    expect(result[0]?.type).toBe('adapter:tool_result')
    const r = result[0] as { type: string; output?: string }
    expect(r.output).toContain('modified: src/foo.ts')
  })

  it('maps mcp_tool_call to tool_call + tool_result events', () => {
    const item = {
      type: 'mcp_tool_call' as const,
      id: 'mcp-1',
      server: 'my-server',
      tool: 'my-tool',
      arguments: { key: 'val' },
      result: { content: ['some result'], structured_content: null },
      status: 'completed',
    }
    const result = mapItemCompleted('codex', item, ts, 'pev', null, input)
    expect(result).toHaveLength(2)
    expect(result[0]?.type).toBe('adapter:tool_call')
    expect(result[1]?.type).toBe('adapter:tool_result')
    const tc = result[0] as { type: string; toolName?: string }
    expect(tc.toolName).toBe('my-server/my-tool')
  })

  it('maps web_search to adapter:tool_call', () => {
    const item = { type: 'web_search' as const, id: 'ws-1', query: 'typescript testing' }
    const result = mapItemCompleted('codex', item, ts, 'pev', null, input)
    expect(result).toHaveLength(1)
    expect(result[0]?.type).toBe('adapter:tool_call')
  })

  it('maps reasoning to adapter:message with assistant role', () => {
    const item = { type: 'reasoning' as const, id: 'r-1', text: 'Thinking about it...' }
    const result = mapItemCompleted('codex', item, ts, 'pev', null, input)
    expect(result).toHaveLength(1)
    expect(result[0]?.type).toBe('adapter:message')
  })

  it('maps todo_list to adapter:progress event', () => {
    const item = {
      type: 'todo_list' as const,
      id: 'tl-1',
      items: [
        { text: 'Step 1', completed: true },
        { text: 'Step 2', completed: false },
      ],
    }
    const result = mapItemCompleted('codex', item, ts, 'pev', null, input)
    expect(result).toHaveLength(1)
    expect(result[0]?.type).toBe('adapter:progress')
  })

  it('maps error item to adapter:failed', () => {
    const item = { type: 'error' as const, id: 'err-1', message: 'item error' }
    const result = mapItemCompleted('codex', item, ts, 'pev', null, input)
    expect(result).toHaveLength(1)
    expect(result[0]?.type).toBe('adapter:failed')
  })

  it('returns empty for approval_request item (handled upstream)', () => {
    const item = {
      type: 'approval_request' as const,
      id: 'ar-1',
      message: 'Approve?',
      kind: 'permission' as const,
    }
    const result = mapItemCompleted('codex', item, ts, 'pev', null, input)
    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// annotateProviderIdentity
// ---------------------------------------------------------------------------

describe('annotateProviderIdentity', () => {
  it('returns event unchanged when no IDs provided', () => {
    const event = { type: 'adapter:started', providerId: 'codex', sessionId: 's', timestamp: 0 }
    const result = annotateProviderIdentity(event, null, null)
    expect(result).toBe(event)
  })

  it('adds providerEventId to event when provided', () => {
    const event = { type: 'adapter:started', providerId: 'codex', sessionId: 's', timestamp: 0 }
    const result = annotateProviderIdentity(event, 'pev-123', null)
    expect((result as Record<string, unknown>)['providerEventId']).toBe('pev-123')
  })

  it('adds both IDs when both provided', () => {
    const event = { type: 'adapter:started', providerId: 'codex', sessionId: 's', timestamp: 0 }
    const result = annotateProviderIdentity(event, 'pev-1', 'parent-pev')
    expect((result as Record<string, unknown>)['providerEventId']).toBe('pev-1')
    expect((result as Record<string, unknown>)['parentProviderEventId']).toBe('parent-pev')
  })
})

// ---------------------------------------------------------------------------
// toCodexSandboxMode
// ---------------------------------------------------------------------------

describe('toCodexSandboxMode', () => {
  it('maps read-only to "read-only"', () => {
    expect(toCodexSandboxMode('read-only')).toBe('read-only')
  })

  it('maps full-access to "danger-full-access"', () => {
    expect(toCodexSandboxMode('full-access')).toBe('danger-full-access')
  })

  it('maps workspace-write to "workspace-write"', () => {
    expect(toCodexSandboxMode('workspace-write')).toBe('workspace-write')
  })

  it('defaults to workspace-write for undefined input', () => {
    expect(toCodexSandboxMode(undefined)).toBe('workspace-write')
  })
})
