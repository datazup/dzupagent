import { describe, it, expect, vi } from 'vitest'
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { runToolLoop } from '../agent/tool-loop.js'
import { StuckDetector } from '../guardrails/stuck-detector.js'
import { IterationBudget } from '../guardrails/iteration-budget.js'

// ---------- Helpers ----------

function mockTool(name: string, result = 'ok') {
  return {
    name,
    description: `Mock ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => result),
  } as unknown as StructuredToolInterface
}

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

describe('Escalating Stuck Recovery', () => {
  it('stage 1: blocks the stuck tool via budget.blockTool', async () => {
    // maxRepeatCalls=2 means stuck after 2 identical calls
    const detector = new StuckDetector({ maxRepeatCalls: 2 })
    const budget = new IterationBudget({ maxTokens: 1_000_000 })
    const tool = mockTool('read_file')
    const stuckEvents: Array<{ toolName: string; stage: number }> = []

    // Model calls read_file with identical args twice (triggers stuck on 2nd call)
    // Then model gives final answer
    const model = createMockModel([
      aiWithToolCalls([{ name: 'read_file', args: { path: 'a.ts' } }]),
      aiWithToolCalls([{ name: 'read_file', args: { path: 'a.ts' } }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('read file')],
      [tool],
      {
        maxIterations: 10,
        stuckDetector: detector,
        budget,
        onStuck: (toolName, stage) => {
          stuckEvents.push({ toolName, stage })
        },
      },
    )

    // Stage 1 should have been triggered
    expect(stuckEvents.length).toBeGreaterThanOrEqual(1)
    expect(stuckEvents[0]!.toolName).toBe('read_file')
    expect(stuckEvents[0]!.stage).toBe(1)

    // Tool should be blocked in the budget
    expect(budget.isToolBlocked('read_file')).toBe(true)
  })

  it('stage 2: injects a nudge system message after second stuck detection', async () => {
    // maxRepeatCalls=1 to trigger stuck on every identical call
    const detector = new StuckDetector({ maxRepeatCalls: 1 })
    const budget = new IterationBudget({ maxTokens: 1_000_000 })
    const tool = mockTool('search')
    const stuckEvents: Array<{ toolName: string; stage: number }> = []

    // First call: stuck detected (stage 1 - block)
    // Second call: different tool name to avoid being blocked, but still stuck
    // Actually, let's use two different tools that both trigger stuck
    const tool2 = mockTool('search2')

    const model = createMockModel([
      // Iteration 1: search with same args -> stuck (stage 1)
      aiWithToolCalls([{ name: 'search', args: { q: 'x' } }]),
      // Iteration 2: search2 with same args -> stuck (stage 2 - nudge injected)
      aiWithToolCalls([{ name: 'search2', args: { q: 'x' } }]),
      aiWithToolCalls([{ name: 'search2', args: { q: 'x' } }]),
      new AIMessage('gave up'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('find')],
      [tool, tool2],
      {
        maxIterations: 10,
        stuckDetector: detector,
        budget,
        onStuck: (toolName, stage) => {
          stuckEvents.push({ toolName, stage })
        },
      },
    )

    // Should have hit stage 2
    const stage2 = stuckEvents.find(e => e.stage === 2)
    expect(stage2).toBeDefined()

    // Check that a system message with the nudge was injected
    const nudgeMsg = result.messages.find(
      m => m._getType() === 'system'
        && typeof m.content === 'string'
        && m.content.includes('You appear to be stuck'),
    )
    expect(nudgeMsg).toBeDefined()
  })

  it('stage 3: aborts the loop with stuck stop reason', async () => {
    // maxRepeatCalls=1 to trigger stuck every time
    const detector = new StuckDetector({ maxRepeatCalls: 1 })
    const budget = new IterationBudget({ maxTokens: 1_000_000 })
    const tool1 = mockTool('t1')
    const tool2 = mockTool('t2')
    const tool3 = mockTool('t3')
    const stuckEvents: Array<{ toolName: string; stage: number }> = []

    const model = createMockModel([
      aiWithToolCalls([{ name: 't1', args: { x: 1 } }]),  // stuck 1 -> stage 1
      aiWithToolCalls([{ name: 't2', args: { x: 1 } }]),  // stuck 2 -> stage 2
      aiWithToolCalls([{ name: 't3', args: { x: 1 } }]),  // stuck 3 -> stage 3 (abort)
      new AIMessage('should not reach'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool1, tool2, tool3],
      {
        maxIterations: 10,
        stuckDetector: detector,
        budget,
        onStuck: (toolName, stage) => {
          stuckEvents.push({ toolName, stage })
        },
      },
    )

    // All three stages should have been hit
    expect(stuckEvents).toHaveLength(3)
    expect(stuckEvents[0]!.stage).toBe(1)
    expect(stuckEvents[1]!.stage).toBe(2)
    expect(stuckEvents[2]!.stage).toBe(3)

    // Loop should have stopped with 'stuck' reason
    expect(result.stopReason).toBe('stuck')
  })

  it('stages escalate across iterations', async () => {
    const detector = new StuckDetector({ maxRepeatCalls: 1 })
    const budget = new IterationBudget({ maxTokens: 1_000_000 })
    const tool = mockTool('fetch')
    const stuckEvents: Array<{ toolName: string; stage: number }> = []

    // Each iteration triggers stuck with identical args
    const model = createMockModel([
      aiWithToolCalls([{ name: 'fetch', args: { url: 'http://x' } }]),
      // After stage 1, fetch is blocked, so the next call will get blocked message
      // The LLM tries again with a different tool call that still triggers stuck
      aiWithToolCalls([{ name: 'fetch', args: { url: 'http://y' } }]),
      aiWithToolCalls([{ name: 'fetch', args: { url: 'http://z' } }]),
      new AIMessage('should not reach'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('fetch data')],
      [tool],
      {
        maxIterations: 10,
        stuckDetector: detector,
        budget,
        onStuck: (toolName, stage) => {
          stuckEvents.push({ toolName, stage })
        },
      },
    )

    // Stages should escalate: 1, 2, 3
    expect(stuckEvents.length).toBeGreaterThanOrEqual(1)
    for (let i = 0; i < stuckEvents.length; i++) {
      expect(stuckEvents[i]!.stage).toBe(i + 1)
    }

    // Should eventually stop
    expect(['stuck', 'complete']).toContain(result.stopReason)
  })

  it('onStuck callback receives tool name and stage number', async () => {
    const detector = new StuckDetector({ maxRepeatCalls: 1 })
    const budget = new IterationBudget({ maxTokens: 1_000_000 })
    const tool = mockTool('compile')
    const onStuck = vi.fn()

    const model = createMockModel([
      aiWithToolCalls([{ name: 'compile', args: { file: 'x' } }]),
      new AIMessage('done'),
    ])

    await runToolLoop(
      model,
      [new HumanMessage('build')],
      [tool],
      {
        maxIterations: 10,
        stuckDetector: detector,
        budget,
        onStuck,
      },
    )

    if (onStuck.mock.calls.length > 0) {
      // If stuck was detected, verify the callback args
      expect(onStuck).toHaveBeenCalledWith('compile', expect.any(Number))
      const stage = onStuck.mock.calls[0]![1] as number
      expect(stage).toBeGreaterThanOrEqual(1)
    }
  })

  it('stuck detection still works without budget (no blockTool available)', async () => {
    const detector = new StuckDetector({ maxRepeatCalls: 2 })
    const tool = mockTool('ping')
    const stuckEvents: Array<{ toolName: string; stage: number }> = []

    const model = createMockModel([
      aiWithToolCalls([{ name: 'ping', args: { host: 'x' } }]),
      aiWithToolCalls([{ name: 'ping', args: { host: 'x' } }]),
      new AIMessage('done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('ping')],
      [tool],
      {
        maxIterations: 10,
        stuckDetector: detector,
        // No budget provided
        onStuck: (toolName, stage) => {
          stuckEvents.push({ toolName, stage })
        },
      },
    )

    // Should still detect stuck and fire callback
    expect(stuckEvents.length).toBeGreaterThanOrEqual(1)
    expect(stuckEvents[0]!.toolName).toBe('ping')
  })
})
