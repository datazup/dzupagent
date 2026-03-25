import { describe, it, expect } from 'vitest'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { StreamActionParser } from '../streaming/stream-action-parser.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('StreamActionParser', () => {
  it('respects maxParallelTools when executing parallel tool calls', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const waits: Array<Deferred<string>> = []

    const slowTool = {
      name: 'slow-tool',
      invoke: async (): Promise<string> => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        const wait = deferred<string>()
        waits.push(wait)
        const value = await wait.promise
        inFlight--
        return value
      },
    } as StructuredToolInterface

    const parser = new StreamActionParser([slowTool], {
      parallelExecution: true,
      maxParallelTools: 2,
    })

    await parser.processChunk({
      tool_calls: [{ id: 't1', name: 'slow-tool', args: {} }],
    })
    await parser.processChunk({
      tool_calls: [{ id: 't2', name: 'slow-tool', args: {} }],
    })

    // Third call should wait until one of the first two completes.
    setTimeout(() => {
      waits[0]!.resolve('r1')
    }, 0)

    const thirdEvents = await parser.processChunk({
      tool_calls: [{ id: 't3', name: 'slow-tool', args: {} }],
    })

    waits[1]!.resolve('r2')
    waits[2]!.resolve('r3')

    const flushedEvents = await parser.flush()
    const allEvents = [...thirdEvents, ...flushedEvents]
    const toolResults = allEvents.filter(e => e.type === 'tool_result')

    expect(toolResults.length).toBe(3)
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })
})
