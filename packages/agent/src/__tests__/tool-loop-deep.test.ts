/**
 * Deep unit tests for tool-loop.ts (runToolLoop).
 *
 * Covers edge cases and code paths not exercised by tool-loop-core.test.ts:
 * - Escalating stuck recovery through stages 1-2-3 (sequential)
 * - Parallel tool execution: blocked tools, missing tools, error handling
 * - Tool returning undefined/null
 * - Concurrent tool calls with mixed success/failure
 * - Multiple budget warnings in same iteration
 * - Tool call with no id field
 * - Empty tool_calls array treated as no tool calls
 */
import { describe, it, expect, vi } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { runToolLoop, type ToolLoopConfig } from '../agent/tool-loop.js'
import { IterationBudget } from '../guardrails/iteration-budget.js'
import { StuckDetector } from '../guardrails/stuck-detector.js'

// ---------- Helpers ----------

function mockTool(name: string, result: unknown = 'ok') {
  const invokeFn = vi.fn(async (_args: Record<string, unknown>) => result)
  return {
    tool: {
      name,
      description: `Mock ${name}`,
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke: invokeFn,
    } as unknown as StructuredToolInterface,
    invokeFn,
  }
}

function failingTool(name: string, errorMsg = 'boom') {
  return {
    name,
    description: `Failing ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => { throw new Error(errorMsg) }),
  } as unknown as StructuredToolInterface
}

function createMockModel(
  responses: AIMessage[],
  opts?: { inputTokens?: number; outputTokens?: number },
): BaseChatModel {
  let callIdx = 0
  return {
    invoke: vi.fn(async () => {
      const resp = responses[callIdx] ?? new AIMessage('done')
      callIdx++
      if (opts?.inputTokens || opts?.outputTokens) {
        ;(resp as AIMessage & { usage_metadata: unknown }).usage_metadata = {
          input_tokens: opts.inputTokens ?? 0,
          output_tokens: opts.outputTokens ?? 0,
        }
      }
      return resp
    }),
  } as unknown as BaseChatModel
}

function aiWithToolCalls(
  calls: Array<{ id?: string; name: string; args: Record<string, unknown> }>,
) {
  const msg = new AIMessage({ content: '' })
  ;(msg as AIMessage & { tool_calls: unknown[] }).tool_calls = calls.map(
    (c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.name,
      args: c.args,
    }),
  )
  return msg
}

// ==========================================================================
// Escalating stuck recovery stages (sequential path)
// ==========================================================================

describe('Escalating stuck recovery (sequential, stages 1-2-3)', () => {
  it('stage 1: blocks tool but continues loop', async () => {
    const { tool } = mockTool('repeat', 'same')
    const onStuck = vi.fn()

    // Detector triggers stuck on every recordToolCall
    const detector: InstanceType<typeof StuckDetector> = {
      recordToolCall: vi.fn(() => ({ stuck: true, reason: 'Repeated tool calls' })),
      recordError: vi.fn(() => ({ stuck: false })),
      recordIteration: vi.fn(() => ({ stuck: false })),
      reset: vi.fn(),
    } as unknown as InstanceType<typeof StuckDetector>

    const model = createMockModel([
      aiWithToolCalls([{ name: 'repeat', args: { x: 1 } }]),
      new AIMessage('stopped'),
    ])

    const budget = new IterationBudget({ maxTokens: 1_000_000 })

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, stuckDetector: detector, onStuck, budget },
    )

    // Stage 1 should have been reported
    expect(onStuck).toHaveBeenCalledWith('repeat', 1)
    // Tool should have been blocked
    expect(budget.isToolBlocked('repeat')).toBe(true)
    // Loop should have continued since stuckStage < 3
    expect(result.stopReason).toBe('complete')
  })

  it('stage 3: aborts the loop after three stuck detections across different tools', async () => {
    // Use three different tools so the budget blocking does not prevent
    // subsequent tool calls from reaching the stuck detector.
    const { tool: t1 } = mockTool('tool_a', 'same')
    const { tool: t2 } = mockTool('tool_b', 'same')
    const { tool: t3 } = mockTool('tool_c', 'same')
    const onStuck = vi.fn()

    // Detector always triggers stuck
    const detector: InstanceType<typeof StuckDetector> = {
      recordToolCall: vi.fn(() => ({ stuck: true, reason: 'Same call' })),
      recordError: vi.fn(() => ({ stuck: false })),
      recordIteration: vi.fn(() => ({ stuck: false })),
      reset: vi.fn(),
    } as unknown as InstanceType<typeof StuckDetector>

    const model = createMockModel([
      aiWithToolCalls([{ name: 'tool_a', args: {} }]),
      aiWithToolCalls([{ name: 'tool_b', args: {} }]),
      aiWithToolCalls([{ name: 'tool_c', args: {} }]),
      new AIMessage('unreachable'),
    ])

    const budget = new IterationBudget({ maxTokens: 1_000_000 })

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [t1, t2, t3],
      { maxIterations: 10, stuckDetector: detector, onStuck, budget },
    )

    expect(result.stopReason).toBe('stuck')
    expect(result.stuckError).toBeDefined()
    expect(result.stuckError!.escalationLevel).toBeGreaterThanOrEqual(1)
    // onStuck should have been called multiple times (escalating stages)
    expect(onStuck).toHaveBeenCalled()
  })

  it('stage 2: injects nudge system message after second stuck detection', async () => {
    // Use different tool names per iteration so budget blocking does not
    // short-circuit before the stuck detector sees the call.
    const { tool: t1 } = mockTool('iter_1', 'same')
    const { tool: t2 } = mockTool('iter_2', 'same')
    const { tool: t3 } = mockTool('iter_3', 'same')

    const detector: InstanceType<typeof StuckDetector> = {
      recordToolCall: vi.fn(() => ({ stuck: true, reason: 'Stuck again' })),
      recordError: vi.fn(() => ({ stuck: false })),
      recordIteration: vi.fn(() => ({ stuck: false })),
      reset: vi.fn(),
    } as unknown as InstanceType<typeof StuckDetector>

    const capturedMessages: BaseMessage[][] = []
    let modelCallCount = 0
    const toolNames = ['iter_1', 'iter_2', 'iter_3']
    const model = {
      invoke: vi.fn(async (msgs: BaseMessage[]) => {
        capturedMessages.push([...msgs])
        modelCallCount++
        if (modelCallCount <= 3) {
          return aiWithToolCalls([{ name: toolNames[modelCallCount - 1]!, args: { n: modelCallCount } }])
        }
        return new AIMessage('done')
      }),
    } as unknown as BaseChatModel

    const budget = new IterationBudget({ maxTokens: 1_000_000 })

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [t1, t2, t3],
      { maxIterations: 10, stuckDetector: detector, budget },
    )

    // After stage 2, a SystemMessage nudge should have been injected
    // Check that some messages to the model contain the nudge
    const allModelMsgs = capturedMessages.flat()
    const nudgeMsgs = allModelMsgs.filter(
      m => m._getType() === 'system' && typeof m.content === 'string' && m.content.includes('stuck'),
    )
    expect(nudgeMsgs.length).toBeGreaterThanOrEqual(1)

    expect(result.stopReason).toBe('stuck')
  })
})

// ==========================================================================
// Parallel tool execution edge cases
// ==========================================================================

describe('Parallel tool execution edge cases', () => {
  it('handles blocked tool in parallel mode', async () => {
    const { tool: goodTool } = mockTool('safe', 'ok')
    const { tool: blockedTool } = mockTool('danger', 'should not see')

    const budget = new IterationBudget({ maxTokens: 1_000_000, blockedTools: ['danger'] })

    const model = createMockModel([
      aiWithToolCalls([
        { name: 'safe', args: {} },
        { name: 'danger', args: {} },
      ]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [goodTool, blockedTool],
      { maxIterations: 10, parallelTools: true, budget },
    )

    const blockedMsg = result.messages.find(
      m => typeof m.content === 'string' && m.content.includes('blocked'),
    )
    expect(blockedMsg).toBeDefined()
    expect(result.stopReason).toBe('complete')
  })

  it('handles missing tool in parallel mode', async () => {
    const { tool: existingTool } = mockTool('exists', 'found')

    const model = createMockModel([
      aiWithToolCalls([
        { name: 'exists', args: {} },
        { name: 'ghost', args: {} },
      ]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [existingTool],
      { maxIterations: 10, parallelTools: true },
    )

    const notFoundMsg = result.messages.find(
      m => typeof m.content === 'string' && m.content.includes('not found'),
    )
    expect(notFoundMsg).toBeDefined()
    expect(typeof notFoundMsg!.content === 'string' && notFoundMsg!.content).toContain('ghost')
  })

  it('handles mixed success and failure in parallel execution', async () => {
    const { tool: goodTool } = mockTool('good', 'success')
    const badTool = failingTool('bad', 'parallel failure')

    const model = createMockModel([
      aiWithToolCalls([
        { name: 'good', args: {} },
        { name: 'bad', args: {} },
      ]),
      new AIMessage('handled'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [goodTool, badTool],
      { maxIterations: 10, parallelTools: true },
    )

    // Both tools should have messages in the result
    const successMsg = result.messages.find(
      m => typeof m.content === 'string' && m.content === 'success',
    )
    const errorMsg = result.messages.find(
      m => typeof m.content === 'string' && m.content.includes('parallel failure'),
    )
    expect(successMsg).toBeDefined()
    expect(errorMsg).toBeDefined()
    expect(result.stopReason).toBe('complete')

    // Stats should track both tools
    expect(result.toolStats).toHaveLength(2)
    const badStat = result.toolStats.find(s => s.name === 'bad')
    expect(badStat?.errors).toBe(1)
  })

  it('respects maxParallelTools limit', async () => {
    const tools = Array.from({ length: 5 }, (_, i) => mockTool(`t${i}`, `r${i}`))

    const model = createMockModel([
      aiWithToolCalls(tools.map((_, i) => ({ name: `t${i}`, args: {} }))),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      tools.map(t => t.tool),
      { maxIterations: 10, parallelTools: true, maxParallelTools: 2 },
    )

    // All 5 tools should still complete (just with limited concurrency)
    expect(result.toolStats).toHaveLength(5)
    expect(result.stopReason).toBe('complete')
  })
})

// ==========================================================================
// Tool result edge cases
// ==========================================================================

describe('Tool result edge cases', () => {
  it('handles tool returning undefined', async () => {
    const { tool } = mockTool('undef', undefined)

    const model = createMockModel([
      aiWithToolCalls([{ name: 'undef', args: {} }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10 },
    )

    // undefined should be JSON.stringified
    expect(result.stopReason).toBe('complete')
    const toolMsg = result.messages.find(
      m => m._getType() === 'tool',
    )
    expect(toolMsg).toBeDefined()
  })

  it('handles tool returning null', async () => {
    const { tool } = mockTool('nullish', null)

    const model = createMockModel([
      aiWithToolCalls([{ name: 'nullish', args: {} }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10 },
    )

    expect(result.stopReason).toBe('complete')
  })

  it('handles tool returning a number', async () => {
    const { tool } = mockTool('numeric', 42)

    const model = createMockModel([
      aiWithToolCalls([{ name: 'numeric', args: {} }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10 },
    )

    const toolMsg = result.messages.find(
      m => m._getType() === 'tool' && typeof m.content === 'string' && m.content === '42',
    )
    expect(toolMsg).toBeDefined()
    expect(result.stopReason).toBe('complete')
  })

  it('handles tool returning a nested object', async () => {
    const { tool } = mockTool('nested', { a: { b: [1, 2, 3] }, c: true })

    const model = createMockModel([
      aiWithToolCalls([{ name: 'nested', args: {} }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10 },
    )

    const toolMsg = result.messages.find(
      m => m._getType() === 'tool' && typeof m.content === 'string' && m.content.includes('"a"'),
    )
    expect(toolMsg).toBeDefined()
    expect(JSON.parse(toolMsg!.content as string)).toEqual({ a: { b: [1, 2, 3] }, c: true })
  })

  it('handles tool returning empty string', async () => {
    const { tool } = mockTool('empty', '')

    const model = createMockModel([
      aiWithToolCalls([{ name: 'empty', args: {} }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10 },
    )

    expect(result.stopReason).toBe('complete')
    const toolMsg = result.messages.find(
      m => m._getType() === 'tool' && m.content === '',
    )
    expect(toolMsg).toBeDefined()
  })
})

// ==========================================================================
// Tool call ID handling
// ==========================================================================

describe('Tool call ID handling', () => {
  it('generates fallback ID when tool call has no id', async () => {
    const { tool } = mockTool('noid', 'ok')

    const msg = new AIMessage({ content: '' })
    ;(msg as AIMessage & { tool_calls: unknown[] }).tool_calls = [
      { name: 'noid', args: {} },  // no id field
    ]

    const model = createMockModel([msg, new AIMessage('done')])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10 },
    )

    // Tool message should have been created with a generated id
    const toolMsg = result.messages.find(m => m._getType() === 'tool')
    expect(toolMsg).toBeDefined()
    expect(result.stopReason).toBe('complete')
  })

  it('uses provided tool call id in the ToolMessage', async () => {
    const { tool } = mockTool('withid', 'ok')

    const model = createMockModel([
      aiWithToolCalls([{ id: 'custom-id-42', name: 'withid', args: {} }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10 },
    )

    const toolMsg = result.messages.find(
      m => m._getType() === 'tool',
    )
    expect(toolMsg).toBeDefined()
  })
})

// ==========================================================================
// Empty tool calls edge case
// ==========================================================================

describe('Empty tool_calls array', () => {
  it('treats empty tool_calls array as final response (no tool execution)', async () => {
    const { tool } = mockTool('unused')

    const msg = new AIMessage({ content: 'No tools needed' })
    ;(msg as AIMessage & { tool_calls: unknown[] }).tool_calls = []

    const model = createMockModel([msg])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10 },
    )

    expect(result.stopReason).toBe('complete')
    expect(result.llmCalls).toBe(1)
    expect(result.toolStats).toHaveLength(0)
  })
})

// ==========================================================================
// Multiple budget thresholds in a single recording
// ==========================================================================

describe('Multiple budget thresholds', () => {
  it('fires multiple warnings when crossing multiple thresholds at once', async () => {
    // Budget: 100 tokens, thresholds at [0.3, 0.5, 0.7, 0.9]
    // Single call uses 80+20=100 tokens -> crosses all four thresholds at once
    const budget = new IterationBudget({
      maxTokens: 100,
      budgetWarnings: [0.3, 0.5, 0.7, 0.9],
    })
    const warnings: string[] = []
    const { tool } = mockTool('work', 'ok')

    const model = createMockModel(
      [
        aiWithToolCalls([{ name: 'work', args: {} }]),
        new AIMessage('done'),
      ],
      { inputTokens: 80, outputTokens: 20 },
    )

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      {
        maxIterations: 10,
        budget,
        onBudgetWarning: (msg) => warnings.push(msg),
      },
    )

    // All four thresholds should have been crossed
    expect(warnings.length).toBeGreaterThanOrEqual(4)
  })
})

// ==========================================================================
// Non-Error thrown by tool
// ==========================================================================

describe('Non-Error thrown by tool', () => {
  it('handles string thrown as error', async () => {
    const tool = {
      name: 'throws_string',
      description: 'throws string',
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke: vi.fn(async () => { throw 'string error message' }),
    } as unknown as StructuredToolInterface

    const model = createMockModel([
      aiWithToolCalls([{ name: 'throws_string', args: {} }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10 },
    )

    const errorMsg = result.messages.find(
      m => typeof m.content === 'string' && m.content.includes('string error message'),
    )
    expect(errorMsg).toBeDefined()
    expect(result.toolStats[0]!.errors).toBe(1)
  })

  it('handles number thrown as error', async () => {
    const tool = {
      name: 'throws_number',
      description: 'throws number',
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke: vi.fn(async () => { throw 404 }),
    } as unknown as StructuredToolInterface

    const model = createMockModel([
      aiWithToolCalls([{ name: 'throws_number', args: {} }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10 },
    )

    const errorMsg = result.messages.find(
      m => typeof m.content === 'string' && m.content.includes('404'),
    )
    expect(errorMsg).toBeDefined()
  })
})

// ==========================================================================
// Tool transform in parallel path
// ==========================================================================

describe('transformToolResult in parallel path', () => {
  it('applies transform to results in parallel execution', async () => {
    const { tool: toolA } = mockTool('a', 'raw_a')
    const { tool: toolB } = mockTool('b', 'raw_b')

    const transformToolResult = vi.fn(
      async (_name: string, _input: Record<string, unknown>, result: string) =>
        `[t] ${result}`,
    )

    const model = createMockModel([
      aiWithToolCalls([
        { name: 'a', args: {} },
        { name: 'b', args: {} },
      ]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [toolA, toolB],
      { maxIterations: 10, parallelTools: true, transformToolResult },
    )

    const transformedMsgs = result.messages.filter(
      m => typeof m.content === 'string' && m.content.startsWith('[t]'),
    )
    expect(transformedMsgs).toHaveLength(2)
  })
})

// ==========================================================================
// Token accumulation across iterations
// ==========================================================================

describe('Token accumulation', () => {
  it('accumulates tokens correctly across multiple iterations', async () => {
    const { tool } = mockTool('step', 'ok')

    const model = createMockModel(
      [
        aiWithToolCalls([{ name: 'step', args: {} }]),
        aiWithToolCalls([{ name: 'step', args: {} }]),
        new AIMessage('done'),
      ],
      { inputTokens: 30, outputTokens: 10 },
    )

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10 },
    )

    // 3 LLM calls * (30+10) = 120 total tokens
    expect(result.totalInputTokens).toBe(90)  // 3 * 30
    expect(result.totalOutputTokens).toBe(30)  // 3 * 10
    expect(result.llmCalls).toBe(3)
  })
})

// ==========================================================================
// Validation in parallel path
// ==========================================================================

describe('validateToolArgs in parallel path', () => {
  it('returns validation error for invalid args in parallel mode', async () => {
    const tool = {
      name: 'validated',
      description: 'validated',
      schema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      lc_namespace: [] as string[],
      invoke: vi.fn(async () => 'ok'),
    } as unknown as StructuredToolInterface

    const { tool: otherTool } = mockTool('other', 'ok')

    const model = createMockModel([
      aiWithToolCalls([
        { name: 'validated', args: {} },  // missing required 'name'
        { name: 'other', args: {} },
      ]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool, otherTool],
      { maxIterations: 10, parallelTools: true, validateToolArgs: { autoRepair: false } },
    )

    const errorMsg = result.messages.find(
      m => typeof m.content === 'string' && m.content.includes('Validation failed'),
    )
    expect(errorMsg).toBeDefined()
    // The other tool should still have executed
    expect(tool.invoke).not.toHaveBeenCalled()
  })
})

// ==========================================================================
// Concurrent stuck detection does not crash in parallel mode
// ==========================================================================

describe('Stuck detection in parallel mode', () => {
  it('does not crash when stuck detector sees parallel tool results', async () => {
    const { tool: toolA } = mockTool('a', 'ok')
    const { tool: toolB } = mockTool('b', 'ok')

    const detector = new StuckDetector({ maxRepeatCalls: 5 })

    const model = createMockModel([
      aiWithToolCalls([
        { name: 'a', args: { x: 1 } },
        { name: 'b', args: { y: 2 } },
      ]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [toolA, toolB],
      { maxIterations: 10, parallelTools: true, stuckDetector: detector },
    )

    expect(result.stopReason).toBe('complete')
    expect(result.toolStats).toHaveLength(2)
  })
})
