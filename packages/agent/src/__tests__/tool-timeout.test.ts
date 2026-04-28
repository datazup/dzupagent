/**
 * Per-tool timeout enforcement tests (GA-02, RF-GA01).
 *
 * Verifies that {@link ToolLoopConfig.toolTimeouts} aborts slow tools in
 * both the sequential and parallel execution paths. A tool configured
 * with a 100ms timeout must fail within ~110ms regardless of its
 * underlying duration.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { runToolLoop } from '../agent/tool-loop.js'
import {
  invokeWithOptionalTimeout,
  statusFromError,
} from '../agent/tool-lifecycle-policy.js'
import { ToolTimeoutError } from '../agent/tool-timeout-error.js'

/** Tool that sleeps `delayMs` before resolving with `result`. */
function slowTool(name: string, delayMs: number, result = 'ok'): StructuredToolInterface {
  return {
    name,
    description: `Slow ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async (_args: Record<string, unknown>) => {
      await new Promise(resolve => setTimeout(resolve, delayMs))
      return result
    }),
  } as unknown as StructuredToolInterface
}

/** Tool that resolves immediately with `result`. */
function fastTool(name: string, result = 'ok'): StructuredToolInterface {
  return {
    name,
    description: `Fast ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async (_args: Record<string, unknown>) => result),
  } as unknown as StructuredToolInterface
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

/** Mock model returning scripted responses. */
function createMockModel(responses: AIMessage[]): BaseChatModel {
  let idx = 0
  return {
    invoke: vi.fn(async (_msgs: BaseMessage[]) => {
      const resp = responses[idx] ?? new AIMessage('done')
      idx++
      return resp
    }),
  } as unknown as BaseChatModel
}

describe('ToolLoopConfig.toolTimeouts (sequential path)', () => {
  it('aborts a tool call exceeding its per-tool timeout', async () => {
    const slow = slowTool('slowTool', 500)
    const model = createMockModel([
      aiWithToolCalls([{ name: 'slowTool', args: { q: 'x' } }]),
      new AIMessage('Handled the timeout'),
    ])

    const start = Date.now()
    const result = await runToolLoop(
      model,
      [new HumanMessage('do it')],
      [slow],
      {
        maxIterations: 5,
        toolTimeouts: { slowTool: 100 },
      },
    )
    const elapsed = Date.now() - start

    // Must reject within ~110ms (small margin for scheduler jitter).
    expect(elapsed).toBeLessThan(300)

    // The timed-out tool message should surface the timeout error.
    const toolMsg = result.messages.find(
      m => m._getType() === 'tool'
        && typeof m.content === 'string'
        && m.content.includes('timed out after 100ms'),
    )
    expect(toolMsg).toBeDefined()
    expect(typeof toolMsg?.content === 'string' ? toolMsg.content : '').toContain('slowTool')
  })

  it('does not interfere with tools that complete before the timeout', async () => {
    const fast = fastTool('fastTool', 'quick-result')
    const model = createMockModel([
      aiWithToolCalls([{ name: 'fastTool', args: {} }]),
      new AIMessage('Done'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('run')],
      [fast],
      {
        maxIterations: 5,
        toolTimeouts: { fastTool: 1000 },
      },
    )

    expect(result.stopReason).toBe('complete')
    const toolMsg = result.messages.find(
      m => m._getType() === 'tool' && m.content === 'quick-result',
    )
    expect(toolMsg).toBeDefined()
  })

  it('leaves tools without an entry in toolTimeouts unbounded', async () => {
    // A 150ms tool with no timeout must succeed even when other
    // tools have short timeouts configured.
    const untimed = slowTool('untimed', 150, 'finished')
    const model = createMockModel([
      aiWithToolCalls([{ name: 'untimed', args: {} }]),
      new AIMessage('ok'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('run')],
      [untimed],
      {
        maxIterations: 5,
        // Only another tool has a timeout; `untimed` is unconfigured.
        toolTimeouts: { somethingElse: 50 },
      },
    )

    expect(result.stopReason).toBe('complete')
    const toolMsg = result.messages.find(
      m => m._getType() === 'tool' && m.content === 'finished',
    )
    expect(toolMsg).toBeDefined()
  })
})

describe('ToolLoopConfig.toolTimeouts (parallel path)', () => {
  it('aborts a slow tool via timeout while fast siblings succeed', async () => {
    const slow = slowTool('slowTool', 500)
    const fast = fastTool('fastTool', 'fast-result')
    const model = createMockModel([
      aiWithToolCalls([
        { name: 'slowTool', args: {} },
        { name: 'fastTool', args: {} },
      ]),
      new AIMessage('Done'),
    ])

    const start = Date.now()
    const result = await runToolLoop(
      model,
      [new HumanMessage('run both')],
      [slow, fast],
      {
        maxIterations: 5,
        parallelTools: true,
        maxParallelTools: 5,
        toolTimeouts: { slowTool: 100 },
      },
    )
    const elapsed = Date.now() - start

    // Parallel: the fast tool completes immediately and the slow tool
    // times out at ~100ms, so overall runtime stays comfortably below
    // the 500ms slow-tool delay.
    expect(elapsed).toBeLessThan(400)

    const slowMsg = result.messages.find(
      m => m._getType() === 'tool'
        && typeof m.content === 'string'
        && m.content.includes('timed out after 100ms'),
    )
    expect(slowMsg).toBeDefined()

    const fastMsg = result.messages.find(
      m => m._getType() === 'tool' && m.content === 'fast-result',
    )
    expect(fastMsg).toBeDefined()
  })
})

describe('typed tool timeout classification', () => {
  it('rejects per-tool deadline races with ToolTimeoutError metadata', async () => {
    await expect(
      invokeWithOptionalTimeout(
        'slowTool',
        5,
        async () => new Promise<string>(() => {}),
      ),
    ).rejects.toMatchObject({
      name: 'ToolTimeoutError',
      code: 'TOOL_TIMEOUT',
      toolName: 'slowTool',
      timeoutMs: 5,
      message: 'Tool "slowTool" timed out after 5ms',
    })

    try {
      await invokeWithOptionalTimeout(
        'slowTool',
        5,
        async () => new Promise<string>(() => {}),
      )
      throw new Error('expected timeout')
    } catch (err) {
      expect(err).toBeInstanceOf(ToolTimeoutError)
      expect(statusFromError(err)).toBe('timeout')
    }
  })

  it('does not classify timeout-looking user errors as lifecycle timeouts', () => {
    const misleadingError = new Error(
      'upstream returned text: Tool "slowTool" timed out after 5ms',
    )

    expect(statusFromError(misleadingError)).toBe('error')
  })
})
