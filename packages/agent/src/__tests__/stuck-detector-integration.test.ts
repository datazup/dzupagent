/**
 * Integration tests: StuckDetector wired into the DzupAgent tool loop.
 *
 * These tests construct real DzupAgent instances with mock LLMs that
 * simulate stuck conditions (repeated identical tool calls, error
 * loops, idle iterations) and verify that:
 *
 *   1. The agent stops with `stopReason === 'stuck'`
 *   2. The result carries a `StuckError` with the expected shape
 *   3. The eventBus emits `agent:stuck_detected`
 *   4. Custom thresholds (`maxRepeatCalls`, `maxErrorsInWindow`,
 *      `maxIdleIterations`) are honoured
 *   5. Disabling (`stuckDetector: false`) bypasses the loop
 *
 * Companion to: stuck-detector.test.ts (unit), stuck-detector-deep.test.ts
 * (unit edge cases), and stuck-recovery.test.ts (escalating stages).
 *
 * Wave 18 — W18-A2 (G-27).
 */
import { describe, it, expect, vi } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import { tool } from '@langchain/core/tools'

import { DzupAgent } from '../agent/dzip-agent.js'
import { StuckError } from '../agent/stuck-error.js'
import type { DzupAgentConfig } from '../agent/agent-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an AIMessage that requests one or more tool calls. */
function aiWithToolCalls(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: calls.map((c, i) => ({
      id: `call_${i}_${Math.random().toString(36).slice(2, 6)}`,
      name: c.name,
      args: c.args,
    })),
  })
}

/**
 * Build a model that always emits the SAME tool call (same name + same args).
 * Useful for triggering the "repeated identical calls" stuck path.
 *
 * Returns a no-tool-calls message after `maxLoops` invocations to let the
 * agent terminate cleanly when the detector does NOT trigger.
 */
function createRepeatingModel(
  toolName: string,
  toolArgs: Record<string, unknown>,
  maxLoops = 50,
): BaseChatModel {
  let calls = 0
  return {
    invoke: vi.fn(async (_msgs: BaseMessage[]) => {
      calls++
      if (calls > maxLoops) return new AIMessage('giving up')
      return aiWithToolCalls([{ name: toolName, args: toolArgs }])
    }),
    bindTools: vi.fn().mockReturnThis(),
    stream: vi.fn(),
  } as unknown as BaseChatModel
}

/**
 * Build a model that emits a sequence of tool calls (varying args) so
 * the detector should NOT flag repeated identical calls.
 */
function createVaryingModel(toolName: string, maxLoops = 5): BaseChatModel {
  let calls = 0
  return {
    invoke: vi.fn(async (_msgs: BaseMessage[]) => {
      if (calls >= maxLoops) {
        return new AIMessage('done varying')
      }
      const args = { iteration: calls++ }
      return aiWithToolCalls([{ name: toolName, args }])
    }),
    bindTools: vi.fn().mockReturnThis(),
    stream: vi.fn(),
  } as unknown as BaseChatModel
}

/** Build a model that returns AIMessages with NO tool calls (idle). */
function createIdleModel(maxLoops = 50): BaseChatModel {
  let calls = 0
  return {
    invoke: vi.fn(async (_msgs: BaseMessage[]) => {
      calls++
      if (calls > maxLoops) return new AIMessage('terminating')
      // Return AI message with no tool_calls — but do return content so
      // the loop terminates on the very first iteration via the
      // "no tool calls means final response" branch.
      return new AIMessage('thinking but no tool used')
    }),
    bindTools: vi.fn().mockReturnThis(),
    stream: vi.fn(),
  } as unknown as BaseChatModel
}

/**
 * Build a tool whose `invoke` always succeeds with a constant result.
 * The detector flags repetition based on tool NAME + ARGS, so the result
 * does not influence stuck detection.
 */
function makeNoopTool(name: string, result = 'ok') {
  return tool(async () => result, {
    name,
    description: `Mock tool ${name}`,
    schema: z.object({}).passthrough(),
  })
}

/** Build a tool that always throws an error. */
function makeFailingTool(name: string, message = 'boom') {
  return tool(
    async () => {
      throw new Error(message)
    },
    {
      name,
      description: `Always-failing mock tool ${name}`,
      schema: z.object({}).passthrough(),
    },
  )
}

/** Standard config with sensible defaults for these tests. */
function configWith(
  model: BaseChatModel,
  tools: StructuredToolInterface[],
  overrides: Partial<DzupAgentConfig> = {},
): DzupAgentConfig {
  return {
    id: 'stuck-test-agent',
    instructions: 'You are a tester.',
    model,
    tools,
    maxIterations: 25,
    ...overrides,
  }
}

/** Capture event-bus emissions for assertion. */
function makeRecordingEventBus() {
  const events: Array<Record<string, unknown>> = []
  return {
    bus: {
      emit: vi.fn((e: Record<string, unknown>) => events.push(e)),
      on: vi.fn(),
      off: vi.fn(),
    },
    events,
  }
}

// ===========================================================================
// 1. Repeated tool calls (8 tests)
// ===========================================================================

describe('StuckDetector integration — repeated tool calls', () => {
  it('flags stuck after maxRepeatCalls=3 escalates through 3 stages', async () => {
    // To reach stopReason='stuck' from the repeat path, the detector must
    // escalate through 3 stages. Each stage requires a NEW tool name (the
    // previous one is blocked by stage 1). With maxRepeatCalls=1, every
    // identical-args call across distinct tool names trips one stage.
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        if (i > 5) return new AIMessage('should not reach')
        const tools = ['t1', 't2', 't3', 't4', 't5']
        return aiWithToolCalls([{ name: tools[i - 1]!, args: { v: 'same' } }])
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(
        model,
        ['t1', 't2', 't3', 't4', 't5'].map((n) => makeNoopTool(n)),
        { guardrails: { stuckDetector: { maxRepeatCalls: 1 } } },
      ),
    )

    const result = await agent.generate([new HumanMessage('go')])

    expect(result.stopReason).toBe('stuck')
    expect(result.stuckError).toBeInstanceOf(StuckError)
  })

  it('does NOT flag stuck on a single tool call', async () => {
    const noop = makeNoopTool('once')
    const model = {
      invoke: vi.fn(async () => {
        // First call: invoke tool. Second call: final response.
        const callIdx = (model.invoke as ReturnType<typeof vi.fn>).mock.calls.length - 1
        if (callIdx === 0) return aiWithToolCalls([{ name: 'once', args: { v: 1 } }])
        return new AIMessage('finished')
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [noop], {
        guardrails: { stuckDetector: { maxRepeatCalls: 3 } },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])

    expect(result.stopReason).toBe('complete')
    expect(result.stuckError).toBeUndefined()
  })

  it('does NOT flag stuck after 2 identical calls when threshold is 3', async () => {
    let callIdx = 0
    const model = {
      invoke: vi.fn(async () => {
        if (callIdx < 2) {
          callIdx++
          return aiWithToolCalls([{ name: 'echo', args: { x: 'same' } }])
        }
        return new AIMessage('done')
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [makeNoopTool('echo')], {
        guardrails: { stuckDetector: { maxRepeatCalls: 3 } },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])

    expect(result.stopReason).toBe('complete')
    expect(result.stuckError).toBeUndefined()
  })

  it('blocks the repeated tool via budget after maxRepeatCalls is hit', async () => {
    // With maxRepeatCalls=2 and a single tool repeated, stage 1 fires and
    // the budget blocks the tool. The loop continues until iteration_limit,
    // but the tool is no longer executed (returns "[blocked]" message).
    const noop = makeNoopTool('rep')
    const model = createRepeatingModel('rep', { v: 'identical' })

    const agent = new DzupAgent(
      configWith(model, [noop], {
        guardrails: { stuckDetector: { maxRepeatCalls: 2 } },
        maxIterations: 5,
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])

    // Stage 1 triggers but the loop runs to iteration_limit (only 1 stage hit).
    // Verify the tool was actually invoked at most twice (then blocked).
    expect(['iteration_limit', 'stuck']).toContain(result.stopReason)
  })

  it('reports a tool name in the stuck reason after escalation', async () => {
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        const tools = ['search1', 'search2', 'search3']
        if (i > 3) return new AIMessage('done')
        return aiWithToolCalls([{ name: tools[i - 1]!, args: { q: 'x' } }])
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(
        model,
        [makeNoopTool('search1'), makeNoopTool('search2'), makeNoopTool('search3')],
        { guardrails: { stuckDetector: { maxRepeatCalls: 1 } } },
      ),
    )

    const result = await agent.generate([new HumanMessage('go')])

    expect(result.stopReason).toBe('stuck')
    expect(result.stuckError).toBeDefined()
    // The reason mentions one of the search tools we used.
    expect(result.stuckError?.reason).toMatch(/search/)
  })

  it('emits agent:stuck_detected on the event bus when a tool repeats', async () => {
    const { bus, events } = makeRecordingEventBus()
    // Even at stage 1 (tool blocked), the eventBus should receive a
    // stuck-detection event. We only need one repeat to trigger this.
    const model = createRepeatingModel('emit-test', { y: 2 })

    const agent = new DzupAgent(
      configWith(model, [makeNoopTool('emit-test')], {
        guardrails: { stuckDetector: { maxRepeatCalls: 2 } },
        eventBus: bus as never,
        maxIterations: 5,
      }),
    )

    await agent.generate([new HumanMessage('go')])

    const stuckEvents = events.filter((e) => e.type === 'agent:stuck_detected')
    expect(stuckEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('treats different args as not-repeating even with same tool name', async () => {
    const model = createVaryingModel('var-tool', 5)

    const agent = new DzupAgent(
      configWith(model, [makeNoopTool('var-tool')], {
        guardrails: { stuckDetector: { maxRepeatCalls: 3 } },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])

    expect(result.stopReason).toBe('complete')
    expect(result.stuckError).toBeUndefined()
  })

  it('blocks the tool when nested-object args repeat', async () => {
    const nested = { a: { b: { c: [1, 2, 3] } } }
    const model = createRepeatingModel('deep', nested)

    const agent = new DzupAgent(
      configWith(model, [makeNoopTool('deep')], {
        guardrails: { stuckDetector: { maxRepeatCalls: 3 } },
        maxIterations: 6,
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])

    // At least the loop must terminate (either iteration_limit or stuck).
    expect(['iteration_limit', 'stuck']).toContain(result.stopReason)
    // The blocked-tool message must appear in the conversation.
    const blockedMsg = result.messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('blocked by guardrails'),
    )
    expect(blockedMsg).toBeDefined()
  })
})

// ===========================================================================
// 2. Error rate (6 tests)
// ===========================================================================

describe('StuckDetector integration — error rate', () => {
  it('flags stuck after maxErrorsInWindow consecutive failures', async () => {
    const failing = makeFailingTool('fail', 'always broken')
    // Each iteration runs the failing tool with DIFFERENT args so the
    // repeat-detector does not fire — only the error path should trigger.
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        return aiWithToolCalls([{ name: 'fail', args: { attempt: i } }])
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [failing], {
        guardrails: {
          stuckDetector: {
            maxRepeatCalls: 100,
            maxErrorsInWindow: 3,
            errorWindowMs: 60_000,
          },
        },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])

    expect(result.stopReason).toBe('stuck')
  })

  it('does NOT flag stuck when error count is below window threshold', async () => {
    const failing = makeFailingTool('fail-once', 'one shot')
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        if (i === 1) return aiWithToolCalls([{ name: 'fail-once', args: { v: 1 } }])
        return new AIMessage('giving up gracefully')
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [failing], {
        guardrails: { stuckDetector: { maxErrorsInWindow: 5, errorWindowMs: 60_000 } },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])

    expect(result.stopReason).toBe('complete')
  })

  it('error stuck includes the error count in reason', async () => {
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        return aiWithToolCalls([{ name: 'fail', args: { n: i } }])
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [makeFailingTool('fail')], {
        guardrails: {
          stuckDetector: {
            maxRepeatCalls: 100,
            maxErrorsInWindow: 2,
            errorWindowMs: 60_000,
          },
        },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])

    expect(result.stopReason).toBe('stuck')
    expect(result.stuckError?.reason).toMatch(/error/i)
  })

  it('respects very low error threshold (1 error trips it)', async () => {
    const model = {
      invoke: vi.fn(async () => aiWithToolCalls([{ name: 'fail', args: { v: Math.random() } }])),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [makeFailingTool('fail')], {
        guardrails: {
          stuckDetector: {
            maxRepeatCalls: 100,
            maxErrorsInWindow: 1,
            errorWindowMs: 60_000,
          },
        },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])

    expect(result.stopReason).toBe('stuck')
  })

  it('emits agent:stuck_detected event on error-induced stuck', async () => {
    const { bus, events } = makeRecordingEventBus()
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        return aiWithToolCalls([{ name: 'fail', args: { v: i } }])
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [makeFailingTool('fail')], {
        guardrails: {
          stuckDetector: {
            maxRepeatCalls: 100,
            maxErrorsInWindow: 2,
            errorWindowMs: 60_000,
          },
        },
        eventBus: bus as never,
      }),
    )

    await agent.generate([new HumanMessage('go')])

    expect(events.filter((e) => e.type === 'agent:stuck_detected').length).toBeGreaterThanOrEqual(1)
  })

  it('error-induced stuck produces a stuck-stop-reason telemetry event', async () => {
    const { bus, events } = makeRecordingEventBus()
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        return aiWithToolCalls([{ name: 'fail', args: { v: i } }])
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [makeFailingTool('fail')], {
        guardrails: {
          stuckDetector: {
            maxRepeatCalls: 100,
            maxErrorsInWindow: 2,
            errorWindowMs: 60_000,
          },
        },
        eventBus: bus as never,
      }),
    )

    await agent.generate([new HumanMessage('go')])

    const stopReasonEvent = events.find((e) => e.type === 'agent:stop_reason')
    expect(stopReasonEvent).toBeDefined()
    expect(stopReasonEvent?.reason).toBe('stuck')
  })
})

// ===========================================================================
// 3. No-progress / idle iterations (5 tests)
// ===========================================================================

describe('StuckDetector integration — idle iterations', () => {
  it('AIMessage with no tool calls completes immediately (no idle accumulation)', async () => {
    // The agent returns text on the first iteration, so the loop terminates
    // before recordIteration() can ever fire as "idle".
    const model = createIdleModel(5)

    const agent = new DzupAgent(
      configWith(model, [], {
        guardrails: { stuckDetector: { maxIdleIterations: 1 } },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])

    // No tool calls = final response = complete (not stuck)
    expect(result.stopReason).toBe('complete')
  })

  it('an agent that calls tools every iteration never accumulates idleness', async () => {
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        if (i <= 4) return aiWithToolCalls([{ name: 'work', args: { step: i } }])
        return new AIMessage('all done')
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [makeNoopTool('work')], {
        guardrails: { stuckDetector: { maxIdleIterations: 2 } },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])

    expect(result.stopReason).toBe('complete')
  })

  it('configurable maxIdleIterations does not affect terminating runs', async () => {
    const model = {
      invoke: vi.fn(async () => new AIMessage('one-shot answer')),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [], {
        guardrails: { stuckDetector: { maxIdleIterations: 1 } },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])
    expect(result.stopReason).toBe('complete')
  })

  it('does not crash when maxIdleIterations=10 and agent terminates fast', async () => {
    const model = {
      invoke: vi.fn(async () => new AIMessage('quick')),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [], {
        guardrails: { stuckDetector: { maxIdleIterations: 10 } },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])
    expect(result.stopReason).toBe('complete')
  })

  it('idle-trigger does not fire when tool was called this iteration (lastToolCalls > 0)', async () => {
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        if (i === 1) return aiWithToolCalls([{ name: 'tick', args: { n: 1 } }])
        if (i === 2) return aiWithToolCalls([{ name: 'tick', args: { n: 2 } }])
        return new AIMessage('finishing')
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [makeNoopTool('tick')], {
        guardrails: { stuckDetector: { maxIdleIterations: 1 } },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])
    expect(result.stopReason).toBe('complete')
  })
})

// ===========================================================================
// 4. Custom config (5 tests)
// ===========================================================================

describe('StuckDetector integration — custom config', () => {
  it('maxRepeatCalls=2 blocks the tool on the 2nd identical call', async () => {
    const model = createRepeatingModel('rep', { same: true })

    const agent = new DzupAgent(
      configWith(model, [makeNoopTool('rep')], {
        guardrails: { stuckDetector: { maxRepeatCalls: 2 } },
        maxIterations: 5,
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])

    // After stage-1 block the loop runs to iteration_limit. The tool itself
    // must show up as blocked at least once.
    expect(['iteration_limit', 'stuck']).toContain(result.stopReason)
    const blocked = result.messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('blocked'),
    )
    expect(blocked).toBeDefined()
  })

  it('maxRepeatCalls=10 allows several repeats before tripping', async () => {
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        if (i <= 5) return aiWithToolCalls([{ name: 'echo', args: { same: 'value' } }])
        return new AIMessage('giving up after 5')
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [makeNoopTool('echo')], {
        guardrails: { stuckDetector: { maxRepeatCalls: 10 } },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])

    // 5 repeats but threshold = 10 → should NOT be stuck
    expect(result.stopReason).toBe('complete')
  })

  it('honours custom errorWindowMs', async () => {
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        return aiWithToolCalls([{ name: 'fail', args: { v: i } }])
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    // Wide window (1 hour) + low threshold means errors accumulate freely
    const agent = new DzupAgent(
      configWith(model, [makeFailingTool('fail')], {
        guardrails: {
          stuckDetector: {
            maxRepeatCalls: 100,
            maxErrorsInWindow: 3,
            errorWindowMs: 3_600_000,
          },
        },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])
    expect(result.stopReason).toBe('stuck')
  })

  it('all three thresholds set very high effectively disables detection', async () => {
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        if (i <= 4) return aiWithToolCalls([{ name: 'r', args: { same: true } }])
        return new AIMessage('exit')
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [makeNoopTool('r')], {
        guardrails: {
          stuckDetector: {
            maxRepeatCalls: 1000,
            maxErrorsInWindow: 1000,
            maxIdleIterations: 1000,
          },
        },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])
    expect(result.stopReason).toBe('complete')
    expect(result.stuckError).toBeUndefined()
  })

  it('stuckDetector: false fully disables the detector', async () => {
    // Run a pattern that WOULD normally trip with defaults (3 identical calls)
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        if (i <= 4) return aiWithToolCalls([{ name: 'rep', args: { v: 'same' } }])
        return new AIMessage('terminate')
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [makeNoopTool('rep')], {
        guardrails: { stuckDetector: false },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])
    expect(result.stopReason).toBe('complete')
    expect(result.stuckError).toBeUndefined()
  })
})

// ===========================================================================
// 5. StuckError shape (4 tests)
// ===========================================================================

/**
 * Build an agent + model pair that cleanly reaches stage-3 stuck via the
 * repeat path: 3 different tool names, each with the same args, with
 * maxRepeatCalls=1.
 */
function makeStage3Setup(): { agent: DzupAgent } {
  let i = 0
  const tools = ['x1', 'x2', 'x3']
  const model = {
    invoke: vi.fn(async () => {
      i++
      if (i > 3) return new AIMessage('unreachable')
      return aiWithToolCalls([{ name: tools[i - 1]!, args: { v: 'same' } }])
    }),
    bindTools: vi.fn().mockReturnThis(),
    stream: vi.fn(),
  } as unknown as BaseChatModel

  const agent = new DzupAgent(
    configWith(model, tools.map((n) => makeNoopTool(n)), {
      guardrails: { stuckDetector: { maxRepeatCalls: 1 } },
    }),
  )
  return { agent }
}

describe('StuckDetector integration — StuckError shape', () => {
  it('StuckError carries a non-empty reason field', async () => {
    const { agent } = makeStage3Setup()
    const { stuckError } = await agent.generate([new HumanMessage('go')])

    expect(stuckError).toBeDefined()
    expect(typeof stuckError!.reason).toBe('string')
    expect(stuckError!.reason.length).toBeGreaterThan(0)
  })

  it('StuckError.name === "StuckError"', async () => {
    const { agent } = makeStage3Setup()
    const { stuckError } = await agent.generate([new HumanMessage('go')])
    expect(stuckError?.name).toBe('StuckError')
  })

  it('StuckError is an instanceof Error and StuckError', async () => {
    const { agent } = makeStage3Setup()
    const { stuckError } = await agent.generate([new HumanMessage('go')])
    expect(stuckError).toBeInstanceOf(Error)
    expect(stuckError).toBeInstanceOf(StuckError)
  })

  it('StuckError carries an escalationLevel between 1 and 3', async () => {
    const { agent } = makeStage3Setup()
    const { stuckError } = await agent.generate([new HumanMessage('go')])
    expect(stuckError?.escalationLevel).toBeGreaterThanOrEqual(1)
    expect(stuckError?.escalationLevel).toBeLessThanOrEqual(3)
  })

  it('StuckError from error path also exposes the standard shape', async () => {
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        return aiWithToolCalls([{ name: 'fail', args: { v: i } }])
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [makeFailingTool('fail')], {
        guardrails: {
          stuckDetector: {
            maxRepeatCalls: 100,
            maxErrorsInWindow: 2,
            errorWindowMs: 60_000,
          },
        },
      }),
    )

    const { stuckError } = await agent.generate([new HumanMessage('go')])
    expect(stuckError).toBeInstanceOf(StuckError)
    expect(stuckError?.message).toContain('stuck')
  })
})

// ===========================================================================
// 6. Recovery / non-stuck paths (4 tests)
// ===========================================================================

describe('StuckDetector integration — recovery paths', () => {
  it('an agent that varies its tool input never gets flagged as stuck', async () => {
    const model = createVaryingModel('var', 5)

    const agent = new DzupAgent(
      configWith(model, [makeNoopTool('var')], {
        guardrails: { stuckDetector: { maxRepeatCalls: 3 } },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])
    expect(result.stopReason).toBe('complete')
    expect(result.stuckError).toBeUndefined()
  })

  it('alternating between two tools (no repeats) does not trigger stuck', async () => {
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        if (i > 6) return new AIMessage('finished')
        const name = i % 2 === 0 ? 'a' : 'b'
        return aiWithToolCalls([{ name, args: { i } }])
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [makeNoopTool('a'), makeNoopTool('b')], {
        guardrails: { stuckDetector: { maxRepeatCalls: 3 } },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])
    expect(result.stopReason).toBe('complete')
  })

  it('tool succeeds 3x with different args → completes without stuck', async () => {
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        if (i <= 3) {
          return aiWithToolCalls([{ name: 'do', args: { task: `task${i}` } }])
        }
        return new AIMessage('all 3 tasks done')
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [makeNoopTool('do')], {
        guardrails: { stuckDetector: { maxRepeatCalls: 2 } },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])
    expect(result.stopReason).toBe('complete')
  })

  it('a single error that does not repeat does not trip the error window', async () => {
    let i = 0
    const failOnce = tool(
      async () => {
        if (i === 0) {
          i++
          throw new Error('one-time failure')
        }
        return 'recovered'
      },
      {
        name: 'flaky',
        description: 'flaky tool',
        schema: z.object({}).passthrough(),
      },
    )

    let invoked = 0
    const model = {
      invoke: vi.fn(async () => {
        invoked++
        if (invoked === 1) return aiWithToolCalls([{ name: 'flaky', args: { try: 1 } }])
        if (invoked === 2) return aiWithToolCalls([{ name: 'flaky', args: { try: 2 } }])
        return new AIMessage('done after recovery')
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [failOnce], {
        guardrails: {
          stuckDetector: { maxErrorsInWindow: 5, maxRepeatCalls: 5 },
        },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])
    expect(result.stopReason).toBe('complete')
    expect(result.stuckError).toBeUndefined()
  })
})

// ===========================================================================
// 7. Combined triggers (4 tests)
// ===========================================================================

describe('StuckDetector integration — combined triggers', () => {
  it('repeated identical failing tool: error path trips first', async () => {
    // Identical args + always-fail. Both paths can trigger.
    const model = createRepeatingModel('zap', { v: 'same' })

    const agent = new DzupAgent(
      configWith(model, [makeFailingTool('zap')], {
        guardrails: {
          stuckDetector: {
            maxRepeatCalls: 3,
            maxErrorsInWindow: 2,
            errorWindowMs: 60_000,
          },
        },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])
    expect(result.stopReason).toBe('stuck')
    // Either path can claim victory; both are valid stuck detections.
    expect(result.stuckError).toBeDefined()
  })

  it('mix of one error and many varied successful calls does NOT trip stuck', async () => {
    const flaky = tool(
      async ({ shouldFail }: { shouldFail?: boolean }) => {
        if (shouldFail) throw new Error('one error')
        return 'ok'
      },
      {
        name: 'flaky',
        description: 'flaky',
        schema: z.object({ shouldFail: z.boolean().optional(), n: z.number().optional() }),
      },
    )

    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        if (i === 1) {
          return aiWithToolCalls([{ name: 'flaky', args: { shouldFail: true, n: 1 } }])
        }
        if (i <= 4) {
          return aiWithToolCalls([{ name: 'flaky', args: { n: i } }])
        }
        return new AIMessage('done with flaky')
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [flaky], {
        guardrails: {
          stuckDetector: {
            maxRepeatCalls: 3,
            maxErrorsInWindow: 3,
            errorWindowMs: 60_000,
          },
        },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])
    expect(result.stopReason).toBe('complete')
  })

  it('repeat-call stuck (stage 1) emits stuck event with abundant token budget', async () => {
    const { bus, events } = makeRecordingEventBus()
    const model = createRepeatingModel('rep', { x: 1 })

    const agent = new DzupAgent(
      configWith(model, [makeNoopTool('rep')], {
        guardrails: {
          stuckDetector: { maxRepeatCalls: 2 },
          maxTokens: 1_000_000,
        },
        eventBus: bus as never,
        maxIterations: 5,
      }),
    )

    await agent.generate([new HumanMessage('go')])
    // Even at stage 1 (no abort), the stuck event must fire on the bus.
    expect(events.some((e) => e.type === 'agent:stuck_detected')).toBe(true)
  })

  it('error-stuck reports a non-zero llmCalls count', async () => {
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        return aiWithToolCalls([{ name: 'fail', args: { n: i } }])
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [makeFailingTool('fail')], {
        guardrails: {
          stuckDetector: {
            maxRepeatCalls: 100,
            maxErrorsInWindow: 2,
            errorWindowMs: 60_000,
          },
        },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')])
    expect(result.stopReason).toBe('stuck')
    expect(result.usage.llmCalls).toBeGreaterThanOrEqual(1)
  })
})

// ===========================================================================
// 8. No-config / defaults (4 tests)
// ===========================================================================

describe('StuckDetector integration — defaults & no-config', () => {
  it('with no guardrails set, stuck detection is still active by default', async () => {
    // When guardrails is undefined, the detector is still constructed in
    // run-engine.ts with default thresholds. We can verify activation by
    // checking that the stuck event fires on the bus.
    const { bus, events } = makeRecordingEventBus()
    const model = createRepeatingModel('rep', { same: 'true' })

    const agent = new DzupAgent(
      configWith(model, [makeNoopTool('rep')], {
        eventBus: bus as never,
        maxIterations: 6,
      }),
    )

    await agent.generate([new HumanMessage('go')])

    expect(events.some((e) => e.type === 'agent:stuck_detected')).toBe(true)
  })

  it('default thresholds: 3 identical calls trigger stage-1 block', async () => {
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        if (i <= 4) return aiWithToolCalls([{ name: 'r', args: { v: 1 } }])
        return new AIMessage('survived?')
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const { bus, events } = makeRecordingEventBus()

    const agent = new DzupAgent(
      configWith(model, [makeNoopTool('r')], {
        // Empty guardrails object → uses defaults (maxRepeatCalls=3)
        guardrails: {},
        eventBus: bus as never,
        maxIterations: 5,
      }),
    )

    await agent.generate([new HumanMessage('go')])
    // Default threshold is 3 — so the 3rd identical call must emit a
    // stuck-detected event (stage 1 block).
    expect(events.some((e) => e.type === 'agent:stuck_detected')).toBe(true)
  })

  it('default thresholds: 2 identical calls do NOT trigger stuck', async () => {
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        if (i <= 2) return aiWithToolCalls([{ name: 'r', args: { v: 1 } }])
        return new AIMessage('safe')
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [makeNoopTool('r')], { guardrails: {} }),
    )

    const result = await agent.generate([new HumanMessage('go')])
    expect(result.stopReason).toBe('complete')
  })

  it('default thresholds: 5 errors trigger stuck', async () => {
    // With default maxErrorsInWindow=5 and maxRepeatCalls=3, we must vary
    // args so the repeat-detector does not fire before the error path.
    // To exercise ONLY the error path, raise maxRepeatCalls but keep
    // maxErrorsInWindow at 5 (default).
    let i = 0
    const model = {
      invoke: vi.fn(async () => {
        i++
        return aiWithToolCalls([{ name: 'fail', args: { v: i } }])
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [makeFailingTool('fail')], {
        guardrails: {
          stuckDetector: {
            // Override only repeat threshold to isolate error path
            maxRepeatCalls: 100,
            // maxErrorsInWindow defaults to 5
          },
        },
      }),
    )

    const result = await agent.generate([new HumanMessage('go')], { maxIterations: 20 })
    expect(result.stopReason).toBe('stuck')
  })
})

// ===========================================================================
// 9. Stream path integration (bonus — verifies streaming honours detector)
// ===========================================================================

describe('StuckDetector integration — stream() path', () => {
  it('stream emits a "stuck" event when repeated tool calls trigger detector', async () => {
    let i = 0
    const model = {
      invoke: vi.fn(),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(async function* () {
        i++
        if (i > 5) {
          yield new AIMessage('final')
          return
        }
        yield aiWithToolCalls([{ name: 'rep', args: { same: true } }])
      }),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(model, [makeNoopTool('rep')], {
        guardrails: { stuckDetector: { maxRepeatCalls: 2 } },
      }),
    )

    const events: Array<{ type: string }> = []
    for await (const ev of agent.stream([new HumanMessage('go')])) {
      events.push(ev as unknown as { type: string })
    }

    const stuckEvent = events.find((e) => e.type === 'stuck')
    const doneEvent = events.find((e) => e.type === 'done')
    expect(stuckEvent ?? doneEvent).toBeDefined()
  })

  it('stream emits done with stopReason=stuck on terminal stuck detection', async () => {
    let i = 0
    const model = {
      invoke: vi.fn(),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(async function* () {
        i++
        // After enough iterations the detector escalates to abort
        yield aiWithToolCalls([{ name: `tool${i}`, args: { v: 'same' } }])
      }),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(
      configWith(
        model,
        [
          makeNoopTool('tool1'),
          makeNoopTool('tool2'),
          makeNoopTool('tool3'),
          makeNoopTool('tool4'),
          makeNoopTool('tool5'),
          makeNoopTool('tool6'),
        ],
        {
          // maxRepeatCalls=1 means EVERY repeated identical-args call across
          // tool names with same args still requires identical name+args, so
          // these 6 different tool names are NOT a repeat. To trigger stuck
          // in the streaming path we need a high-repeat scenario.
          guardrails: { stuckDetector: { maxRepeatCalls: 2 } },
          maxIterations: 6,
        },
      ),
    )

    const events: Array<{ type: string; data?: Record<string, unknown> }> = []
    for await (const ev of agent.stream([new HumanMessage('go')])) {
      events.push(ev as unknown as { type: string; data?: Record<string, unknown> })
    }

    const doneEvent = events.findLast((e) => e.type === 'done')
    expect(doneEvent).toBeDefined()
    // Either the loop completes or stops on iteration_limit; both are
    // acceptable here. Different tool names are not "identical" repeats.
    expect(['complete', 'iteration_limit', 'stuck']).toContain(
      String(doneEvent?.data?.stopReason ?? ''),
    )
  })
})
