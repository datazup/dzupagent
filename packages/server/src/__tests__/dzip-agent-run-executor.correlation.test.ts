import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryRunStore, ModelRegistry, createEventBus, type DzupEvent } from '@dzupagent/core'
import type { RunExecutionContext } from '../runtime/run-worker.js'

const streamedEvents: Array<{ type: string; data: Record<string, unknown> }> = []

vi.mock('@dzupagent/agent', () => ({
  DzupAgent: class {
    async *stream(): AsyncGenerator<{ type: string; data: Record<string, unknown> }, void, undefined> {
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

function makeContext(
  eventBus: ReturnType<typeof createEventBus>,
  runId = 'run-correlation-1',
): RunExecutionContext {
  return {
    runId,
    agentId: 'agent-correlation-1',
    input: { message: 'hello' },
    metadata: {},
    agent: {
      id: 'agent-correlation-1',
      name: 'Agent Correlation',
      instructions: 'Be concise',
      modelTier: 'chat',
    },
    runStore: new InMemoryRunStore(),
    eventBus,
    modelRegistry: new ModelRegistry(),
    signal: new AbortController().signal,
  }
}

describe('dzip-agent-run-executor correlation', () => {
  beforeEach(() => {
    streamedEvents.length = 0
    vi.clearAllMocks()
  })

  it('emits executionRunId on tool lifecycle events', async () => {
    streamedEvents.push(
      {
        type: 'tool_call',
        data: { name: 'read_file', args: { path: '/tmp/a.ts' } },
      },
      {
        type: 'tool_result',
        data: { name: 'read_file', result: 'ok' },
      },
      {
        type: 'done',
        data: { content: 'final output', hitIterationLimit: false },
      },
    )

    const bus = createEventBus()
    const emitted: DzupEvent[] = []
    bus.onAny((event) => emitted.push(event))

    const executor = createDzupAgentRunExecutor()
    await executor(makeContext(bus))

    const toolCalled = emitted.find((event) => event.type === 'tool:called') as
      | Extract<DzupEvent, { type: 'tool:called' }>
      | undefined
    const toolResult = emitted.find((event) => event.type === 'tool:result') as
      | Extract<DzupEvent, { type: 'tool:result' }>
      | undefined

    expect(toolCalled?.executionRunId).toBe('run-correlation-1')
    expect(toolResult?.executionRunId).toBe('run-correlation-1')
  })

  it('throws when tool:result would be emitted without executionRunId', async () => {
    streamedEvents.push(
      {
        type: 'tool_result',
        data: { name: 'read_file', result: 'ok' },
      },
      {
        type: 'done',
        data: { content: 'final output', hitIterationLimit: false },
      },
    )

    const bus = createEventBus()
    const executor = createDzupAgentRunExecutor()

    await expect(executor(makeContext(bus, ''))).rejects.toThrow(
      'Missing executionRunId for tool:result (read_file).',
    )
  })

  it('emits tool:error with executionRunId when stream fails during a tool', async () => {
    streamedEvents.push(
      {
        type: 'tool_call',
        data: { name: 'write_file', args: { path: '/tmp/a.ts' } },
      },
      {
        type: 'error',
        data: { message: 'write denied' },
      },
    )

    const bus = createEventBus()
    const emitted: DzupEvent[] = []
    bus.onAny((event) => emitted.push(event))

    const executor = createDzupAgentRunExecutor()
    await expect(executor(makeContext(bus))).rejects.toThrow('write denied')

    const toolError = emitted.find((event) => event.type === 'tool:error') as
      | Extract<DzupEvent, { type: 'tool:error' }>
      | undefined

    expect(toolError?.toolName).toBe('write_file')
    expect(toolError?.errorCode).toBe('TOOL_EXECUTION_FAILED')
    expect(toolError?.executionRunId).toBe('run-correlation-1')
  })

  it('throws when tool:error would be emitted without executionRunId', async () => {
    streamedEvents.push(
      {
        type: 'tool_call',
        data: { name: 'write_file', args: { path: '/tmp/a.ts' } },
      },
      {
        type: 'error',
        data: { message: 'write denied' },
      },
    )

    const bus = createEventBus()
    const executor = createDzupAgentRunExecutor()

    await expect(executor(makeContext(bus, ''))).rejects.toThrow(
      'Missing executionRunId for tool:error (write_file).',
    )
  })
})
