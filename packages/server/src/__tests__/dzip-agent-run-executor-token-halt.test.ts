/**
 * Session P: run:halted:token-exhausted → executor abort.
 *
 * Verifies that when the DzupAgent stream yields a `done` event with
 * `stopReason: 'token_exhausted'`, the executor:
 *   1. Does NOT throw (clean halt, not an error).
 *   2. Emits `run:halted:token-exhausted` on `ctx.eventBus` with runId,
 *      agentId, iterations, and reason.
 *   3. Surfaces the halt through `metadata.halted`/`metadata.haltReason` so
 *      downstream code (run-worker, run-context endpoint, telemetry) can
 *      react to the terminal state.
 *   4. Records a `warn` log entry describing the halt.
 *
 * Constraints:
 *   - run-engine.ts, tool-loop.ts, and dzip-agent.ts are OUT OF SCOPE; this
 *     test exercises the executor layer only, with a mocked DzupAgent that
 *     simulates the stream shape already produced by the agent package.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryRunStore, ModelRegistry, createEventBus } from '@dzupagent/core'
import type { RunExecutionContext } from '../runtime/run-worker.js'

let streamedEvents: Array<{ type: string; data: Record<string, unknown> }> = []

vi.mock('@dzupagent/agent', () => ({
  DzupAgent: class {
    async *stream(): AsyncGenerator<
      { type: string; data: Record<string, unknown> },
      void,
      undefined
    > {
      for (const event of streamedEvents) {
        yield event
      }
    }
  },
}))

vi.mock('../runtime/tool-resolver.js', () => ({
  resolveAgentTools: async () => ({
    tools: [],
    activated: [],
    unresolved: [],
    warnings: [],
    cleanup: async () => {},
  }),
}))

import { createDzupAgentRunExecutor } from '../runtime/dzip-agent-run-executor.js'

async function makeContext(
  overrides?: Partial<RunExecutionContext>,
): Promise<RunExecutionContext> {
  const runStore = overrides?.runStore ?? new InMemoryRunStore()
  const run = await runStore.create({
    agentId: 'agent-token-halt-1',
    input: { message: 'hello' },
    metadata: {},
  })
  return {
    runId: run.id,
    agentId: 'agent-token-halt-1',
    input: { message: 'hello' },
    metadata: {},
    agent: {
      id: 'agent-token-halt-1',
      name: 'Agent Token Halt',
      instructions: 'Be concise',
      modelTier: 'chat',
    },
    runStore,
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('dzip-agent-run-executor token exhaustion halt', () => {
  beforeEach(() => {
    streamedEvents = []
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('emits run:halted:token-exhausted when the stream reports token_exhausted', async () => {
    streamedEvents = [
      { type: 'text', data: { content: 'partial response ' } },
      { type: 'text', data: { content: 'before halt' } },
      {
        type: 'done',
        data: {
          content: 'partial response before halt',
          stopReason: 'token_exhausted',
          iterations: 5,
        },
      },
    ]

    const ctx = await makeContext()
    const emitSpy = vi.spyOn(ctx.eventBus, 'emit')

    const executor = createDzupAgentRunExecutor()
    const result = await executor(ctx)

    const haltedEvent = emitSpy.mock.calls
      .map((call) => call[0])
      .find((event) => (event as { type?: string }).type === 'run:halted:token-exhausted')

    expect(haltedEvent).toBeDefined()
    expect(haltedEvent).toMatchObject({
      type: 'run:halted:token-exhausted',
      agentId: 'agent-token-halt-1',
      runId: ctx.runId,
      iterations: 5,
      reason: 'token_exhausted',
    })

    // Metadata surfaces the halt so the worker / run-context endpoint can
    // distinguish between a normal completion and a token-exhaustion halt.
    expect(result.metadata).toMatchObject({
      halted: true,
      haltReason: 'token_exhausted',
      haltIterations: 5,
    })

    // The output is preserved (no throw — this is a clean halt).
    expect(result.output).toEqual({ message: 'partial response before halt' })

    // A warn-level log entry is recorded to aid debugging.
    expect(result.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'warn',
          phase: 'agent',
          message: 'Run halted due to token exhaustion',
        }),
      ]),
    )
  })

  it('does not emit run:halted:token-exhausted on a normal completion', async () => {
    streamedEvents = [
      { type: 'text', data: { content: 'all good' } },
      { type: 'done', data: { content: 'all good', stopReason: 'complete' } },
    ]

    const ctx = await makeContext()
    const emitSpy = vi.spyOn(ctx.eventBus, 'emit')

    const executor = createDzupAgentRunExecutor()
    const result = await executor(ctx)

    const haltedEvent = emitSpy.mock.calls
      .map((call) => call[0])
      .find((event) => (event as { type?: string }).type === 'run:halted:token-exhausted')

    expect(haltedEvent).toBeUndefined()
    expect(result.metadata).not.toHaveProperty('halted')
    expect(result.metadata).not.toHaveProperty('haltReason')
  })

  it('defaults iterations to 0 when the done event omits the field', async () => {
    streamedEvents = [
      {
        type: 'done',
        data: {
          content: '',
          stopReason: 'token_exhausted',
          // no iterations field
        },
      },
    ]

    const ctx = await makeContext()
    const emitSpy = vi.spyOn(ctx.eventBus, 'emit')

    const executor = createDzupAgentRunExecutor()
    await executor(ctx)

    const haltedEvent = emitSpy.mock.calls
      .map((call) => call[0])
      .find((event) => (event as { type?: string }).type === 'run:halted:token-exhausted')

    expect(haltedEvent).toMatchObject({
      type: 'run:halted:token-exhausted',
      iterations: 0,
      reason: 'token_exhausted',
    })
  })
})
