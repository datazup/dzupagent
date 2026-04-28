/**
 * P9 Track A — Memory write-back tests.
 *
 * Verifies that DzupAgent auto-persists the agent's final response content
 * to MemoryService after a successful generate() / launch() / stream() run.
 */
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import { createEventBus, type DzupEvent } from '@dzupagent/core'
import { describe, expect, it, vi, beforeEach } from 'vitest'

import { DzupAgent } from '../agent/dzip-agent.js'

function createMemoryService() {
  return {
    get: vi.fn(async () => [] as Array<Record<string, unknown>>),
    put: vi.fn(async () => undefined),
  }
}

function createModel(content: string = 'agent response') {
  return {
    invoke: vi.fn(async () => new AIMessage({ content })),
  }
}

describe('DzupAgent memory write-back (P9)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('generate() writes back content when memory is fully configured', async () => {
    const memory = createMemoryService()
    const model = createModel('final answer')

    const agent = new DzupAgent({
      id: 'test-agent',
      instructions: 'Base instructions',
      model: model as never,
      memory: memory as never,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
    })

    const result = await agent.generate([new HumanMessage('hello')])

    expect(result.content).toBe('final answer')
    expect(memory.put).toHaveBeenCalledTimes(1)

    const putCall = memory.put.mock.calls[0]!
    expect(putCall[0]).toBe('facts')
    expect(putCall[1]).toEqual({ project: 'demo' })
    expect(typeof putCall[2]).toBe('string')
    expect(putCall[3]).toMatchObject({
      text: 'final answer',
      agentId: 'test-agent',
    })
    expect(typeof (putCall[3] as { timestamp: unknown }).timestamp).toBe('number')
  })

  it('generate() emits sanitized memory:written metadata after write-back succeeds', async () => {
    const memory = createMemoryService()
    const model = createModel('final answer')
    const eventBus = createEventBus()
    const events: DzupEvent[] = []
    eventBus.onAny((event) => events.push(event))

    const agent = new DzupAgent({
      id: 'event-agent',
      instructions: 'Base instructions',
      model: model as never,
      memory: memory as never,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      eventBus,
    })

    await agent.generate([new HumanMessage('hello')])

    const written = events.find((event) => event.type === 'memory:written')
    expect(written).toEqual({
      type: 'memory:written',
      namespace: 'facts',
      key: memory.put.mock.calls[0]![2],
    })
    expect(written).not.toHaveProperty('scope')
    expect(written).not.toHaveProperty('record')
    expect(written).not.toHaveProperty('text')
  })

  it('generate() skips write-back when memoryWriteBack is false', async () => {
    const memory = createMemoryService()
    const model = createModel()

    const agent = new DzupAgent({
      id: 'no-writeback',
      instructions: 'Base',
      model: model as never,
      memory: memory as never,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      memoryWriteBack: false,
    })

    await agent.generate([new HumanMessage('hi')])
    expect(memory.put).not.toHaveBeenCalled()
  })

  it('generate() skips write-back when memoryScope is missing', async () => {
    const memory = createMemoryService()
    const model = createModel()

    const agent = new DzupAgent({
      id: 'no-scope',
      instructions: 'Base',
      model: model as never,
      memory: memory as never,
      memoryNamespace: 'facts',
      // memoryScope intentionally omitted
    })

    await agent.generate([new HumanMessage('hi')])
    expect(memory.put).not.toHaveBeenCalled()
  })

  it('generate() skips write-back when content is empty', async () => {
    const memory = createMemoryService()
    const model = createModel('')

    const agent = new DzupAgent({
      id: 'empty-content',
      instructions: 'Base',
      model: model as never,
      memory: memory as never,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
    })

    await agent.generate([new HumanMessage('hi')])
    expect(memory.put).not.toHaveBeenCalled()
  })

  it('generate() is non-fatal when memory.put throws', async () => {
    const memory = createMemoryService()
    memory.put.mockImplementation(async () => {
      throw new Error('memory backend is down')
    })
    const model = createModel('still works')

    const agent = new DzupAgent({
      id: 'put-throws',
      instructions: 'Base',
      model: model as never,
      memory: memory as never,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
    })

    const result = await agent.generate([new HumanMessage('hi')])
    expect(result.content).toBe('still works')
    expect(memory.put).toHaveBeenCalledTimes(1)
  })

  it('generate() emits sanitized memory:error metadata when write-back fails', async () => {
    const memory = createMemoryService()
    memory.put.mockImplementation(async () => {
      throw new Error('backend leaked final answer')
    })
    const model = createModel('still works')
    const eventBus = createEventBus()
    const events: DzupEvent[] = []
    eventBus.onAny((event) => events.push(event))

    const agent = new DzupAgent({
      id: 'put-throws-event',
      instructions: 'Base',
      model: model as never,
      memory: memory as never,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      eventBus,
    })

    const result = await agent.generate([new HumanMessage('hi')])

    expect(result.content).toBe('still works')
    const error = events.find((event) => event.type === 'memory:error')
    expect(error).toEqual({
      type: 'memory:error',
      namespace: 'facts',
      key: memory.put.mock.calls[0]![2],
      message: 'Memory write-back failed',
    })
    expect(error).not.toHaveProperty('scope')
    expect(error).not.toHaveProperty('record')
    expect(error).not.toHaveProperty('text')
  })

  it('runInBackground() (via launch()) writes back content', async () => {
    const memory = createMemoryService()
    const model = createModel('background result')

    const agent = new DzupAgent({
      id: 'bg-agent',
      instructions: 'Base',
      model: model as never,
      memory: memory as never,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
    })

    const handle = await agent.launch([new HumanMessage('go')])
    const result = await handle.result()

    expect(result.status).toBe('completed')
    expect(memory.put).toHaveBeenCalled()
    // At least one of the put calls should carry the agent's output.
    const hasOutput = memory.put.mock.calls.some(([, , , record]) => {
      return (record as { text?: string }).text === 'background result'
    })
    expect(hasOutput).toBe(true)
  })

  it('generate() stamps expiresAt when ttlMs is configured (P10 Track C)', async () => {
    const memory = createMemoryService()
    const model = createModel('ttl answer')
    const ttlMs = 60_000

    const agent = new DzupAgent({
      id: 'ttl-agent',
      instructions: 'Base',
      model: model as never,
      memory: memory as never,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
      ttlMs,
    })

    const before = Date.now()
    await agent.generate([new HumanMessage('hi')])
    const after = Date.now()

    expect(memory.put).toHaveBeenCalledTimes(1)
    const record = memory.put.mock.calls[0]![3] as {
      text: string
      timestamp: number
      expiresAt: number
    }
    expect(record.text).toBe('ttl answer')
    expect(typeof record.expiresAt).toBe('number')
    // expiresAt must equal timestamp + ttlMs and also land in a sane window
    expect(record.expiresAt).toBe(record.timestamp + ttlMs)
    expect(record.expiresAt).toBeGreaterThanOrEqual(before + ttlMs)
    expect(record.expiresAt).toBeLessThanOrEqual(after + ttlMs)
  })

  it('generate() omits expiresAt when ttlMs is not configured (P10 Track C)', async () => {
    const memory = createMemoryService()
    const model = createModel('no-ttl answer')

    const agent = new DzupAgent({
      id: 'no-ttl-agent',
      instructions: 'Base',
      model: model as never,
      memory: memory as never,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
    })

    await agent.generate([new HumanMessage('hi')])

    expect(memory.put).toHaveBeenCalledTimes(1)
    const record = memory.put.mock.calls[0]![3] as Record<string, unknown>
    expect('expiresAt' in record).toBe(false)
  })

  it('stream() writes back content on complete stop reason', async () => {
    const memory = createMemoryService()
    // No `stream` on this model — stream() falls through to executeGenerateRun.
    const model = createModel('streamed answer')

    const agent = new DzupAgent({
      id: 'stream-agent',
      instructions: 'Base',
      model: model as never,
      memory: memory as never,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
    })

    const events = []
    for await (const event of agent.stream([new HumanMessage('hi')])) {
      events.push(event)
    }

    const done = events.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    expect(memory.put).toHaveBeenCalled()
    const hasOutput = memory.put.mock.calls.some(([, , , record]) => {
      return (record as { text?: string }).text === 'streamed answer'
    })
    expect(hasOutput).toBe(true)
  })
})
