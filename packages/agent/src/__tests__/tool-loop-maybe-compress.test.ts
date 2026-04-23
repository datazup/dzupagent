/**
 * Auto-compression integration tests for the default tool loop.
 *
 * Verifies that `ToolLoopConfig.maybeCompress` is invoked after each
 * LLM turn's `onUsage` call, that its result is applied to the working
 * message history when `compressed === true`, and that it is wired so
 * that callers (typically `AgentLoopPlugin.maybeCompress`) can decide
 * internally whether to run the actual compression pipeline based on
 * pressure state.
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
import { runToolLoop } from '../agent/tool-loop.js'
import type { CompressResult } from '@dzupagent/context'

// ---------- Helpers ----------

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

function aiWithToolCalls(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
) {
  const msg = new AIMessage({ content: '' })
  ;(msg as AIMessage & { tool_calls: unknown[] }).tool_calls = calls.map(
    (c, i) => ({ id: `call_${i}`, name: c.name, args: c.args }),
  )
  return msg
}

// ==========================================================================

describe('Tool loop — maybeCompress wiring', () => {
  it('invokes maybeCompress on every LLM turn after onUsage', async () => {
    const { tool } = mockTool('echo', 'hi')
    const onUsage = vi.fn()
    const maybeCompress = vi.fn(
      async (messages: BaseMessage[]): Promise<CompressResult> => ({
        messages,
        summary: null,
        compressed: false,
      }),
    )

    const model = createMockModel([
      aiWithToolCalls([{ name: 'echo', args: { x: 1 } }]),
      new AIMessage('final'),
    ])

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 5, onUsage, maybeCompress },
    )

    // Two LLM turns → maybeCompress invoked twice
    expect(maybeCompress).toHaveBeenCalledTimes(2)
    // Called AFTER onUsage on each turn
    const usageCalls = onUsage.mock.invocationCallOrder
    const compressCalls = maybeCompress.mock.invocationCallOrder
    expect(usageCalls[0]).toBeLessThan(compressCalls[0]!)
    expect(usageCalls[1]).toBeLessThan(compressCalls[1]!)
  })

  it('does NOT apply changes when maybeCompress returns compressed=false (pressure<critical)', async () => {
    const { tool } = mockTool('echo', 'hi')
    // Simulate AgentLoopPlugin.maybeCompress short-circuit behavior:
    // when pressure is ok/warn it returns compressed: false unchanged.
    const maybeCompress = vi.fn(
      async (messages: BaseMessage[]): Promise<CompressResult> => ({
        messages,
        summary: null,
        compressed: false,
      }),
    )
    const onCompressed = vi.fn()

    const model = createMockModel([
      aiWithToolCalls([{ name: 'echo', args: {} }]),
      new AIMessage('final'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 5, maybeCompress, onCompressed },
    )

    expect(result.stopReason).toBe('complete')
    // onCompressed never fires when compressed: false
    expect(onCompressed).not.toHaveBeenCalled()
    // Messages grow normally: human + ai(tool_call) + tool + ai(final)
    expect(result.messages.length).toBeGreaterThanOrEqual(4)
  })

  it('applies compressed messages to history when compressed=true (pressure=critical)', async () => {
    const { tool } = mockTool('echo', 'hi')

    // Simulate a pressure-critical compression on the first LLM turn:
    // collapse the whole history to a single SystemMessage summary.
    const summarySystem = new SystemMessage('Summary: conversation compacted.')
    let invocations = 0
    const maybeCompress = vi.fn(
      async (messages: BaseMessage[]): Promise<CompressResult> => {
        invocations++
        if (invocations === 1) {
          // First turn — pressure transitioned to critical.
          return {
            messages: [summarySystem],
            summary: 'conversation compacted',
            compressed: true,
          }
        }
        // Subsequent turns — pressure back to ok, no-op.
        return { messages, summary: 'conversation compacted', compressed: false }
      },
    )
    const onCompressed = vi.fn()

    const model = createMockModel([
      aiWithToolCalls([{ name: 'echo', args: {} }]),
      new AIMessage('final'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go'), new HumanMessage('earlier')],
      [tool],
      { maxIterations: 5, maybeCompress, onCompressed },
    )

    // The compressed history was adopted: first message is now the summary
    // SystemMessage, not the original HumanMessage('go').
    expect(result.messages[0]).toBe(summarySystem)

    // onCompressed fired exactly once with accurate before/after counts
    expect(onCompressed).toHaveBeenCalledTimes(1)
    const info = onCompressed.mock.calls[0]![0] as {
      before: number
      after: number
      summary: string | null
    }
    // Before compression the loop had pushed: 2 humans + ai(tool_call) = 3
    expect(info.before).toBe(3)
    // After compression we replaced with [summarySystem] then continued the
    // loop — the tool result and the final AI message are appended AFTER
    // compression, so onCompressed sees exactly the post-swap count.
    expect(info.after).toBe(1)
    expect(info.summary).toBe('conversation compacted')
  })

  it('swallows errors thrown from maybeCompress (best-effort, non-fatal)', async () => {
    const { tool } = mockTool('echo', 'hi')
    const maybeCompress = vi.fn(async (): Promise<CompressResult> => {
      throw new Error('boom — compression pipeline crashed')
    })

    const model = createMockModel([
      aiWithToolCalls([{ name: 'echo', args: {} }]),
      new AIMessage('final'),
    ])

    // Must not throw — the loop swallows compression failures.
    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 5, maybeCompress },
    )

    expect(result.stopReason).toBe('complete')
    // Hook was still invoked despite throwing
    expect(maybeCompress).toHaveBeenCalled()
  })

  it('works with no maybeCompress provided (backward compat)', async () => {
    const { tool } = mockTool('echo', 'hi')
    const model = createMockModel([
      aiWithToolCalls([{ name: 'echo', args: {} }]),
      new AIMessage('final'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 5 /* no maybeCompress */ },
    )

    expect(result.stopReason).toBe('complete')
  })
})
