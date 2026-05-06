import { describe, expect, it } from 'vitest'
import { ToolMessage } from '@langchain/core/messages'
import { scheduleToolCalls } from '../agent/tool-loop/tool-scheduler-kernel.js'
import type { ToolCall, ToolCallResult } from '../agent/tool-loop/contracts.js'

function tc(name: string, id: string): ToolCall {
  return { id, name, args: {} } as ToolCall
}

function ok(name: string, id: string): ToolCallResult {
  return {
    message: new ToolMessage({ content: 'ok', tool_call_id: id, name }),
  }
}

describe('scheduleToolCalls — parallel error aggregation (AGENT-109)', () => {
  it('rethrows the original error when exactly one tool fails', async () => {
    const calls = [tc('a', '1'), tc('b', '2'), tc('c', '3')]
    const onlyError = new Error('b boom')

    const promise = scheduleToolCalls(
      calls,
      { parallelTools: true, maxParallelTools: 5 },
      async (call) => {
        if (call.name === 'b') throw onlyError
        return ok(call.name, call.id ?? 'x')
      },
    )

    await expect(promise).rejects.toBe(onlyError)
  })

  it('throws AggregateError containing all errors when multiple tools fail', async () => {
    const calls = [tc('a', '1'), tc('b', '2'), tc('c', '3')]
    const errA = new Error('a fail')
    const errC = new Error('c fail')

    const promise = scheduleToolCalls(
      calls,
      { parallelTools: true, maxParallelTools: 5 },
      async (call) => {
        if (call.name === 'a') throw errA
        if (call.name === 'c') throw errC
        return ok(call.name, call.id ?? 'x')
      },
    )

    await expect(promise).rejects.toBeInstanceOf(AggregateError)
    try {
      await promise
    } catch (e) {
      const agg = e as AggregateError
      expect(agg.message).toBe('Tool batch failed')
      expect(agg.errors).toHaveLength(2)
      expect(agg.errors).toContain(errA)
      expect(agg.errors).toContain(errC)
    }
  })
})
