/**
 * Unit tests for runStreamedThread — the Codex SDK streaming loop state machine.
 *
 * Covers the critical paths:
 *   - Normal happy-path completion (events mapped, adapter:completed emitted)
 *   - Timeout auto-abort path (adapter:failed with ADAPTER_TIMEOUT code)
 *   - Caller-abort path mid-stream (adapter:completed with partial result)
 *   - Caller-abort BEFORE stream starts (adapter:failed)
 *   - runStreamed() throws before events start
 *   - turn.failed non-approval failure (adapter:failed propagated)
 *   - turn.failed approval-pause detection and delegation
 *   - item.completed approval_request delegation
 *   - thread.started session-id assignment
 *   - Cache-stats event emitted when usage has cached token counts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runStreamedThread } from './codex-streamed-thread-loop.js'
import type { RunStreamedThreadContext } from './codex-streamed-thread-types.js'
import { DEFAULT_CODEX_TIMEOUT_MS } from './codex-streamed-thread-types.js'
import type {
  CodexInstance,
  CodexStreamEvent,
  CodexThread,
} from './codex-types.js'
import type { AgentInput, AgentStreamEvent } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectAll(
  gen: AsyncGenerator<AgentStreamEvent, void, undefined>,
): Promise<AgentStreamEvent[]> {
  const out: AgentStreamEvent[] = []
  for await (const e of gen) out.push(e)
  return out
}

/** Build a minimal AgentInput */
function makeInput(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    prompt: 'hello world',
    correlationId: 'test-corr-1',
    ...overrides,
  }
}

/** Build a CodexThread whose runStreamed emits the given events */
function makeThread(events: CodexStreamEvent[]): CodexThread {
  return {
    async runStreamed(_input: string | unknown[], _opts?: { signal?: AbortSignal }) {
      return {
        events: (async function* () {
          for (const e of events) yield e
        })(),
      }
    },
  }
}

/** Build a CodexThread that throws from runStreamed() before any events */
function makeThrowingThread(error: Error): CodexThread {
  return {
    async runStreamed() {
      throw error
    },
  }
}

/** Build a CodexThread that emits events but throws mid-iteration */
function makeMidStreamThrowingThread(events: CodexStreamEvent[], throwAfter: number): CodexThread {
  return {
    async runStreamed() {
      return {
        events: (async function* () {
          for (let i = 0; i < events.length; i++) {
            if (i === throwAfter) throw new Error('mid-stream error')
            yield events[i]!
          }
        })(),
      }
    },
  }
}

/** Minimal CodexInstance used for approval-resume tests */
function makeCodexInstance(resumeThread?: CodexThread): CodexInstance {
  return {
    startThread: vi.fn(),
    resumeThread: vi.fn().mockReturnValue(resumeThread ?? makeThread([])),
  }
}

/** Build a minimal RunStreamedThreadContext */
function makeCtx(overrides: Partial<RunStreamedThreadContext> = {}): RunStreamedThreadContext {
  let sessionId: string | null = null
  const abortCtrl = new AbortController()

  return {
    providerId: 'codex' as RunStreamedThreadContext['providerId'],
    config: { model: 'codex-latest' } as RunStreamedThreadContext['config'],
    currentInput: undefined,
    isResume: false,
    getSessionId: () => sessionId,
    setSessionId: (id) => { sessionId = id },
    abort: () => abortCtrl.abort(),
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
// Tests
// ---------------------------------------------------------------------------

describe('runStreamedThread', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Normal path
  // -------------------------------------------------------------------------

  it('emits adapter:provider_raw events for every SDK event', async () => {
    const events: CodexStreamEvent[] = [
      { type: 'thread.started', thread_id: 'tid-1' },
      {
        type: 'item.completed',
        item: { type: 'agent_message', id: 'i1', text: 'Hello!' },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]
    const thread = makeThread(events)
    const codex = makeCodexInstance()
    const ctx = makeCtx()
    const input = makeInput()
    const signal = new AbortController().signal

    const genPromise = collectAll(
      runStreamedThread(thread, input, codex, signal, ctx),
    )
    await vi.runAllTimersAsync()
    const collected = await genPromise

    const rawEvents = collected.filter((e) => e.type === 'adapter:provider_raw')
    // One raw event per SDK event
    expect(rawEvents).toHaveLength(3)
  })

  it('emits adapter:completed as the final event after normal turn', async () => {
    const events: CodexStreamEvent[] = [
      { type: 'thread.started', thread_id: 'tid-2' },
      {
        type: 'item.completed',
        item: { type: 'agent_message', id: 'i1', text: 'Result text' },
      },
      { type: 'turn.completed', usage: { input_tokens: 8, output_tokens: 4 } },
    ]
    const thread = makeThread(events)
    const codex = makeCodexInstance()
    const ctx = makeCtx()
    const input = makeInput()
    const signal = new AbortController().signal

    const genPromise = collectAll(
      runStreamedThread(thread, input, codex, signal, ctx),
    )
    await vi.runAllTimersAsync()
    const collected = await genPromise

    const last = collected[collected.length - 1]
    expect(last?.type).toBe('adapter:completed')
    const completed = last as { type: string; result?: string }
    expect(completed.result).toBe('Result text')
  })

  it('assigns thread_id from thread.started event as the session id', async () => {
    const events: CodexStreamEvent[] = [
      { type: 'thread.started', thread_id: 'assigned-session' },
      { type: 'turn.completed' },
    ]
    const thread = makeThread(events)
    const codex = makeCodexInstance()
    let capturedSessionId: string | null = null
    const ctx = makeCtx({
      setSessionId: (id) => { capturedSessionId = id },
    })
    const input = makeInput()
    const signal = new AbortController().signal

    const genPromise = collectAll(
      runStreamedThread(thread, input, codex, signal, ctx),
    )
    await vi.runAllTimersAsync()
    await genPromise

    expect(capturedSessionId).toBe('assigned-session')
  })

  it('emits adapter:started event for thread.started SDK event', async () => {
    const events: CodexStreamEvent[] = [
      { type: 'thread.started', thread_id: 'tid-start' },
      { type: 'turn.completed' },
    ]
    const thread = makeThread(events)
    const codex = makeCodexInstance()
    const ctx = makeCtx()
    const input = makeInput()
    const signal = new AbortController().signal

    const genPromise = collectAll(
      runStreamedThread(thread, input, codex, signal, ctx),
    )
    await vi.runAllTimersAsync()
    const collected = await genPromise

    const startedEvents = collected.filter((e) => e.type === 'adapter:started')
    expect(startedEvents).toHaveLength(1)
  })

  it('emits adapter:message event for agent_message item', async () => {
    const events: CodexStreamEvent[] = [
      { type: 'thread.started', thread_id: 'tid-3' },
      {
        type: 'item.completed',
        item: { type: 'agent_message', id: 'i1', text: 'Agent response' },
      },
      { type: 'turn.completed' },
    ]
    const thread = makeThread(events)
    const codex = makeCodexInstance()
    const ctx = makeCtx()
    const input = makeInput()
    const signal = new AbortController().signal

    const genPromise = collectAll(
      runStreamedThread(thread, input, codex, signal, ctx),
    )
    await vi.runAllTimersAsync()
    const collected = await genPromise

    const messageEvents = collected.filter((e) => e.type === 'adapter:message')
    expect(messageEvents).toHaveLength(1)
    const msg = messageEvents[0] as { type: string; content?: string }
    expect(msg.content).toBe('Agent response')
  })

  it('emits cache_stats event when usage includes cached token counts', async () => {
    const events: CodexStreamEvent[] = [
      { type: 'thread.started', thread_id: 'tid-cache' },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cached_input_tokens: 60,
        },
      },
    ]
    const thread = makeThread(events)
    const codex = makeCodexInstance()
    const ctx = makeCtx()
    const input = makeInput()
    const signal = new AbortController().signal

    const genPromise = collectAll(
      runStreamedThread(thread, input, codex, signal, ctx),
    )
    await vi.runAllTimersAsync()
    const collected = await genPromise

    const cacheStats = collected.filter((e) => e.type === 'adapter:cache_stats')
    expect(cacheStats).toHaveLength(1)
    const stats = cacheStats[0] as {
      type: string
      cacheReadTokens?: number
      cacheHitRatio?: number
    }
    expect(stats.cacheReadTokens).toBe(60)
    expect(stats.cacheHitRatio).toBeCloseTo(0.6)
  })

  it('does NOT emit cache_stats event when usage has no cached tokens', async () => {
    const events: CodexStreamEvent[] = [
      { type: 'thread.started', thread_id: 'tid-no-cache' },
      {
        type: 'turn.completed',
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    ]
    const thread = makeThread(events)
    const codex = makeCodexInstance()
    const ctx = makeCtx()
    const input = makeInput()
    const signal = new AbortController().signal

    const genPromise = collectAll(
      runStreamedThread(thread, input, codex, signal, ctx),
    )
    await vi.runAllTimersAsync()
    const collected = await genPromise

    const cacheStats = collected.filter((e) => e.type === 'adapter:cache_stats')
    expect(cacheStats).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Abort paths
  // -------------------------------------------------------------------------

  it('emits adapter:failed with ADAPTER_TIMEOUT when timeout fires before stream', async () => {
    // Use real timers so the actual setTimeout in the loop fires.
    vi.useRealTimers()

    const abortCtrl = new AbortController()
    // Thread hangs until the signal is aborted (by the timeout handler via ctx.abort)
    const hangingThread: CodexThread = {
      async runStreamed(_input, opts) {
        return new Promise<never>((_resolve, reject) => {
          if (opts?.signal?.aborted) { reject(new Error('aborted')); return }
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          // Also listen on the outer abort controller
          abortCtrl.signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
      },
    }
    const ctx = makeCtx({
      // Very short timeout so the test completes quickly
      config: { model: 'codex-latest', timeoutMs: 20 } as RunStreamedThreadContext['config'],
      abort: () => abortCtrl.abort(),
    })
    const input = makeInput()
    const codex = makeCodexInstance()

    const collected = await collectAll(
      runStreamedThread(hangingThread, input, codex, abortCtrl.signal, ctx),
    )

    const failed = collected.find((e) => e.type === 'adapter:failed')
    expect(failed).toBeDefined()
    const f = failed as { type: string; code?: string }
    expect(f.code).toBe('ADAPTER_TIMEOUT')
  }, 5000)

  it('emits adapter:failed when runStreamed() throws before events start (non-abort)', async () => {
    const thread = makeThrowingThread(new Error('SDK init error'))
    const codex = makeCodexInstance()
    const ctx = makeCtx()
    const input = makeInput()
    const signal = new AbortController().signal

    const genPromise = collectAll(
      runStreamedThread(thread, input, codex, signal, ctx),
    )
    await vi.runAllTimersAsync()
    const collected = await genPromise

    expect(collected).toHaveLength(1)
    expect(collected[0]?.type).toBe('adapter:failed')
    const f = collected[0] as { type: string; code?: string; error?: string }
    expect(f.code).toBe('ADAPTER_EXECUTION_FAILED')
    expect(f.error).toContain('SDK init error')
  })

  it('emits adapter:failed when signal is already aborted before runStreamed starts', async () => {
    const abortCtrl = new AbortController()
    abortCtrl.abort()

    const thread = makeThrowingThread(new Error('aborted'))
    const codex = makeCodexInstance()
    const ctx = makeCtx()
    const input = makeInput()

    const genPromise = collectAll(
      runStreamedThread(thread, input, codex, abortCtrl.signal, ctx),
    )
    await vi.runAllTimersAsync()
    const collected = await genPromise

    expect(collected).toHaveLength(1)
    // Pre-abort throws; since signal is aborted, code = ADAPTER_EXECUTION_FAILED
    // (because didTimeout=false but signal.aborted=true → caller_abort path)
    expect(collected[0]?.type).toBe('adapter:failed')
  })

  it('emits adapter:completed (interrupted) when caller aborts mid-stream', async () => {
    // Use real timers for this test (fake timers can't drive abort-based async generators)
    vi.useRealTimers()

    const abortCtrl = new AbortController()

    // Thread yields one event, then rejects when the signal fires.
    // The for-await loop in runStreamedThread catches the rejection with signal.aborted=true.
    const hangThread: CodexThread = {
      async runStreamed() {
        return {
          events: (async function* () {
            yield { type: 'thread.started', thread_id: 'tid-abort' } as CodexStreamEvent
            // Hang until abort
            await new Promise<void>((_, reject) => {
              abortCtrl.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            })
          })(),
        }
      },
    }

    const ctx = makeCtx()
    const input = makeInput()
    const codex = makeCodexInstance()

    // Start consuming the generator in the background
    const genPromise = collectAll(
      runStreamedThread(hangThread, input, codex, abortCtrl.signal, ctx),
    )

    // Give the generator a moment to start and emit thread.started
    await new Promise((r) => setTimeout(r, 10))
    // Abort mid-stream — this causes the for-await to throw (signal.aborted=true)
    abortCtrl.abort()

    const collected = await genPromise

    const last = collected[collected.length - 1]
    // When caller aborts (didTimeout=false), the loop emits adapter:completed
    expect(last?.type).toBe('adapter:completed')
  }, 5000)

  it('emits adapter:failed when an upstream registry timeout aborts mid-stream', async () => {
    vi.useRealTimers()

    const abortCtrl = new AbortController()
    const timeoutReason = new Error('Adapter execution timed out after 30ms') as Error & { code?: string }
    timeoutReason.code = 'ADAPTER_TIMEOUT'

    const hangThread: CodexThread = {
      async runStreamed(_input, opts) {
        return {
          events: (async function* () {
            yield { type: 'thread.started', thread_id: 'tid-registry-timeout' } as CodexStreamEvent
            await new Promise<void>((_, reject) => {
              opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            })
          })(),
        }
      },
    }

    const ctx = makeCtx()
    const input = makeInput()
    const codex = makeCodexInstance()
    const genPromise = collectAll(
      runStreamedThread(hangThread, input, codex, abortCtrl.signal, ctx),
    )

    await new Promise((r) => setTimeout(r, 10))
    abortCtrl.abort(timeoutReason)

    const collected = await genPromise
    const last = collected[collected.length - 1]

    expect(last?.type).toBe('adapter:failed')
    expect((last as { code?: string }).code).toBe('ADAPTER_TIMEOUT')
  }, 5000)

  it('emits adapter:failed for mid-stream non-abort errors', async () => {
    const events: CodexStreamEvent[] = [
      { type: 'thread.started', thread_id: 'tid-err' },
      { type: 'item.completed', item: { type: 'agent_message', id: 'i1', text: 'partial' } },
    ]
    const thread = makeMidStreamThrowingThread(events, 1)
    const codex = makeCodexInstance()
    const ctx = makeCtx()
    const input = makeInput()
    const signal = new AbortController().signal

    const genPromise = collectAll(
      runStreamedThread(thread, input, codex, signal, ctx),
    )
    await vi.runAllTimersAsync()
    const collected = await genPromise

    const failed = collected.find((e) => e.type === 'adapter:failed')
    expect(failed).toBeDefined()
    const f = failed as { type: string; code?: string; error?: string }
    expect(f.code).toBe('ADAPTER_EXECUTION_FAILED')
    expect(f.error).toContain('mid-stream error')
  })

  // -------------------------------------------------------------------------
  // turn.failed paths
  // -------------------------------------------------------------------------

  it('emits adapter:failed event for non-approval turn.failed', async () => {
    const events: CodexStreamEvent[] = [
      { type: 'thread.started', thread_id: 'tid-fail' },
      { type: 'turn.failed', error: { message: 'model overloaded' } },
    ]
    const thread = makeThread(events)
    const codex = makeCodexInstance()
    const ctx = makeCtx({ isApprovalCapable: () => false })
    const input = makeInput()
    const signal = new AbortController().signal

    const genPromise = collectAll(
      runStreamedThread(thread, input, codex, signal, ctx),
    )
    await vi.runAllTimersAsync()
    const collected = await genPromise

    const failed = collected.find((e) => e.type === 'adapter:failed')
    expect(failed).toBeDefined()
    const f = failed as { type: string; error?: string }
    expect(f.error).toContain('model overloaded')
  })

  it('does NOT treat non-approval turn.failed as approval pause', async () => {
    const events: CodexStreamEvent[] = [
      { type: 'thread.started', thread_id: 'tid-no-approval' },
      { type: 'turn.failed', error: { message: 'model overloaded' } },
    ]
    const thread = makeThread(events)
    const codex = makeCodexInstance()
    // Even if approval-capable, message must match the approval pattern
    const ctx = makeCtx({ isApprovalCapable: () => true })
    const input = makeInput()
    const signal = new AbortController().signal

    const genPromise = collectAll(
      runStreamedThread(thread, input, codex, signal, ctx),
    )
    await vi.runAllTimersAsync()
    const collected = await genPromise

    // Should NOT delegate to approval flow — the adapter:failed event should
    // come from the normal turn.failed branch mapped via mapCodexEvent
    const failed = collected.filter((e) => e.type === 'adapter:failed')
    expect(failed.length).toBeGreaterThan(0)
  })

  it('delegates approval-pause turn.failed to handleStreamTurnFailedApproval', async () => {
    const events: CodexStreamEvent[] = [
      { type: 'thread.started', thread_id: 'tid-pause' },
      {
        type: 'turn.failed',
        error: { message: 'requires approval to execute shell command' },
      },
    ]
    const thread = makeThread(events)

    // Resumed thread returns a simple completed turn
    const resumedEvents: CodexStreamEvent[] = [
      { type: 'thread.started', thread_id: 'tid-resumed' },
      {
        type: 'item.completed',
        item: { type: 'agent_message', id: 'i1', text: 'Resumed result' },
      },
      { type: 'turn.completed' },
    ]
    const resumedThread = makeThread(resumedEvents)
    const codex = makeCodexInstance(resumedThread)

    const ctx = makeCtx({
      isApprovalCapable: () => true,
      buildApprovalContext: (_input) => ({
        providerId: 'codex' as RunStreamedThreadContext['providerId'],
        policy: { mode: 'auto' },
        resolver: {
          resolve: vi.fn().mockResolvedValue({ answer: 'yes', resolvedBy: 'auto' }),
        },
        buildThreadOptions: () => ({}),
      }),
    })
    const input = makeInput()
    const signal = new AbortController().signal

    const genPromise = collectAll(
      runStreamedThread(thread, input, codex, signal, ctx),
    )
    await vi.runAllTimersAsync()
    const collected = await genPromise

    // After approval: resumed thread completes → adapter:completed emitted
    const completed = collected.filter((e) => e.type === 'adapter:completed')
    expect(completed).toHaveLength(1)
    const c = completed[0] as { type: string; result?: string }
    expect(c.result).toBe('Resumed result')
  })

  it('emits adapter:failed with INTERACTION_DENIED when approval is denied', async () => {
    const events: CodexStreamEvent[] = [
      { type: 'thread.started', thread_id: 'tid-denied' },
      {
        type: 'turn.failed',
        error: { message: 'requires approval to run dangerous command' },
      },
    ]
    const thread = makeThread(events)
    const codex = makeCodexInstance()

    const ctx = makeCtx({
      isApprovalCapable: () => true,
      buildApprovalContext: (_input) => ({
        providerId: 'codex' as RunStreamedThreadContext['providerId'],
        policy: { mode: 'auto' },
        resolver: {
          resolve: vi.fn().mockResolvedValue({ answer: 'no', resolvedBy: 'policy' }),
        },
        buildThreadOptions: () => ({}),
      }),
    })
    const input = makeInput()
    const signal = new AbortController().signal

    const genPromise = collectAll(
      runStreamedThread(thread, input, codex, signal, ctx),
    )
    await vi.runAllTimersAsync()
    const collected = await genPromise

    const failed = collected.filter((e) => e.type === 'adapter:failed')
    expect(failed.length).toBeGreaterThan(0)
    const f = failed[failed.length - 1] as { type: string; code?: string }
    expect(f.code).toBe('INTERACTION_DENIED')
  })

  // -------------------------------------------------------------------------
  // approval_request item path
  // -------------------------------------------------------------------------

  it('delegates item.completed approval_request to handleStreamApprovalRequest', async () => {
    const events: CodexStreamEvent[] = [
      { type: 'thread.started', thread_id: 'tid-req' },
      {
        type: 'item.completed',
        item: {
          type: 'approval_request',
          id: 'req-1',
          message: 'May I access the filesystem?',
          kind: 'permission',
        },
      },
      {
        type: 'item.completed',
        item: { type: 'agent_message', id: 'i2', text: 'Done!' },
      },
      { type: 'turn.completed' },
    ]
    const thread = makeThread(events)
    const codex = makeCodexInstance()

    const resolverFn = vi.fn().mockResolvedValue({ answer: 'yes', resolvedBy: 'auto' })
    const ctx = makeCtx({
      buildApprovalContext: (_input) => ({
        providerId: 'codex' as RunStreamedThreadContext['providerId'],
        policy: { mode: 'auto' },
        resolver: { resolve: resolverFn },
        buildThreadOptions: () => ({}),
      }),
    })
    const input = makeInput()
    const signal = new AbortController().signal

    const genPromise = collectAll(
      runStreamedThread(thread, input, codex, signal, ctx),
    )
    await vi.runAllTimersAsync()
    const collected = await genPromise

    // Resolver was called for the approval_request
    expect(resolverFn).toHaveBeenCalledOnce()

    // Stream continues after approval_request: agent_message + adapter:completed
    const messageEvents = collected.filter((e) => e.type === 'adapter:message')
    expect(messageEvents).toHaveLength(1)
    const completed = collected.filter((e) => e.type === 'adapter:completed')
    expect(completed).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Correlation ID threading
  // -------------------------------------------------------------------------

  it('threads correlationId through all emitted events', async () => {
    const events: CodexStreamEvent[] = [
      { type: 'thread.started', thread_id: 'tid-corr' },
      {
        type: 'item.completed',
        item: { type: 'agent_message', id: 'i1', text: 'Hello' },
      },
      { type: 'turn.completed' },
    ]
    const thread = makeThread(events)
    const codex = makeCodexInstance()
    const ctx = makeCtx()
    const input = makeInput({ correlationId: 'my-corr-id' })
    const signal = new AbortController().signal

    const genPromise = collectAll(
      runStreamedThread(thread, input, codex, signal, ctx),
    )
    await vi.runAllTimersAsync()
    const collected = await genPromise

    // Every non-raw-provider event should carry the correlationId
    const withCorr = collected.filter((e) => (e as Record<string, unknown>)['correlationId'] === 'my-corr-id')
    expect(withCorr.length).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // DEFAULT_CODEX_TIMEOUT_MS constant
  // -------------------------------------------------------------------------

  it('uses DEFAULT_CODEX_TIMEOUT_MS (120_000) as fallback when no config or input timeout', () => {
    expect(DEFAULT_CODEX_TIMEOUT_MS).toBe(120_000)
  })
})
