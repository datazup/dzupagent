import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CrushAdapter } from '../crush/crush-adapter.js'
import { QwenAdapter } from '../qwen/qwen-adapter.js'
import type { AgentCLIAdapter, AgentEvent } from '../types.js'
import { collectEvents, getProcessHelperMocks } from './test-helpers.js'

vi.mock('../utils/process-helpers.js', () => ({
  isBinaryAvailable: vi.fn(),
  spawnAndStreamJsonl: vi.fn(),
}))

type ChaosCase = {
  name: 'qwen' | 'crush'
  adapter: AgentCLIAdapter
}

function createDeferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function terminalEventTypes(events: AgentEvent[]): Array<'adapter:completed' | 'adapter:failed'> {
  return events
    .filter((event): event is Extract<AgentEvent, { type: 'adapter:completed' | 'adapter:failed' }> =>
      event.type === 'adapter:completed' || event.type === 'adapter:failed',
    )
    .map((event) => event.type)
}

describe('adapter chaos and fault-injection coverage', () => {
  const { mockIsBinaryAvailable, mockSpawnAndStreamJsonl } = getProcessHelperMocks()

  const cases: ChaosCase[] = [
    { name: 'qwen', adapter: new QwenAdapter({ apiKey: 'test-key' }) },
    { name: 'crush', adapter: new CrushAdapter() },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsBinaryAvailable.mockResolvedValue(true)
  })

  it.each(cases)('%s ignores malformed records and preserves the terminal event', async ({ name, adapter }) => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { payload: 'ignored-without-type', nested: { value: 1 } }
      yield { type: 'message', content: { text: `${name} hello` } }
      yield { type: 'tool_result', tool_result: { name: 'search', result: { hits: 2 }, duration_ms: 21 } }
      yield { type: 'completed', output: { text: `${name} done` }, duration_ms: 12 }
    })

    const events = await collectEvents(adapter.execute({ prompt: 'chaos' }))

    expect(events.map((event) => event.type)).toEqual([
      'adapter:started',
      'adapter:message',
      'adapter:tool_result',
      'adapter:completed',
    ])

    const completed = events.at(-1)
    expect(completed?.type).toBe('adapter:completed')
    if (completed?.type === 'adapter:completed') {
      expect(completed.result).toBe(`${name} done`)
    }
    expect(terminalEventTypes(events)).toEqual(['adapter:completed'])
  })

  it.each(cases)('%s waits for delayed terminal completion before finishing', async ({ name, adapter }) => {
    const gate = createDeferred<void>()
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'message', content: `${name} pre-terminal` }
      await gate.promise
      yield { type: 'completed', result: `${name} terminal`, duration_ms: 9 }
    })

    const stream = adapter.execute({ prompt: 'delayed-terminal' })

    const started = await stream.next()
    expect(started.value?.type).toBe('adapter:started')

    const message = await stream.next()
    expect(message.value?.type).toBe('adapter:message')

    const terminalPromise = stream.next()
    let settled = false
    terminalPromise.then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)

    gate.resolve()

    const terminal = await terminalPromise
    expect(terminal.value?.type).toBe('adapter:completed')
    if (terminal.value?.type === 'adapter:completed') {
      expect(terminal.value.result).toBe(`${name} terminal`)
    }

    const tail = await collectEvents(stream)
    expect(tail).toEqual([])
  })

  it.each(cases)('%s keeps mixed event ordering deterministic', async ({ name, adapter }) => {
    mockSpawnAndStreamJsonl.mockImplementation(async function* () {
      yield { type: 'tool_result', tool_result: { name: 'search', output: { hits: 2 }, duration_ms: 3 } }
      yield { type: 'message', role: 'assistant', content: `${name} mid-stream` }
      yield { type: 'tool_call', function_call: { name: 'search', arguments: { query: 'chaos' } } }
      yield { type: 'completed', content: `${name} final`, duration_ms: 14 }
    })

    const events = await collectEvents(adapter.execute({ prompt: 'ordering-chaos' }))

    expect(events.map((event) => event.type)).toEqual([
      'adapter:started',
      'adapter:tool_result',
      'adapter:message',
      'adapter:tool_call',
      'adapter:completed',
    ])

    const toolResult = events[1]
    expect(toolResult?.type).toBe('adapter:tool_result')
    if (toolResult?.type === 'adapter:tool_result') {
      expect(toolResult.toolName).toBe('search')
      expect(toolResult.output).toBe('{"hits":2}')
    }

    const completed = events.at(-1)
    expect(completed?.type).toBe('adapter:completed')
    if (completed?.type === 'adapter:completed') {
      expect(completed.result).toBe(`${name} final`)
    }
    expect(terminalEventTypes(events)).toEqual(['adapter:completed'])
  })
})
