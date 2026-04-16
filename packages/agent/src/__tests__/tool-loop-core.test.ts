/**
 * Core tool-loop tests covering branches not exercised by parallel-tool-loop
 * or stuck-recovery test suites:
 *
 * - Sequential tool execution path (parallelTools: false)
 * - Budget exceeded / onBudgetWarning callbacks
 * - AbortSignal abort path
 * - validateToolArgs: false / true / config object in sequential path
 * - transformToolResult in sequential path
 * - toolStatsTracker hint injection
 * - StuckError construction at each escalation level
 * - Iteration limit stop reason
 * - Tool not found in sequential path
 * - onToolCall / onToolResult callbacks in sequential path
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
import { StuckError } from '../agent/stuck-error.js'

// ---------- Helpers ----------

/** Minimal mock tool that records invocations. */
function mockTool(name: string, result = 'ok') {
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

/** Mock tool with a JSON schema for validation tests. */
function mockToolWithSchema(
  name: string,
  schema: Record<string, unknown>,
  result = 'ok',
) {
  const invokeFn = vi.fn(async (_args: Record<string, unknown>) => result)
  return {
    tool: {
      name,
      description: `Mock ${name}`,
      schema,
      lc_namespace: [] as string[],
      invoke: invokeFn,
    } as unknown as StructuredToolInterface,
    invokeFn,
  }
}

/** Mock tool that throws on invoke. */
function failingTool(name: string, errorMsg = 'boom') {
  return {
    name,
    description: `Failing ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => { throw new Error(errorMsg) }),
  } as unknown as StructuredToolInterface
}

/**
 * Create a mock model returning responses[N] for call N, then 'done'.
 * Optionally attaches usage_metadata so extractTokenUsage picks up tokens.
 */
function createMockModel(
  responses: AIMessage[],
  opts?: { inputTokens?: number; outputTokens?: number },
): BaseChatModel {
  let callIdx = 0
  const inputTokens = opts?.inputTokens ?? 0
  const outputTokens = opts?.outputTokens ?? 0
  return {
    invoke: vi.fn(async (_msgs: BaseMessage[]) => {
      const resp = responses[callIdx] ?? new AIMessage('done')
      callIdx++
      // Attach usage_metadata so extractTokenUsage works
      if (inputTokens || outputTokens) {
        ;(resp as AIMessage & { usage_metadata: unknown }).usage_metadata = {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        }
      }
      return resp
    }),
  } as unknown as BaseChatModel
}

/** Build an AIMessage carrying tool_calls. */
function aiWithToolCalls(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
) {
  const msg = new AIMessage({ content: '' })
  ;(msg as AIMessage & { tool_calls: unknown[] }).tool_calls = calls.map(
    (c, i) => ({
      id: `call_${i}`,
      name: c.name,
      args: c.args,
    }),
  )
  return msg
}

// ==========================================================================
// Sequential tool execution (parallelTools: false or unset)
// ==========================================================================

describe('Sequential tool execution', () => {
  it('executes a single tool call and appends result', async () => {
    const { tool, invokeFn } = mockTool('read_file', 'file contents')
    const model = createMockModel([
      aiWithToolCalls([{ name: 'read_file', args: { path: 'a.ts' } }]),
      new AIMessage('Here is the file'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('read a.ts')],
      [tool],
      { maxIterations: 10 },
    )

    expect(invokeFn).toHaveBeenCalledTimes(1)
    expect(invokeFn).toHaveBeenCalledWith({ path: 'a.ts' })
    expect(result.stopReason).toBe('complete')
    expect(result.llmCalls).toBe(2)

    // ToolMessage with the result should be in messages
    const toolMsg = result.messages.find(
      m => m._getType() === 'tool' && typeof m.content === 'string' && m.content === 'file contents',
    )
    expect(toolMsg).toBeDefined()
  })

  it('handles multiple tool calls in a single response sequentially', async () => {
    const { tool: toolA, invokeFn: invA } = mockTool('a', 'result_a')
    const { tool: toolB, invokeFn: invB } = mockTool('b', 'result_b')

    const model = createMockModel([
      aiWithToolCalls([
        { name: 'a', args: { x: 1 } },
        { name: 'b', args: { y: 2 } },
      ]),
      new AIMessage('All done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [toolA, toolB],
      { maxIterations: 10 }, // parallelTools not set => sequential
    )

    expect(invA).toHaveBeenCalledTimes(1)
    expect(invB).toHaveBeenCalledTimes(1)
    expect(result.stopReason).toBe('complete')
    expect(result.toolStats).toHaveLength(2)
  })

  it('handles multiple iterations of sequential tool calls', async () => {
    const { tool, invokeFn } = mockTool('step', 'ok')

    const model = createMockModel([
      aiWithToolCalls([{ name: 'step', args: { n: 1 } }]),
      aiWithToolCalls([{ name: 'step', args: { n: 2 } }]),
      aiWithToolCalls([{ name: 'step', args: { n: 3 } }]),
      new AIMessage('Final'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10 },
    )

    expect(invokeFn).toHaveBeenCalledTimes(3)
    expect(result.llmCalls).toBe(4) // 3 tool iterations + final response
    expect(result.stopReason).toBe('complete')
    expect(result.toolStats[0]!.calls).toBe(3)
  })

  it('returns error message when tool not found (sequential path)', async () => {
    const { tool } = mockTool('exists')

    const model = createMockModel([
      aiWithToolCalls([{ name: 'nonexistent', args: {} }]),
      new AIMessage('ok'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10 },
    )

    const errorMsg = result.messages.find(
      m => typeof m.content === 'string' && m.content.includes('not found'),
    )
    expect(errorMsg).toBeDefined()
    expect(typeof errorMsg!.content === 'string' && errorMsg!.content).toContain('nonexistent')
    expect(typeof errorMsg!.content === 'string' && errorMsg!.content).toContain('exists')
  })

  it('handles tool execution error in sequential path', async () => {
    const bad = failingTool('bad_tool', 'something broke')

    const model = createMockModel([
      aiWithToolCalls([{ name: 'bad_tool', args: {} }]),
      new AIMessage('handled'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [bad],
      { maxIterations: 10 },
    )

    expect(result.stopReason).toBe('complete')
    const errorMsg = result.messages.find(
      m => typeof m.content === 'string' && m.content.includes('something broke'),
    )
    expect(errorMsg).toBeDefined()

    const stat = result.toolStats.find(s => s.name === 'bad_tool')
    expect(stat).toBeDefined()
    expect(stat!.errors).toBe(1)
    expect(stat!.calls).toBe(1)
  })

  it('fires onToolCall and onToolResult callbacks in sequential path', async () => {
    const { tool } = mockTool('echo', 'hello')
    const onToolCall = vi.fn()
    const onToolResult = vi.fn()

    const model = createMockModel([
      aiWithToolCalls([{ name: 'echo', args: { msg: 'hi' } }]),
      new AIMessage('done'),
    ])

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, onToolCall, onToolResult },
    )

    expect(onToolCall).toHaveBeenCalledWith('echo', { msg: 'hi' })
    expect(onToolResult).toHaveBeenCalledWith('echo', 'hello')
  })

  it('fires onToolLatency callback with duration', async () => {
    const { tool } = mockTool('fast', 'ok')
    const onToolLatency = vi.fn()

    const model = createMockModel([
      aiWithToolCalls([{ name: 'fast', args: {} }]),
      new AIMessage('done'),
    ])

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, onToolLatency },
    )

    expect(onToolLatency).toHaveBeenCalledTimes(1)
    expect(onToolLatency).toHaveBeenCalledWith('fast', expect.any(Number), undefined)
  })

  it('fires onToolLatency with error string on tool failure', async () => {
    const bad = failingTool('broken', 'oops')
    const onToolLatency = vi.fn()

    const model = createMockModel([
      aiWithToolCalls([{ name: 'broken', args: {} }]),
      new AIMessage('done'),
    ])

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [bad],
      { maxIterations: 10, onToolLatency },
    )

    expect(onToolLatency).toHaveBeenCalledWith('broken', expect.any(Number), 'oops')
  })
})

// ==========================================================================
// transformToolResult in sequential path
// ==========================================================================

describe('transformToolResult (sequential)', () => {
  it('transforms tool result before appending to messages', async () => {
    const { tool } = mockTool('search', 'raw data here')

    const model = createMockModel([
      aiWithToolCalls([{ name: 'search', args: { q: 'test' } }]),
      new AIMessage('done'),
    ])

    const transformToolResult = vi.fn(
      async (_name: string, _input: Record<string, unknown>, result: string) =>
        `[transformed] ${result}`,
    )

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, transformToolResult },
    )

    expect(transformToolResult).toHaveBeenCalledWith('search', { q: 'test' }, 'raw data here')

    const toolMsg = result.messages.find(
      m => typeof m.content === 'string' && m.content.includes('[transformed]'),
    )
    expect(toolMsg).toBeDefined()
  })

  it('passes tool name and input args to transformToolResult', async () => {
    const { tool } = mockTool('deploy', '{"status":"ok"}')
    const calls: Array<{ name: string; input: Record<string, unknown> }> = []

    const model = createMockModel([
      aiWithToolCalls([{ name: 'deploy', args: { target: 'prod' } }]),
      new AIMessage('done'),
    ])

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      {
        maxIterations: 10,
        transformToolResult: async (name, input, result) => {
          calls.push({ name, input })
          return result
        },
      },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe('deploy')
    expect(calls[0]!.input).toEqual({ target: 'prod' })
  })

  it('does not transform when tool returns non-string (JSON.stringify used)', async () => {
    const tool = {
      name: 'data',
      description: 'Mock data',
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke: vi.fn(async () => ({ count: 42 })),
    } as unknown as StructuredToolInterface

    const transformToolResult = vi.fn(
      async (_n: string, _i: Record<string, unknown>, result: string) => result,
    )

    const model = createMockModel([
      aiWithToolCalls([{ name: 'data', args: {} }]),
      new AIMessage('done'),
    ])

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, transformToolResult },
    )

    // The raw result should be JSON-stringified before passing to transform
    expect(transformToolResult).toHaveBeenCalledWith(
      'data',
      {},
      '{"count":42}',
    )
  })
})

// ==========================================================================
// Budget exceeded path
// ==========================================================================

describe('Budget exceeded path', () => {
  it('stops with budget_exceeded when token limit is exceeded', async () => {
    // Budget allows 100 tokens total
    const budget = new IterationBudget({ maxTokens: 100 })
    const { tool } = mockTool('work', 'ok')

    const model = createMockModel(
      [
        aiWithToolCalls([{ name: 'work', args: {} }]),
        aiWithToolCalls([{ name: 'work', args: {} }]),
        new AIMessage('done'),
      ],
      { inputTokens: 60, outputTokens: 20 },
    )

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, budget },
    )

    // First LLM call: 60+20=80 tokens (below 100)
    // Second iteration budget check: isExceeded should trigger at 80 >= 100? No, 80 < 100.
    // After second LLM call: 160 total, then next iteration check catches it.
    expect(result.stopReason).toBe('budget_exceeded')
    expect(result.hitIterationLimit).toBe(true)

    // Should have an agent-stopped message
    const stopMsg = result.messages.find(
      m => typeof m.content === 'string' && m.content.includes('Agent stopped'),
    )
    expect(stopMsg).toBeDefined()
  })

  it('stops with budget_exceeded when cost limit is exceeded', async () => {
    // Very tight cost limit
    const budget = new IterationBudget({ maxCostCents: 1 })
    const { tool } = mockTool('expensive', 'ok')

    const model = createMockModel(
      [
        aiWithToolCalls([{ name: 'expensive', args: {} }]),
        aiWithToolCalls([{ name: 'expensive', args: {} }]),
        new AIMessage('done'),
      ],
      { inputTokens: 100_000, outputTokens: 100_000 },
    )

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, budget },
    )

    expect(result.stopReason).toBe('budget_exceeded')
  })

  it('stops with budget_exceeded when iteration limit in budget is exceeded', async () => {
    const budget = new IterationBudget({ maxIterations: 2 })
    const { tool } = mockTool('step', 'ok')

    const model = createMockModel([
      aiWithToolCalls([{ name: 'step', args: {} }]),
      aiWithToolCalls([{ name: 'step', args: {} }]),
      aiWithToolCalls([{ name: 'step', args: {} }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, budget },
    )

    expect(result.stopReason).toBe('budget_exceeded')
  })

  it('onBudgetWarning fires when threshold is crossed', async () => {
    // Budget: 100 tokens, default thresholds [0.7, 0.9]
    // Each call uses 40+10=50 tokens. After first call: 50/100 = 50% (no warning).
    // After second call: 100/100 = 100% (crosses both 0.7 and 0.9).
    const budget = new IterationBudget({ maxTokens: 100 })
    const warnings: string[] = []
    const { tool } = mockTool('work', 'ok')

    const model = createMockModel(
      [
        aiWithToolCalls([{ name: 'work', args: {} }]),
        aiWithToolCalls([{ name: 'work', args: {} }]),
        new AIMessage('done'),
      ],
      { inputTokens: 40, outputTokens: 10 },
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

    // At least one warning should have been emitted
    expect(warnings.length).toBeGreaterThanOrEqual(1)
    // Should mention token budget
    expect(warnings.some(w => w.includes('Token budget'))).toBe(true)
  })

  it('onBudgetWarning fires from recordIteration thresholds', async () => {
    // Budget: 3 max iterations, thresholds [0.7]
    // At iteration 3: 3/3 >= 0.7 => warning from recordIteration
    const budget = new IterationBudget({ maxIterations: 4, budgetWarnings: [0.7] })
    const warnings: string[] = []
    const { tool } = mockTool('step', 'ok')

    const model = createMockModel([
      aiWithToolCalls([{ name: 'step', args: {} }]),
      aiWithToolCalls([{ name: 'step', args: {} }]),
      aiWithToolCalls([{ name: 'step', args: {} }]),
      new AIMessage('done'),
    ])

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

    expect(warnings.some(w => w.includes('Iteration budget'))).toBe(true)
  })

  it('blocked tool returns blocked message in sequential path', async () => {
    const budget = new IterationBudget({ maxTokens: 1_000_000, blockedTools: ['danger'] })
    const { tool } = mockTool('danger', 'should not see this')
    const onToolResult = vi.fn()

    const model = createMockModel([
      aiWithToolCalls([{ name: 'danger', args: {} }]),
      new AIMessage('ok'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, budget, onToolResult },
    )

    const blockedMsg = result.messages.find(
      m => typeof m.content === 'string' && m.content.includes('blocked'),
    )
    expect(blockedMsg).toBeDefined()
    expect(onToolResult).toHaveBeenCalledWith('danger', '[blocked]')
  })
})

// ==========================================================================
// AbortSignal path
// ==========================================================================

describe('AbortSignal abort path', () => {
  it('returns stopReason aborted when signal is already aborted before loop', async () => {
    const { tool } = mockTool('noop')
    const controller = new AbortController()
    controller.abort() // abort before starting

    const model = createMockModel([new AIMessage('should not reach')])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, signal: controller.signal },
    )

    expect(result.stopReason).toBe('aborted')
    expect(result.llmCalls).toBe(0)
  })

  it('returns stopReason aborted when signal aborted between iterations', async () => {
    const { tool } = mockTool('work', 'ok')
    const controller = new AbortController()

    // Abort after the model's first invocation
    let callCount = 0
    const model = {
      invoke: vi.fn(async (_msgs: BaseMessage[]) => {
        callCount++
        if (callCount === 1) {
          // After first call, abort for next iteration
          controller.abort()
          return aiWithToolCalls([{ name: 'work', args: {} }])
        }
        return new AIMessage('done')
      }),
    } as unknown as BaseChatModel

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, signal: controller.signal },
    )

    expect(result.stopReason).toBe('aborted')
    expect(result.llmCalls).toBe(1)
  })

  it('aborted result has correct message and token counts', async () => {
    const { tool } = mockTool('noop')
    const controller = new AbortController()
    controller.abort()

    const model = createMockModel([new AIMessage('unused')])

    const result = await runToolLoop(
      model,
      [new HumanMessage('test')],
      [tool],
      { maxIterations: 5, signal: controller.signal },
    )

    expect(result.stopReason).toBe('aborted')
    expect(result.totalInputTokens).toBe(0)
    expect(result.totalOutputTokens).toBe(0)
    expect(result.toolStats).toHaveLength(0)
    expect(result.hitIterationLimit).toBe(false)
  })
})

// ==========================================================================
// validateToolArgs paths (sequential)
// ==========================================================================

describe('validateToolArgs paths (sequential)', () => {
  it('validateToolArgs: false - no validation, args passed as-is', async () => {
    const { tool, invokeFn } = mockToolWithSchema(
      'search',
      {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
      },
    )

    const model = createMockModel([
      aiWithToolCalls([{ name: 'search', args: { count: 'not-a-number', extra: true } }]),
      new AIMessage('done'),
    ])

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, validateToolArgs: false },
    )

    // Tool invoked with raw args (no coercion, no extra field removal)
    expect(invokeFn).toHaveBeenCalledWith({ count: 'not-a-number', extra: true })
  })

  it('validateToolArgs: true - validation with auto-repair enabled', async () => {
    const { tool, invokeFn } = mockToolWithSchema(
      'search',
      {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', default: 10 },
        },
        required: ['query'],
      },
    )

    const model = createMockModel([
      aiWithToolCalls([{ name: 'search', args: { query: 'test', limit: '5', extra: 'junk' } }]),
      new AIMessage('done'),
    ])

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, validateToolArgs: true },
    )

    const calledWith = invokeFn.mock.calls[0]![0] as Record<string, unknown>
    expect(calledWith.limit).toBe(5) // string '5' coerced to number
    expect(calledWith).not.toHaveProperty('extra') // extra field removed
    expect(calledWith.query).toBe('test')
  })

  it('validateToolArgs: config object with autoRepair: false - fails on invalid', async () => {
    const { tool, invokeFn } = mockToolWithSchema(
      'deploy',
      {
        type: 'object',
        properties: {
          target: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['target'],
      },
    )

    const model = createMockModel([
      // Missing required 'target', has wrong type for 'count'
      aiWithToolCalls([{ name: 'deploy', args: { count: 'abc' } }]),
      new AIMessage('fixed'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, validateToolArgs: { autoRepair: false } },
    )

    // Tool should NOT be invoked when validation fails without auto-repair
    expect(invokeFn).not.toHaveBeenCalled()

    const errorMsg = result.messages.find(
      m => typeof m.content === 'string' && m.content.includes('Validation failed'),
    )
    expect(errorMsg).toBeDefined()
  })

  it('validateToolArgs: true - missing required field not repairable', async () => {
    const { tool, invokeFn } = mockToolWithSchema(
      'create',
      {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    )

    const model = createMockModel([
      aiWithToolCalls([{ name: 'create', args: {} }]),
      new AIMessage('retry'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, validateToolArgs: true },
    )

    expect(invokeFn).not.toHaveBeenCalled()
    const errorMsg = result.messages.find(
      m => typeof m.content === 'string' && m.content.includes('Missing required field'),
    )
    expect(errorMsg).toBeDefined()
  })

  it('validates args for tool with no schema (passthrough)', async () => {
    // Tool with no schema properties => validation skipped, args pass through
    const { tool, invokeFn } = mockTool('simple', 'ok')

    const model = createMockModel([
      aiWithToolCalls([{ name: 'simple', args: { anything: 'goes' } }]),
      new AIMessage('done'),
    ])

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, validateToolArgs: true },
    )

    // Should still invoke since no schema to validate against
    expect(invokeFn).toHaveBeenCalledWith({ anything: 'goes' })
  })

  it('validateToolArgs: true coerces boolean strings', async () => {
    const { tool, invokeFn } = mockToolWithSchema(
      'toggle',
      {
        type: 'object',
        properties: { enabled: { type: 'boolean' } },
      },
    )

    const model = createMockModel([
      aiWithToolCalls([{ name: 'toggle', args: { enabled: 'true' } }]),
      new AIMessage('done'),
    ])

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, validateToolArgs: true },
    )

    const calledWith = invokeFn.mock.calls[0]![0] as Record<string, unknown>
    expect(calledWith.enabled).toBe(true)
  })

  it('validateToolArgs: true wraps single value in array when schema expects array', async () => {
    const { tool, invokeFn } = mockToolWithSchema(
      'batch',
      {
        type: 'object',
        properties: { items: { type: 'array' } },
      },
    )

    const model = createMockModel([
      aiWithToolCalls([{ name: 'batch', args: { items: 'single-item' } }]),
      new AIMessage('done'),
    ])

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, validateToolArgs: true },
    )

    const calledWith = invokeFn.mock.calls[0]![0] as Record<string, unknown>
    expect(calledWith.items).toEqual(['single-item'])
  })
})

// ==========================================================================
// Tool stats tracker hint injection
// ==========================================================================

describe('toolStatsTracker hint injection', () => {
  it('injects tool stats hint as SystemMessage before LLM invocation', async () => {
    const { tool } = mockTool('read', 'ok')
    const capturedMessages: BaseMessage[][] = []

    const tracker = {
      formatAsPromptHint: vi.fn((_limit?: number, _intent?: string) =>
        'read: 10 calls, avg 50ms\nwrite: 5 calls, avg 100ms',
      ),
    }

    const model = {
      invoke: vi.fn(async (msgs: BaseMessage[]) => {
        capturedMessages.push([...msgs])
        if (capturedMessages.length === 1) {
          return aiWithToolCalls([{ name: 'read', args: {} }])
        }
        return new AIMessage('done')
      }),
    } as unknown as BaseChatModel

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, toolStatsTracker: tracker },
    )

    // tracker should have been called before each LLM invocation
    expect(tracker.formatAsPromptHint).toHaveBeenCalledTimes(2)
    expect(tracker.formatAsPromptHint).toHaveBeenCalledWith(5, undefined)

    // The hint should appear in messages sent to the model
    const firstCallMsgs = capturedMessages[0]!
    const hintMsg = firstCallMsgs.find(
      m => m._getType() === 'system' && typeof m.content === 'string' && m.content.includes('Tool performance hint'),
    )
    expect(hintMsg).toBeDefined()
  })

  it('passes intent to formatAsPromptHint when configured', async () => {
    const { tool } = mockTool('read', 'ok')
    const tracker = {
      formatAsPromptHint: vi.fn(() => 'hint text'),
    }

    const model = createMockModel([new AIMessage('done')])

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, toolStatsTracker: tracker, intent: 'code-review' },
    )

    expect(tracker.formatAsPromptHint).toHaveBeenCalledWith(5, 'code-review')
  })

  it('replaces previous hint on subsequent iterations (no duplication)', async () => {
    const { tool } = mockTool('read', 'ok')
    const capturedMessages: BaseMessage[][] = []
    let hintCallCount = 0

    const tracker = {
      formatAsPromptHint: vi.fn(() => {
        hintCallCount++
        return `hint iteration ${hintCallCount}`
      }),
    }

    const model = {
      invoke: vi.fn(async (msgs: BaseMessage[]) => {
        capturedMessages.push([...msgs])
        if (capturedMessages.length <= 2) {
          return aiWithToolCalls([{ name: 'read', args: { n: capturedMessages.length } }])
        }
        return new AIMessage('done')
      }),
    } as unknown as BaseChatModel

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, toolStatsTracker: tracker },
    )

    // On third LLM call, there should be exactly one hint message (the latest)
    const thirdCallMsgs = capturedMessages[2]!
    const hintMsgs = thirdCallMsgs.filter(
      m => m._getType() === 'system' && typeof m.content === 'string' && m.content.includes('Tool performance hint'),
    )
    expect(hintMsgs).toHaveLength(1)
    expect(typeof hintMsgs[0]!.content === 'string' && hintMsgs[0]!.content).toContain('hint iteration 3')
  })

  it('does not inject hint when formatAsPromptHint returns empty string', async () => {
    const { tool } = mockTool('read', 'ok')
    const capturedMessages: BaseMessage[][] = []

    const tracker = {
      formatAsPromptHint: vi.fn(() => ''),
    }

    const model = {
      invoke: vi.fn(async (msgs: BaseMessage[]) => {
        capturedMessages.push([...msgs])
        return new AIMessage('done')
      }),
    } as unknown as BaseChatModel

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, toolStatsTracker: tracker },
    )

    const firstCallMsgs = capturedMessages[0]!
    const hintMsgs = firstCallMsgs.filter(
      m => m._getType() === 'system' && typeof m.content === 'string' && m.content.includes('Tool performance hint'),
    )
    expect(hintMsgs).toHaveLength(0)
  })
})

// ==========================================================================
// Iteration limit stop reason
// ==========================================================================

describe('Iteration limit', () => {
  it('returns iteration_limit when maxIterations reached', async () => {
    const { tool } = mockTool('step', 'ok')

    // Model always returns tool calls, never a final answer
    const model = {
      invoke: vi.fn(async () => aiWithToolCalls([{ name: 'step', args: {} }])),
    } as unknown as BaseChatModel

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 3 },
    )

    expect(result.stopReason).toBe('iteration_limit')
    expect(result.hitIterationLimit).toBe(true)
    expect(result.llmCalls).toBe(3)
  })

  it('hitIterationLimit is false when loop completes normally', async () => {
    const { tool } = mockTool('step', 'ok')

    const model = createMockModel([
      aiWithToolCalls([{ name: 'step', args: {} }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10 },
    )

    expect(result.stopReason).toBe('complete')
    expect(result.hitIterationLimit).toBe(false)
  })
})

// ==========================================================================
// StuckError construction with escalation levels
// ==========================================================================

describe('StuckError construction', () => {
  it('escalationLevel 1 maps to tool_blocked', () => {
    const err = new StuckError({
      reason: 'Repeated calls',
      repeatedTool: 'read',
      escalationLevel: 1,
    })
    expect(err.escalationLevel).toBe(1)
    expect(err.recoveryAction).toBe('tool_blocked')
    expect(err.repeatedTool).toBe('read')
    expect(err.reason).toBe('Repeated calls')
    expect(err.name).toBe('StuckError')
    expect(err).toBeInstanceOf(Error)
  })

  it('escalationLevel 2 maps to nudge_injected', () => {
    const err = new StuckError({
      reason: 'Still stuck',
      repeatedTool: 'write',
      escalationLevel: 2,
    })
    expect(err.escalationLevel).toBe(2)
    expect(err.recoveryAction).toBe('nudge_injected')
  })

  it('escalationLevel 3 maps to loop_aborted', () => {
    const err = new StuckError({
      reason: 'No progress',
      escalationLevel: 3,
    })
    expect(err.escalationLevel).toBe(3)
    expect(err.recoveryAction).toBe('loop_aborted')
    expect(err.repeatedTool).toBeUndefined()
  })

  it('defaults to escalationLevel 3 when not provided', () => {
    const err = new StuckError({ reason: 'stuck' })
    expect(err.escalationLevel).toBe(3)
    expect(err.recoveryAction).toBe('loop_aborted')
  })

  it('message includes tool name when repeatedTool is provided', () => {
    const err = new StuckError({
      reason: 'looping',
      repeatedTool: 'fetch',
    })
    expect(err.message).toContain('fetch')
    expect(err.message).toContain('stuck')
  })

  it('message does not include tool name when repeatedTool is undefined', () => {
    const err = new StuckError({ reason: 'idle' })
    expect(err.message).toContain('stuck')
    expect(err.message).toContain('idle')
    expect(err.message).not.toContain('on tool')
  })
})

// ==========================================================================
// Stuck detection idle iteration path (via stuckDetector.recordIteration)
// ==========================================================================

describe('Stuck detection via idle iterations', () => {
  it('detects idle iterations when stuckDetector is provided', async () => {
    // maxIdleIterations=2: stuck after 2 iterations with no tool calls
    // But tool loop only calls recordIteration after tool calls, passing toolCalls.length.
    // We need the model to return tool calls that do get processed, but then
    // recordIteration sees them... Actually, recordIteration is called with
    // toolCalls.length which is > 0 since tool_calls existed.
    // To test idle detection, we need recordIteration to see 0 tool calls,
    // but tool_calls must be empty for that... which would cause the loop to break normally.
    //
    // The stuckDetector.recordIteration is called with `toolCalls.length` which is always > 0
    // at that point (since we checked toolCalls.length > 0 above). So idle detection via
    // recordIteration only fires when toolCalls.length is passed as 0 which can't happen
    // in the current code path. Let's test with a custom stuckDetector mock instead.

    const onStuckDetected = vi.fn()
    const { tool } = mockTool('work', 'ok')

    // Custom detector that returns stuck on second recordIteration call
    let iterCount = 0
    const detector: InstanceType<typeof StuckDetector> = {
      recordToolCall: vi.fn(() => ({ stuck: false })),
      recordError: vi.fn(() => ({ stuck: false })),
      recordIteration: vi.fn((_count: number) => {
        iterCount++
        if (iterCount >= 2) {
          return { stuck: true, reason: 'No progress detected' }
        }
        return { stuck: false }
      }),
      reset: vi.fn(),
    } as unknown as InstanceType<typeof StuckDetector>

    const model = createMockModel([
      aiWithToolCalls([{ name: 'work', args: { n: 1 } }]),
      aiWithToolCalls([{ name: 'work', args: { n: 2 } }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      {
        maxIterations: 10,
        stuckDetector: detector,
        onStuckDetected,
      },
    )

    expect(result.stopReason).toBe('stuck')
    expect(onStuckDetected).toHaveBeenCalledWith(
      'No progress detected',
      'Stopping due to idle iterations.',
    )
    expect(result.stuckError).toBeDefined()
    expect(result.stuckError!.reason).toBe('No progress detected')
  })
})

// ==========================================================================
// invokeModel custom function
// ==========================================================================

describe('invokeModel override', () => {
  it('uses custom invokeModel when provided', async () => {
    const { tool } = mockTool('ping', 'pong')
    const customInvoke = vi.fn(async (_model: BaseChatModel, _msgs: BaseMessage[]) => {
      return new AIMessage('custom response')
    })

    const model = createMockModel([new AIMessage('should not be called')])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 5, invokeModel: customInvoke },
    )

    expect(customInvoke).toHaveBeenCalledTimes(1)
    // model.invoke should NOT have been called
    expect((model.invoke as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect(result.stopReason).toBe('complete')
  })
})

// ==========================================================================
// onUsage callback
// ==========================================================================

describe('onUsage callback', () => {
  it('fires onUsage with token usage after each LLM call', async () => {
    const { tool } = mockTool('step', 'ok')
    const usages: Array<{ inputTokens: number; outputTokens: number }> = []

    const model = createMockModel(
      [
        aiWithToolCalls([{ name: 'step', args: {} }]),
        new AIMessage('done'),
      ],
      { inputTokens: 100, outputTokens: 50 },
    )

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      {
        maxIterations: 10,
        onUsage: (usage) => usages.push(usage),
      },
    )

    expect(usages).toHaveLength(2) // called for each LLM invocation
    expect(result.totalInputTokens).toBe(200)
    expect(result.totalOutputTokens).toBe(100)
  })
})

// ==========================================================================
// Tool stats accumulation
// ==========================================================================

describe('Tool stats accumulation (sequential)', () => {
  it('accumulates calls, errors, and computes avgMs', async () => {
    const { tool: good } = mockTool('calc', 'ok')
    const bad = failingTool('calc_fail', 'err')

    const model = createMockModel([
      aiWithToolCalls([{ name: 'calc', args: { n: 1 } }]),
      aiWithToolCalls([{ name: 'calc', args: { n: 2 } }]),
      aiWithToolCalls([{ name: 'calc_fail', args: {} }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [good, bad],
      { maxIterations: 10 },
    )

    const calcStat = result.toolStats.find(s => s.name === 'calc')
    expect(calcStat).toBeDefined()
    expect(calcStat!.calls).toBe(2)
    expect(calcStat!.errors).toBe(0)
    expect(calcStat!.avgMs).toBeGreaterThanOrEqual(0)

    const failStat = result.toolStats.find(s => s.name === 'calc_fail')
    expect(failStat).toBeDefined()
    expect(failStat!.calls).toBe(1)
    expect(failStat!.errors).toBe(1)
  })

  it('toolStats is empty when no tools are called', async () => {
    const model = createMockModel([new AIMessage('No tools needed')])

    const result = await runToolLoop(
      model,
      [new HumanMessage('hello')],
      [],
      { maxIterations: 10 },
    )

    expect(result.toolStats).toHaveLength(0)
    expect(result.llmCalls).toBe(1)
    expect(result.stopReason).toBe('complete')
  })
})

// ==========================================================================
// Stuck error from repeated errors (stuckBreak path)
// ==========================================================================

describe('Stuck from repeated errors', () => {
  it('stops with stuck when stuckDetector detects repeated errors', async () => {
    const detector = new StuckDetector({ maxErrorsInWindow: 2, errorWindowMs: 60_000 })
    const bad = failingTool('flaky', 'always fails')
    const onStuckDetected = vi.fn()

    const model = createMockModel([
      aiWithToolCalls([{ name: 'flaky', args: {} }]),
      aiWithToolCalls([{ name: 'flaky', args: {} }]),
      new AIMessage('should not reach'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [bad],
      {
        maxIterations: 10,
        stuckDetector: detector,
        onStuckDetected,
      },
    )

    expect(result.stopReason).toBe('stuck')
    expect(onStuckDetected).toHaveBeenCalled()
    expect(result.stuckError).toBeDefined()
  })
})

// ==========================================================================
// Edge cases
// ==========================================================================

describe('Edge cases', () => {
  it('handles empty tool list gracefully when model returns no tool calls', async () => {
    const model = createMockModel([new AIMessage('Just text')])

    const result = await runToolLoop(
      model,
      [new HumanMessage('hi')],
      [],
      { maxIterations: 10 },
    )

    expect(result.stopReason).toBe('complete')
    expect(result.llmCalls).toBe(1)
  })

  it('maxIterations: 1 with tool call returns iteration_limit', async () => {
    const { tool } = mockTool('step', 'ok')

    const model = createMockModel([
      aiWithToolCalls([{ name: 'step', args: {} }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 1 },
    )

    // One iteration: LLM returns tool call, tool executes, but iteration === maxIterations - 1
    expect(result.stopReason).toBe('iteration_limit')
    expect(result.llmCalls).toBe(1)
  })

  it('preserves initial messages in result', async () => {
    const systemMsg = new SystemMessage('You are helpful')
    const humanMsg = new HumanMessage('Do something')

    const model = createMockModel([new AIMessage('OK')])

    const result = await runToolLoop(
      model,
      [systemMsg, humanMsg],
      [],
      { maxIterations: 10 },
    )

    expect(result.messages[0]!._getType()).toBe('system')
    expect(result.messages[1]!._getType()).toBe('human')
    expect(result.messages[2]!._getType()).toBe('ai')
  })

  it('single tool call uses sequential path even with parallelTools: true', async () => {
    // This is tested in parallel suite but worth verifying the boundary condition
    const { tool, invokeFn } = mockTool('solo', 'result')

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

    expect(invokeFn).toHaveBeenCalledTimes(1)
    expect(result.stopReason).toBe('complete')
  })
})
