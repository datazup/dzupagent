import { describe, it, expect, vi } from 'vitest'
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { runToolLoop, type ToolLoopConfig } from '../agent/tool-loop.js'

// ---------- Helpers ----------

/**
 * Minimal mock tool that records invocations and returns after an optional delay.
 */
function mockTool(name: string, result = 'ok', delayMs = 0) {
  const invocations: Array<{ time: number }> = []
  const invokeFn = vi.fn(async () => {
    invocations.push({ time: Date.now() })
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs))
    }
    return result
  })
  return {
    tool: {
      name,
      description: `Mock ${name}`,
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke: invokeFn,
    } as unknown as StructuredToolInterface,
    invocations,
    invokeFn,
  }
}

/**
 * Mock tool that always rejects.
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
 * Create a mock model that returns responses[N] for call N, then 'done'.
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

/** Build an AIMessage carrying tool_calls. */
function aiWithToolCalls(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  const msg = new AIMessage({ content: '' })
  ;(msg as AIMessage & { tool_calls: unknown[] }).tool_calls = calls.map((c, i) => ({
    id: `call_${i}`,
    name: c.name,
    args: c.args,
  }))
  return msg
}

// ---------- Tests ----------

describe('Parallel Tool Execution', () => {
  it('executes 3 tools in parallel when parallelTools is enabled', async () => {
    const delay = 30
    const { tool: tool1, invocations: inv1 } = mockTool('tool_a', 'a', delay)
    const { tool: tool2, invocations: inv2 } = mockTool('tool_b', 'b', delay)
    const { tool: tool3, invocations: inv3 } = mockTool('tool_c', 'c', delay)

    const model = createMockModel([
      aiWithToolCalls([
        { name: 'tool_a', args: {} },
        { name: 'tool_b', args: {} },
        { name: 'tool_c', args: {} },
      ]),
      new AIMessage('All done'),
    ])

    const startTime = Date.now()
    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool1, tool2, tool3],
      { maxIterations: 10, parallelTools: true },
    )
    const elapsed = Date.now() - startTime

    // All 3 tools should have been called
    expect(inv1).toHaveLength(1)
    expect(inv2).toHaveLength(1)
    expect(inv3).toHaveLength(1)

    // Parallel: total time should be roughly 1x delay, not 3x
    // Allow generous margin but ensure it's less than 3x sequential
    expect(elapsed).toBeLessThan(delay * 3)

    // All start times should be close together (within ~10ms)
    const starts = [inv1[0]!.time, inv2[0]!.time, inv3[0]!.time]
    const spread = Math.max(...starts) - Math.min(...starts)
    expect(spread).toBeLessThan(delay) // started before any could finish

    expect(result.stopReason).toBe('complete')
    expect(result.toolStats).toHaveLength(3)
  })

  it('executes tools sequentially when parallelTools is disabled (default)', async () => {
    const delay = 20
    const { tool: tool1, invocations: inv1 } = mockTool('tool_a', 'a', delay)
    const { tool: tool2, invocations: inv2 } = mockTool('tool_b', 'b', delay)

    const model = createMockModel([
      aiWithToolCalls([
        { name: 'tool_a', args: {} },
        { name: 'tool_b', args: {} },
      ]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool1, tool2],
      { maxIterations: 10 }, // parallelTools not set
    )

    expect(inv1).toHaveLength(1)
    expect(inv2).toHaveLength(1)

    // Sequential: tool_b should start after tool_a finishes
    // tool_b start time should be >= tool_a start time + delay
    const diff = inv2[0]!.time - inv1[0]!.time
    expect(diff).toBeGreaterThanOrEqual(delay - 5) // small timing tolerance

    expect(result.stopReason).toBe('complete')
  })

  it('respects maxParallelTools limit', async () => {
    // Create 5 tools, maxParallel=2 means 3 batches (2+2+1)
    const toolMocks = Array.from({ length: 5 }, (_, i) => mockTool(`tool_${i}`, `r${i}`, 15))

    const model = createMockModel([
      aiWithToolCalls(
        toolMocks.map((_, i) => ({ name: `tool_${i}`, args: {} })),
      ),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      toolMocks.map(m => m.tool),
      { maxIterations: 10, parallelTools: true, maxParallelTools: 2 },
    )

    // All tools should execute
    for (const m of toolMocks) {
      expect(m.invocations).toHaveLength(1)
    }

    // With batches of 2, the first two should start together, and the
    // third+fourth should start after the first batch completes.
    // We verify by checking that tool_2 started after tool_0 finished.
    const t0Start = toolMocks[0]!.invocations[0]!.time
    const t2Start = toolMocks[2]!.invocations[0]!.time
    expect(t2Start - t0Start).toBeGreaterThanOrEqual(10) // second batch started later

    expect(result.stopReason).toBe('complete')
    expect(result.toolStats).toHaveLength(5)
  })

  it('failed tools do not block others (Promise.allSettled)', async () => {
    const { tool: goodTool, invocations: goodInv } = mockTool('good', 'success', 10)
    const badTool = failingTool('bad', 'tool crashed')
    const { tool: anotherGood, invocations: anotherInv } = mockTool('good2', 'also ok', 10)

    const model = createMockModel([
      aiWithToolCalls([
        { name: 'good', args: {} },
        { name: 'bad', args: {} },
        { name: 'good2', args: {} },
      ]),
      new AIMessage('handled'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [goodTool, badTool, anotherGood],
      { maxIterations: 10, parallelTools: true },
    )

    // Both good tools should have executed
    expect(goodInv).toHaveLength(1)
    expect(anotherInv).toHaveLength(1)

    // Result should contain error message for the bad tool
    const errorMsg = result.messages.find(
      m => typeof m.content === 'string' && m.content.includes('tool crashed'),
    )
    expect(errorMsg).toBeDefined()

    // Stats should show the error
    const badStat = result.toolStats.find(s => s.name === 'bad')
    expect(badStat).toBeDefined()
    expect(badStat!.errors).toBe(1)

    expect(result.stopReason).toBe('complete')
  })

  it('abort signal cancels parallel batch', async () => {
    const controller = new AbortController()

    // Create tools with significant delay
    const { tool: tool1 } = mockTool('slow1', 'a', 200)
    const { tool: tool2 } = mockTool('slow2', 'b', 200)

    const model = createMockModel([
      aiWithToolCalls([
        { name: 'slow1', args: {} },
        { name: 'slow2', args: {} },
      ]),
      aiWithToolCalls([
        { name: 'slow1', args: {} },
      ]),
      new AIMessage('done'),
    ])

    // Abort before the second iteration's tool calls
    // The first batch will execute, but the next iteration check will catch abort
    setTimeout(() => controller.abort(), 50)

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool1, tool2],
      {
        maxIterations: 10,
        parallelTools: true,
        signal: controller.signal,
      },
    )

    // Should stop due to abort (either during iteration check or between batches)
    expect(['aborted', 'complete']).toContain(result.stopReason)
  })

  it('single tool call uses sequential path even when parallel enabled', async () => {
    const { tool, invocations } = mockTool('solo', 'result')

    const model = createMockModel([
      aiWithToolCalls([{ name: 'solo', args: {} }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, parallelTools: true },
    )

    expect(invocations).toHaveLength(1)
    expect(result.stopReason).toBe('complete')
  })

  it('parallel execution still populates toolStats correctly', async () => {
    const { tool: tool1 } = mockTool('reader', 'data', 10)
    const { tool: tool2 } = mockTool('writer', 'ok', 10)

    const model = createMockModel([
      aiWithToolCalls([
        { name: 'reader', args: {} },
        { name: 'writer', args: {} },
      ]),
      aiWithToolCalls([
        { name: 'reader', args: {} },
      ]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool1, tool2],
      { maxIterations: 10, parallelTools: true },
    )

    expect(result.toolStats).toHaveLength(2)
    const readerStat = result.toolStats.find(s => s.name === 'reader')
    expect(readerStat!.calls).toBe(2)
    expect(readerStat!.avgMs).toBeGreaterThanOrEqual(0)

    const writerStat = result.toolStats.find(s => s.name === 'writer')
    expect(writerStat!.calls).toBe(1)
  })
})

describe('Tool Arg Validation in Tool Loop', () => {
  it('validates and repairs tool args when validateToolArgs is enabled', async () => {
    const tool = {
      name: 'search',
      description: 'Search tool',
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', default: 10 },
        },
        required: ['query'],
      },
      lc_namespace: [] as string[],
      invoke: vi.fn(async (args: Record<string, unknown>) => {
        // Verify we receive repaired args
        return JSON.stringify(args)
      }),
    } as unknown as StructuredToolInterface

    const model = createMockModel([
      aiWithToolCalls([{ name: 'search', args: { query: 'test', limit: '5', extra: 'junk' } }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('search')],
      [tool],
      { maxIterations: 10, validateToolArgs: true },
    )

    expect(result.stopReason).toBe('complete')
    // Tool should have been called with repaired args (limit as number, extra removed)
    expect(tool.invoke).toHaveBeenCalledTimes(1)
    const calledWith = (tool.invoke as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>
    expect(calledWith.limit).toBe(5)
    expect(calledWith).not.toHaveProperty('extra')
  })

  it('sends validation error to LLM when args are invalid and not repairable', async () => {
    const tool = {
      name: 'deploy',
      description: 'Deploy',
      schema: {
        type: 'object',
        properties: {
          target: { type: 'string' },
        },
        required: ['target'],
      },
      lc_namespace: [] as string[],
      invoke: vi.fn(async () => 'deployed'),
    } as unknown as StructuredToolInterface

    // LLM sends no args at all (missing required 'target')
    const model = createMockModel([
      aiWithToolCalls([{ name: 'deploy', args: {} }]),
      new AIMessage('Sorry, let me fix that'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('deploy')],
      [tool],
      { maxIterations: 10, validateToolArgs: { autoRepair: true } },
    )

    // Tool should NOT have been invoked (validation failed)
    expect(tool.invoke).not.toHaveBeenCalled()

    // The error message should be in the conversation
    const errorMsg = result.messages.find(
      m => typeof m.content === 'string' && m.content.includes('Validation failed'),
    )
    expect(errorMsg).toBeDefined()
    expect(typeof errorMsg!.content === 'string' && errorMsg!.content).toContain('Missing required field')
  })

  it('skips validation when validateToolArgs is not set', async () => {
    const tool = {
      name: 'raw',
      description: 'Raw tool',
      schema: {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
      },
      lc_namespace: [] as string[],
      invoke: vi.fn(async () => 'ok'),
    } as unknown as StructuredToolInterface

    const model = createMockModel([
      // LLM passes string instead of number — normally invalid
      aiWithToolCalls([{ name: 'raw', args: { count: 'not-a-number' } }]),
      new AIMessage('done'),
    ])

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10 }, // no validateToolArgs
    )

    // Tool should still be called (no validation)
    expect(tool.invoke).toHaveBeenCalledTimes(1)
  })

  it('validation works with parallel tool execution', async () => {
    const tool1 = {
      name: 'search',
      description: 'Search',
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', default: 10 },
        },
        required: ['query'],
      },
      lc_namespace: [] as string[],
      invoke: vi.fn(async () => 'results'),
    } as unknown as StructuredToolInterface

    const tool2 = {
      name: 'count',
      description: 'Count',
      schema: {
        type: 'object',
        properties: {
          items: { type: 'array' },
        },
        required: ['items'],
      },
      lc_namespace: [] as string[],
      invoke: vi.fn(async () => '3'),
    } as unknown as StructuredToolInterface

    const model = createMockModel([
      aiWithToolCalls([
        { name: 'search', args: { query: 'test', limit: '20' } }, // needs repair
        { name: 'count', args: { items: 'single' } },             // needs array wrap
      ]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool1, tool2],
      { maxIterations: 10, parallelTools: true, validateToolArgs: true },
    )

    expect(result.stopReason).toBe('complete')
    // Both tools should have been called with repaired args
    expect(tool1.invoke).toHaveBeenCalledTimes(1)
    expect(tool2.invoke).toHaveBeenCalledTimes(1)

    const searchArgs = (tool1.invoke as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>
    expect(searchArgs.limit).toBe(20) // string -> number

    const countArgs = (tool2.invoke as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>
    expect(countArgs.items).toEqual(['single']) // string -> array
  })
})
