import { describe, it, expect, vi } from 'vitest'
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { runToolLoop, type ToolLoopConfig } from '../agent/tool-loop.js'

/**
 * Minimal mock tool that returns a fixed string after an optional delay.
 */
function mockTool(name: string, result = 'ok', delayMs = 0) {
  return {
    name,
    description: `Mock ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs))
      }
      return result
    }),
  } as unknown as StructuredToolInterface
}

/**
 * Mock tool that always throws.
 */
function failingTool(name: string, errorMsg = 'boom') {
  return {
    name,
    description: `Failing ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => {
      throw new Error(errorMsg)
    }),
  } as unknown as StructuredToolInterface
}

/**
 * Create a mock model that:
 *   - On call N (0-indexed), returns the AIMessage from `responses[N]`
 *   - Falls back to a final text message if responses are exhausted
 */
function createMockModel(responses: AIMessage[]): BaseChatModel {
  let callIdx = 0
  return {
    invoke: vi.fn(async (_msgs: BaseMessage[]) => {
      const resp = responses[callIdx] ?? new AIMessage('done')
      callIdx++
      return resp
    }),
  } as unknown as BaseChatModel
}

/** Helper to build an AIMessage with tool_calls */
function aiWithToolCalls(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  const msg = new AIMessage({ content: '' })
  ;(msg as AIMessage & { tool_calls: unknown[] }).tool_calls = calls.map((c, i) => ({
    id: `call_${i}`,
    name: c.name,
    args: c.args,
  }))
  return msg
}

describe('Tool Loop Telemetry', () => {
  const baseConfig: Omit<ToolLoopConfig, 'maxIterations'> = {}

  it('populates toolStats in ToolLoopResult after execution', async () => {
    const readTool = mockTool('read_file')
    const writeTool = mockTool('write_file')

    const model = createMockModel([
      aiWithToolCalls([
        { name: 'read_file', args: { path: 'a.ts' } },
        { name: 'write_file', args: { path: 'b.ts', content: 'x' } },
      ]),
      aiWithToolCalls([
        { name: 'read_file', args: { path: 'c.ts' } },
      ]),
      new AIMessage('All done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('do stuff')],
      [readTool, writeTool],
      { maxIterations: 10 },
    )

    expect(result.toolStats).toHaveLength(2)

    const readStat = result.toolStats.find((s) => s.name === 'read_file')
    expect(readStat).toBeDefined()
    expect(readStat!.calls).toBe(2)
    expect(readStat!.errors).toBe(0)
    expect(readStat!.totalMs).toBeGreaterThanOrEqual(0)
    expect(readStat!.avgMs).toBeGreaterThanOrEqual(0)

    const writeStat = result.toolStats.find((s) => s.name === 'write_file')
    expect(writeStat).toBeDefined()
    expect(writeStat!.calls).toBe(1)
    expect(writeStat!.errors).toBe(0)
  })

  it('returns stopReason "complete" for normal completion', async () => {
    const model = createMockModel([
      new AIMessage('Final answer'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('hello')],
      [],
      { maxIterations: 10 },
    )

    expect(result.stopReason).toBe('complete')
    expect(result.hitIterationLimit).toBe(false)
    expect(result.toolStats).toEqual([])
  })

  it('returns stopReason "iteration_limit" when max iterations hit', async () => {
    // Model always calls a tool, never produces a final answer
    const toolMsg = aiWithToolCalls([{ name: 'read_file', args: { path: 'x' } }])
    const model = createMockModel([toolMsg, toolMsg, toolMsg])

    const tool = mockTool('read_file')
    const result = await runToolLoop(
      model,
      [new HumanMessage('loop')],
      [tool],
      { maxIterations: 3 },
    )

    expect(result.stopReason).toBe('iteration_limit')
    expect(result.hitIterationLimit).toBe(true)
  })

  it('returns stopReason "aborted" when signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const model = createMockModel([new AIMessage('should not reach')])

    const result = await runToolLoop(
      model,
      [new HumanMessage('test')],
      [],
      { maxIterations: 10, signal: controller.signal },
    )

    expect(result.stopReason).toBe('aborted')
  })

  it('fires onToolLatency callback with correct durationMs', async () => {
    const tool = mockTool('slow_tool', 'result', 20)
    const latencies: Array<{ name: string; durationMs: number; error?: string }> = []

    const model = createMockModel([
      aiWithToolCalls([{ name: 'slow_tool', args: {} }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      {
        maxIterations: 10,
        onToolLatency: (name, durationMs, error) => {
          latencies.push({ name, durationMs, error })
        },
      },
    )

    expect(latencies).toHaveLength(1)
    expect(latencies[0]!.name).toBe('slow_tool')
    expect(latencies[0]!.durationMs).toBeGreaterThanOrEqual(15) // allow small timing variance
    expect(latencies[0]!.error).toBeUndefined()
    expect(result.toolStats[0]!.totalMs).toBeGreaterThanOrEqual(15)
  })

  it('counts tool errors in toolStats.errors', async () => {
    const tool = failingTool('bad_tool', 'something broke')
    const latencies: Array<{ name: string; durationMs: number; error?: string }> = []

    const model = createMockModel([
      aiWithToolCalls([{ name: 'bad_tool', args: {} }]),
      aiWithToolCalls([{ name: 'bad_tool', args: { retry: true } }]),
      new AIMessage('giving up'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('try')],
      [tool],
      {
        maxIterations: 10,
        onToolLatency: (name, durationMs, error) => {
          latencies.push({ name, durationMs, error })
        },
      },
    )

    const stat = result.toolStats.find((s) => s.name === 'bad_tool')
    expect(stat).toBeDefined()
    expect(stat!.calls).toBe(2)
    expect(stat!.errors).toBe(2)
    expect(stat!.avgMs).toBeGreaterThanOrEqual(0)

    // onToolLatency should have been called with error info
    expect(latencies).toHaveLength(2)
    expect(latencies[0]!.error).toBe('something broke')
    expect(latencies[1]!.error).toBe('something broke')
  })

  it('propagates LLM invocation errors to the caller', async () => {
    const model = {
      invoke: vi.fn(async () => {
        throw new Error('LLM down')
      }),
    } as unknown as BaseChatModel

    await expect(
      runToolLoop(
        model,
        [new HumanMessage('crash')],
        [],
        { maxIterations: 10 },
      ),
    ).rejects.toThrow('LLM down')
  })

  it('toolStats has correct avgMs calculation', async () => {
    // Two calls: one ~10ms, one ~20ms => avgMs should be ~15ms
    let callCount = 0
    const tool = {
      name: 'timed_tool',
      description: 'timed',
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke: vi.fn(async () => {
        const delay = callCount === 0 ? 10 : 20
        callCount++
        await new Promise((r) => setTimeout(r, delay))
        return 'ok'
      }),
    } as unknown as StructuredToolInterface

    const model = createMockModel([
      aiWithToolCalls([{ name: 'timed_tool', args: {} }]),
      aiWithToolCalls([{ name: 'timed_tool', args: {} }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10 },
    )

    const stat = result.toolStats.find((s) => s.name === 'timed_tool')
    expect(stat).toBeDefined()
    expect(stat!.calls).toBe(2)
    // avgMs = round(totalMs / 2), should be roughly between 10 and 30
    expect(stat!.avgMs).toBeGreaterThanOrEqual(5)
    expect(stat!.avgMs).toBeLessThan(100)
  })
})
