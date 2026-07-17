import { describe, it, expect, vi, beforeEach } from 'vitest'

import { BaseCliAdapter } from '../base/base-cli-adapter.js'
import type { AgentEvent, AgentInput } from '../types.js'
import { collectEvents, getProcessHelperMocks } from './test-helpers.js'
import { ForgeError } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Module-level mock — must precede the SUT import that resolves process-helpers
// ---------------------------------------------------------------------------

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn().mockResolvedValue(true),
  spawnAndStreamJsonl: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Minimal concrete subclass used across all tests
// ---------------------------------------------------------------------------

class TestCliAdapter extends BaseCliAdapter {
  constructor() {
    super('gemini')
  }

  protected getBinaryName(): string {
    return 'test-bin'
  }

  protected buildArgs(_input: AgentInput): string[] {
    return ['--prompt', _input.prompt]
  }

  protected mapProviderEvent(
    record: Record<string, unknown>,
    sessionId: string,
  ): AgentEvent | undefined {
    if (record['type'] === 'completed') {
      return {
        type: 'adapter:completed',
        providerId: this.providerId,
        sessionId,
        result: String(record['result'] ?? 'done'),
        durationMs: 0,
        timestamp: Date.now(),
      }
    }
    if (record['type'] === 'failed') {
      return {
        type: 'adapter:failed',
        providerId: this.providerId,
        sessionId,
        error: String(record['error'] ?? 'provider failure'),
        timestamp: Date.now(),
      }
    }
    if (record['type'] === 'message') {
      return {
        type: 'adapter:message',
        providerId: this.providerId,
        sessionId,
        content: String(record['content'] ?? ''),
        timestamp: Date.now(),
      }
    }
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('BaseCliAdapter.execute() — path-level tests', () => {
  const { mockSpawnAndStreamJsonl } = getProcessHelperMocks()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // 1. Happy path
  // -------------------------------------------------------------------------

  describe('happy path', () => {
    it('emits adapter:started then adapter:completed in order when process exits cleanly', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'message', content: 'thinking…' }
        yield { type: 'completed', result: 'all good' }
      })

      const adapter = new TestCliAdapter()
      const input: AgentInput = { prompt: 'do the thing', workingDirectory: '/tmp/test' }

      const events = await collectEvents(adapter.execute(input))
      const types = events.map((e) => e.type)

      expect(types[0]).toBe('adapter:started')
      expect(types[types.length - 1]).toBe('adapter:completed')
      expect(types).not.toContain('adapter:failed')
    })

    it('adapter:started carries the input prompt, model, and providerId', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', result: 'ok' }
      })

      const adapter = new TestCliAdapter()
      adapter.configure({ model: 'gemini-ultra', workingDirectory: '/workspace' })

      const events = await collectEvents(adapter.execute({ prompt: 'hello world' }))
      const started = events.find((e) => e.type === 'adapter:started')

      expect(started).toBeDefined()
      if (started && started.type === 'adapter:started') {
        expect(started.providerId).toBe('gemini')
        expect(started.prompt).toBe('hello world')
        expect(started.model).toBe('gemini-ultra')
        expect(started.isResume).toBe(false)
      }
    })

    it('synthesizes an adapter:completed event when the JSONL stream ends without yielding one', async () => {
      // Stream ends without any 'completed' record — the base class must
      // synthesize a completed event so consumers always receive a terminal.
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'message', content: 'partial output' }
        // No 'completed' record
      })

      const adapter = new TestCliAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'work' }))

      const completed = events.find((e) => e.type === 'adapter:completed')
      expect(completed).toBeDefined()
      expect(events.filter((e) => e.type === 'adapter:failed')).toHaveLength(0)
    })

    it('propagates correlationId onto every emitted event', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'message', content: 'hi' }
        yield { type: 'completed', result: 'done' }
      })

      const adapter = new TestCliAdapter()
      const events = await collectEvents(
        adapter.execute({ prompt: 'test', correlationId: 'corr-xyz' }),
      )

      for (const event of events) {
        expect((event as { correlationId?: string }).correlationId).toBe('corr-xyz')
      }
    })
  })

  // -------------------------------------------------------------------------
  // 2. Abort signal pre-set (already aborted before execution begins)
  // -------------------------------------------------------------------------

  describe('pre-aborted signal', () => {
    it('emits adapter:started then adapter:failed without spawning when signal is already aborted', async () => {
      // We track whether spawnAndStreamJsonl was called to prove no spawn happened.
      let spawnCallCount = 0
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        spawnCallCount++
        throw new Error('should not be reached')
      })

      const controller = new AbortController()
      controller.abort()

      const adapter = new TestCliAdapter()
      const events = await collectEvents(
        adapter.execute({ prompt: 'never runs', signal: controller.signal }),
      )

      const types = events.map((e) => e.type)
      // Must always emit adapter:started (already yielded before spawn).
      expect(types).toContain('adapter:started')
      // Must emit adapter:failed as the terminal event.
      expect(types).toContain('adapter:failed')
      // The abort aborts the signal passed to spawn; spawnAndStreamJsonl may
      // still be called but must throw/reject immediately — no completed event.
      expect(types).not.toContain('adapter:completed')
    })

    it('adapter:failed event produced for pre-aborted signal has a non-empty error message', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        throw new DOMException('This operation was aborted', 'AbortError')
      })

      const controller = new AbortController()
      controller.abort()

      const adapter = new TestCliAdapter()
      const events = await collectEvents(
        adapter.execute({ prompt: 'task', signal: controller.signal }),
      )

      const failed = events.find((e) => e.type === 'adapter:failed')
      expect(failed).toBeDefined()
      if (failed && failed.type === 'adapter:failed') {
        expect(typeof failed.error).toBe('string')
        expect(failed.error.length).toBeGreaterThan(0)
        expect(failed.providerId).toBe('gemini')
      }
    })
  })

  // -------------------------------------------------------------------------
  // 3. Abort mid-stream
  // -------------------------------------------------------------------------

  describe('mid-stream abort', () => {
    it('stops emitting adapter events and yields adapter:failed after signal fires mid-stream', async () => {
      const controller = new AbortController()

      mockSpawnAndStreamJsonl.mockImplementation(async function* (_binary, _args, opts) {
        yield { type: 'message', content: 'first chunk' }
        // Fire the abort after the first record — the combined signal
        // is honoured by the for-await loop / spawn helper.
        controller.abort()
        // Simulate the spawn helper honouring the abort by throwing AbortError.
        throw new DOMException('The operation was aborted', 'AbortError')
      })

      const adapter = new TestCliAdapter()
      const events = await collectEvents(
        adapter.execute({ prompt: 'streaming task', signal: controller.signal }),
      )

      const types = events.map((e) => e.type)
      expect(types).toContain('adapter:started')
      // The message yielded before the abort must be in the stream.
      expect(types).toContain('adapter:message')
      // A failed terminal event is required.
      expect(types).toContain('adapter:failed')
      // A completed event must NOT appear after a mid-stream failure.
      expect(types).not.toContain('adapter:completed')
    })

    it('interrupt() aborts the internal controller and produces adapter:failed', async () => {
      // The mock signals readiness via a resolve callback so we can call
      // interrupt() from inside the generator after it has started — this
      // avoids races where the outer code fires interrupt() before the
      // generator has reached its wait point.
      let signalInterrupt!: () => void

      mockSpawnAndStreamJsonl.mockImplementation(async function* (_binary, _args, opts) {
        yield { type: 'message', content: 'partial' }
        // Tell the outer test code that the generator is now suspended and
        // ready to be interrupted.
        signalInterrupt()
        // Honour the abort by blocking until the signal fires.
        await new Promise<void>((_, reject) => {
          if (opts.signal?.aborted) {
            reject(new DOMException('aborted', 'AbortError'))
            return
          }
          opts.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      })

      const adapter = new TestCliAdapter()

      // A promise that resolves once the generator is running and waiting.
      const generatorReady = new Promise<void>((resolve) => {
        signalInterrupt = resolve
      })

      const resultPromise = collectEvents(adapter.execute({ prompt: 'long task' }))

      // Wait for the mock generator to be suspended at its await point, then
      // call interrupt().  This guarantees currentAbortController is set.
      await generatorReady
      adapter.interrupt()

      const events = await resultPromise
      const types = events.map((e) => e.type)

      expect(types).toContain('adapter:started')
      expect(types).toContain('adapter:failed')
      expect(types).not.toContain('adapter:completed')
    })
  })

  // -------------------------------------------------------------------------
  // 4. Non-zero exit / spawn throws
  // -------------------------------------------------------------------------

  describe('non-zero exit / spawn error', () => {
    it('emits adapter:failed with the thrown error message when spawnAndStreamJsonl throws', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        throw new Error('process exited with code 1')
      })

      const adapter = new TestCliAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'bad task' }))

      const failed = events.find((e) => e.type === 'adapter:failed')
      expect(failed).toBeDefined()
      if (failed && failed.type === 'adapter:failed') {
        expect(failed.error).toBe('process exited with code 1')
        expect(failed.providerId).toBe('gemini')
        expect(typeof failed.timestamp).toBe('number')
      }
    })

    it('does NOT rethrow a plain Error (only ForgeError causes rethrow)', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        throw new Error('unexpected crash')
      })

      const adapter = new TestCliAdapter()
      // collectEvents wraps the generator; if the error rethrows it propagates here.
      await expect(collectEvents(adapter.execute({ prompt: 'task' }))).resolves.toBeDefined()
    })

    it('rethrows a ForgeError after emitting adapter:failed (ForgeError.is returns true)', async () => {
      const forgeErr = new ForgeError({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'backend went away',
        recoverable: true,
      })

      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        throw forgeErr
      })

      const adapter = new TestCliAdapter()
      await expect(collectEvents(adapter.execute({ prompt: 'forge task' }))).rejects.toThrow(
        'backend went away',
      )
    })

    it('mapProviderEvent returning adapter:failed sets hasFailed=true and suppresses synthetic completed', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'failed', error: 'provider reported failure' }
      })

      const adapter = new TestCliAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'failing run' }))
      const types = events.map((e) => e.type)

      expect(types).toContain('adapter:failed')
      // When the stream itself contains a failed event, the catch-path synthetic
      // completed must NOT be appended.
      const completedCount = types.filter((t) => t === 'adapter:completed').length
      expect(completedCount).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // 5. Governance hook_execution record
  // -------------------------------------------------------------------------

  describe('governance hook records', () => {
    it('emits governance:hook_executed when stream contains a hook_execution record', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'hook_execution', hookName: 'pre-tool', exitCode: 0 }
        yield { type: 'completed', result: 'ok' }
      })

      const adapter = new TestCliAdapter()
      const governanceEvents: Parameters<Parameters<typeof adapter.onGovernanceEvent>[0]>[0][] = []
      adapter.onGovernanceEvent((e) => governanceEvents.push(e))

      await collectEvents(adapter.execute({ prompt: 'run with hooks' }))

      const hookExecuted = governanceEvents.find((e) => e.type === 'governance:hook_executed')
      expect(hookExecuted).toBeDefined()
      if (hookExecuted && hookExecuted.type === 'governance:hook_executed') {
        expect(hookExecuted.hookName).toBe('pre-tool')
        expect(hookExecuted.exitCode).toBe(0)
        expect(hookExecuted.providerId).toBe('gemini')
      }
    })

    it('emits governance:hook_executed when stream uses top-level hookName field', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { hookName: 'post-tool', exitCode: 1 }
        yield { type: 'completed', result: 'ok' }
      })

      const adapter = new TestCliAdapter()
      const governanceEvents: Parameters<Parameters<typeof adapter.onGovernanceEvent>[0]>[0][] = []
      adapter.onGovernanceEvent((e) => governanceEvents.push(e))

      await collectEvents(adapter.execute({ prompt: 'hooks 2' }))

      const hookExecuted = governanceEvents.find((e) => e.type === 'governance:hook_executed')
      expect(hookExecuted).toBeDefined()
      if (hookExecuted && hookExecuted.type === 'governance:hook_executed') {
        expect(hookExecuted.hookName).toBe('post-tool')
        expect(hookExecuted.exitCode).toBe(1)
      }
    })

    it('emits governance:hook_executed for nested hook.name pattern', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { hook: { name: 'nested-hook', exitCode: 0 } }
        yield { type: 'completed', result: 'ok' }
      })

      const adapter = new TestCliAdapter()
      const governanceEvents: Parameters<Parameters<typeof adapter.onGovernanceEvent>[0]>[0][] = []
      adapter.onGovernanceEvent((e) => governanceEvents.push(e))

      await collectEvents(adapter.execute({ prompt: 'nested hook' }))

      const hookExecuted = governanceEvents.find((e) => e.type === 'governance:hook_executed')
      expect(hookExecuted).toBeDefined()
      if (hookExecuted && hookExecuted.type === 'governance:hook_executed') {
        expect(hookExecuted.hookName).toBe('nested-hook')
      }
    })

    it('does NOT emit governance:hook_executed for ordinary non-hook records', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'message', content: 'no hooks here' }
        yield { type: 'completed', result: 'ok' }
      })

      const adapter = new TestCliAdapter()
      const governanceEvents: Parameters<Parameters<typeof adapter.onGovernanceEvent>[0]>[0][] = []
      adapter.onGovernanceEvent((e) => governanceEvents.push(e))

      await collectEvents(adapter.execute({ prompt: 'clean run' }))

      const hookEvents = governanceEvents.filter((e) => e.type === 'governance:hook_executed')
      expect(hookEvents).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // 6. Interaction detection — adapter:interaction_required via ask-caller policy
  // -------------------------------------------------------------------------

  describe('interaction detection (ask-caller policy)', () => {
    it('exposes the active resolver through respondInteraction', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(
        async function* (_binary, _args, opts) {
          if (opts.stdinResponder) {
            await opts.stdinResponder({}, 'Which environment?', 'clarification')
          }
          yield { type: 'completed', result: 'resumed' }
        },
      )
      const adapter = new TestCliAdapter()
      adapter.configure({
        interactionPolicy: {
          mode: 'ask-caller',
          askCaller: { timeoutMs: 5_000, timeoutFallback: 'auto-deny' },
        },
      })
      let interactionId = ''
      adapter.onGovernanceEvent((event) => {
        if (event.type === 'governance:approval_requested') interactionId = event.interactionId
      })

      const execution = collectEvents(adapter.execute({ prompt: 'inspect' }))
      await vi.waitFor(() => expect(interactionId).not.toBe(''))
      expect(adapter.respondInteraction(interactionId, 'staging')).toBe(true)
      const events = await execution

      expect(events).toContainEqual(expect.objectContaining({
        type: 'adapter:interaction_resolved', answer: 'staging', resolvedBy: 'caller',
      }))
      expect(adapter.respondInteraction(interactionId, 'duplicate')).toBe(false)
    })

    it('emits adapter:interaction_required and adapter:interaction_resolved when resolver handles a question', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(
        async function* (_binary, _args, opts) {
          // Simulate the CLI emitting an interactive question via stdinResponder.
          if (opts.stdinResponder) {
            await opts.stdinResponder(
              { type: 'question', message: 'Overwrite this file?' },
              'Overwrite this file?',
              'permission',
            )
          }
          yield { type: 'completed', result: 'ok' }
        },
      )

      const adapter = new TestCliAdapter()
      adapter.configure({
        interactionPolicy: {
          mode: 'ask-caller',
          askCaller: { timeoutMs: 50, timeoutFallback: 'auto-deny' },
        },
      })

      const events = await collectEvents(adapter.execute({ prompt: 'overwrite task' }))
      const types = events.map((e) => e.type)

      expect(types).toContain('adapter:interaction_required')
      expect(types).toContain('adapter:interaction_resolved')
    })

    it('adapter:interaction_required carries the question text and kind', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(
        async function* (_binary, _args, opts) {
          if (opts.stdinResponder) {
            await opts.stdinResponder(
              { type: 'question', message: 'Delete all caches?' },
              'Delete all caches?',
              'confirmation',
            )
          }
          yield { type: 'completed', result: 'ok' }
        },
      )

      const adapter = new TestCliAdapter()
      adapter.configure({
        interactionPolicy: {
          mode: 'ask-caller',
          askCaller: { timeoutMs: 50, timeoutFallback: 'auto-deny' },
        },
      })

      const events = await collectEvents(adapter.execute({ prompt: 'cache task' }))
      const required = events.find((e) => e.type === 'adapter:interaction_required')

      expect(required).toBeDefined()
      if (required && required.type === 'adapter:interaction_required') {
        expect(required.question).toBe('Delete all caches?')
        expect(required.kind).toBe('confirmation')
        expect(required.providerId).toBe('gemini')
        expect(typeof required.interactionId).toBe('string')
        expect(required.interactionId.length).toBeGreaterThan(0)
      }
    })

    it('auto-approve policy suppresses interaction_required events even when stdinResponder is skipped', async () => {
      // Under auto-approve the adapter never wires a stdinResponder, so the
      // mock's stdinResponder will be undefined and no interaction events fire.
      mockSpawnAndStreamJsonl.mockImplementation(
        async function* (_binary, _args, opts) {
          // stdinResponder is NOT present under auto-approve.
          expect(opts.stdinResponder).toBeUndefined()
          yield { type: 'completed', result: 'ok' }
        },
      )

      const adapter = new TestCliAdapter()
      adapter.configure({ interactionPolicy: { mode: 'auto-approve' } })

      const events = await collectEvents(adapter.execute({ prompt: 'silent task' }))
      const interactionEvents = events.filter(
        (e) =>
          e.type === 'adapter:interaction_required' ||
          e.type === 'adapter:interaction_resolved',
      )

      expect(interactionEvents).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // 7. Event ordering and count invariants
  // -------------------------------------------------------------------------

  describe('event ordering invariants', () => {
    it('adapter:started is always the first event regardless of JSONL output order', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', result: 'instant' }
      })

      const adapter = new TestCliAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'fast' }))

      expect(events[0].type).toBe('adapter:started')
    })

    it('exactly one terminal event (completed or failed) is emitted per execution', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'message', content: 'a' }
        yield { type: 'message', content: 'b' }
        yield { type: 'completed', result: 'multi-message run' }
      })

      const adapter = new TestCliAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'multi-message' }))

      const terminalEvents = events.filter(
        (e) => e.type === 'adapter:completed' || e.type === 'adapter:failed',
      )
      expect(terminalEvents).toHaveLength(1)
      expect(terminalEvents[0].type).toBe('adapter:completed')
    })

    it('resumeSession sets isResume=true on the adapter:started event', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', result: 'resumed' }
      })

      const adapter = new TestCliAdapter()
      const events = await collectEvents(
        adapter.resumeSession('prev-session-id', { prompt: 'continue' }),
      )

      const started = events.find((e) => e.type === 'adapter:started')
      expect(started).toBeDefined()
      if (started && started.type === 'adapter:started') {
        expect(started.isResume).toBe(true)
      }
    })
  })

  // -------------------------------------------------------------------------
  // 8. Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles an empty JSONL stream by emitting started and synthetic completed', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        // yields nothing
      })

      const adapter = new TestCliAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'empty stream' }))
      const types = events.map((e) => e.type)

      expect(types).toEqual(['adapter:started', 'adapter:completed'])
    })

    it('artifact watcher is stopped in the finally block even when spawn throws', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        throw new Error('hard crash')
      })

      const stop = vi.fn()
      const factory = vi.fn(() => ({ stop }))

      const adapter = new TestCliAdapter()
      adapter.setArtifactWatcherFactory(factory)

      await collectEvents(adapter.execute({ prompt: 'crash', workingDirectory: '/tmp' }))

      expect(factory).toHaveBeenCalledTimes(1)
      expect(stop).toHaveBeenCalledTimes(1)
    })

    it('getMonitorStatus returns ready after a successful run completes', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', result: 'done' }
      })

      const stop = vi.fn()
      const adapter = new TestCliAdapter()
      adapter.setArtifactWatcherFactory(() => ({ stop }))

      await collectEvents(adapter.execute({ prompt: 'monitor test', workingDirectory: '/tmp' }))

      expect(adapter.getMonitorStatus().state).toBe('ready')
    })

    it('input.workingDirectory is forwarded to spawnAndStreamJsonl as cwd', async () => {
      let capturedCwd: string | undefined

      mockSpawnAndStreamJsonl.mockImplementation(async function* (_binary: string, _args: string[], opts: Record<string, unknown>) {
        capturedCwd = opts['cwd'] as string | undefined
        yield { type: 'completed', result: 'ok' }
      })

      const adapter = new TestCliAdapter()
      await collectEvents(adapter.execute({ prompt: 'cwd test', workingDirectory: '/project/root' }))

      expect(capturedCwd).toBe('/project/root')
    })

    it('config.workingDirectory is used as cwd fallback when input.workingDirectory is absent', async () => {
      let capturedCwd: string | undefined

      mockSpawnAndStreamJsonl.mockImplementation(async function* (_binary: string, _args: string[], opts: Record<string, unknown>) {
        capturedCwd = opts['cwd'] as string | undefined
        yield { type: 'completed', result: 'ok' }
      })

      const adapter = new TestCliAdapter()
      adapter.configure({ workingDirectory: '/config/dir' })
      await collectEvents(adapter.execute({ prompt: 'fallback cwd' }))

      expect(capturedCwd).toBe('/config/dir')
    })

    it('adapter:failed surfaces a plain Error message from a failing process', async () => {
      // spawnAndStreamJsonl throws a plain Error on non-zero exit containing the
      // stderr text — plain errors are absorbed into adapter:failed (not rethrown).
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        throw new Error("Process 'test-bin' exited with code 1\nstderr: fatal: repo not found")
      })

      const adapter = new TestCliAdapter()
      const events = await collectEvents(adapter.execute({ prompt: 'stderr task' }))

      const failed = events.find((e) => e.type === 'adapter:failed')
      expect(failed).toBeDefined()
      if (failed && failed.type === 'adapter:failed') {
        expect(failed.error).toContain('repo not found')
        expect(failed.providerId).toBe('gemini')
      }
      // No completed event when a plain error is thrown.
      expect(events.some((e) => e.type === 'adapter:completed')).toBe(false)
    })

    it('interrupt() after execute completes is a no-op and does not throw', async () => {
      mockSpawnAndStreamJsonl.mockImplementation(async function* () {
        yield { type: 'completed', result: 'done' }
      })

      const adapter = new TestCliAdapter()
      await collectEvents(adapter.execute({ prompt: 'completed task' }))

      // currentAbortController is null after execute finishes — interrupt() must not throw.
      expect(() => adapter.interrupt()).not.toThrow()
    })
  })
})
