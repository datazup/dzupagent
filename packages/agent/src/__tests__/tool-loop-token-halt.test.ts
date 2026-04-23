/**
 * Token-lifecycle halt integration tests for the default tool loop.
 *
 * Verifies that `ToolLoopConfig.shouldHalt` is consulted after each LLM
 * turn — when it returns `true` the loop stops with
 * `stopReason === 'token_exhausted'` and invokes `onHalted('token_exhausted')`.
 *
 * Also verifies backward compatibility (no `shouldHalt`), prioritization
 * relative to `AbortSignal`, and that the halt happens BEFORE any tool
 * calls in that turn execute.
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

describe('Tool loop — token-lifecycle halt', () => {
  it('shouldHalt returning false never triggers — loop completes normally', async () => {
    const { tool } = mockTool('echo', 'hi')
    const shouldHalt = vi.fn(() => false)
    const onHalted = vi.fn()

    const model = createMockModel([
      aiWithToolCalls([{ name: 'echo', args: { x: 1 } }]),
      new AIMessage('final'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 5, shouldHalt, onHalted },
    )

    expect(result.stopReason).toBe('complete')
    expect(onHalted).not.toHaveBeenCalled()
    // shouldHalt is consulted on every LLM turn (2 turns here)
    expect(shouldHalt).toHaveBeenCalledTimes(2)
  })

  it('shouldHalt returning true after first LLM call → stopReason token_exhausted', async () => {
    const { tool, invokeFn } = mockTool('echo', 'hi')
    const shouldHalt = vi.fn(() => true)
    const onHalted = vi.fn()

    const model = createMockModel([
      aiWithToolCalls([{ name: 'echo', args: { x: 1 } }]),
      new AIMessage('final'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 5, shouldHalt, onHalted },
    )

    expect(result.stopReason).toBe('token_exhausted')
    // Halt happens BEFORE tool execution in that turn
    expect(invokeFn).not.toHaveBeenCalled()
    // And also before subsequent LLM turns
    expect(result.llmCalls).toBe(1)
  })

  it('onHalted callback is invoked with "token_exhausted" when halted', async () => {
    const onHalted = vi.fn()
    const model = createMockModel([new AIMessage('hi')])

    await runToolLoop(
      model,
      [new HumanMessage('go')],
      [],
      {
        maxIterations: 5,
        shouldHalt: () => true,
        onHalted,
      },
    )

    expect(onHalted).toHaveBeenCalledTimes(1)
    expect(onHalted).toHaveBeenCalledWith('token_exhausted')
  })

  it('onHalted is NOT invoked when loop completes normally', async () => {
    const onHalted = vi.fn()
    const model = createMockModel([new AIMessage('final response')])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [],
      {
        maxIterations: 5,
        shouldHalt: () => false,
        onHalted,
      },
    )

    expect(result.stopReason).toBe('complete')
    expect(onHalted).not.toHaveBeenCalled()
  })

  it('loop breaks immediately when shouldHalt returns true (no more iterations)', async () => {
    const invokeSpy = vi.fn()
    let callIdx = 0
    const responses = [
      aiWithToolCalls([{ name: 'a', args: {} }]),
      aiWithToolCalls([{ name: 'a', args: {} }]),
      aiWithToolCalls([{ name: 'a', args: {} }]),
      new AIMessage('done'),
    ]
    const model = {
      invoke: vi.fn(async (_msgs: BaseMessage[]) => {
        invokeSpy()
        const r = responses[callIdx] ?? new AIMessage('fallback')
        callIdx++
        return r
      }),
    } as unknown as BaseChatModel

    const { tool } = mockTool('a', 'ok')
    // Halt after the 2nd LLM call
    const shouldHalt = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 10, shouldHalt },
    )

    expect(result.stopReason).toBe('token_exhausted')
    // Exactly 2 LLM invocations — halt bailed us out before the 3rd
    expect(invokeSpy).toHaveBeenCalledTimes(2)
    expect(result.llmCalls).toBe(2)
  })

  it('works with no shouldHalt provided (backward compat)', async () => {
    const { tool } = mockTool('echo', 'hi')
    const model = createMockModel([
      aiWithToolCalls([{ name: 'echo', args: {} }]),
      new AIMessage('final'),
    ])

    // Intentionally pass neither shouldHalt nor onHalted
    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 5 },
    )

    expect(result.stopReason).toBe('complete')
  })

  it('works with shouldHalt always false (never triggers, no onHalted provided)', async () => {
    const { tool } = mockTool('echo', 'hi')
    const model = createMockModel([
      aiWithToolCalls([{ name: 'echo', args: {} }]),
      new AIMessage('final'),
    ])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [tool],
      { maxIterations: 5, shouldHalt: () => false /* no onHalted */ },
    )

    expect(result.stopReason).toBe('complete')
  })

  it('aborted signal takes priority over shouldHalt (aborted checked first)', async () => {
    const onHalted = vi.fn()
    const shouldHalt = vi.fn(() => true)

    // Pre-aborted signal before the loop starts
    const controller = new AbortController()
    controller.abort()

    const model = createMockModel([new AIMessage('should not be seen')])

    const result = await runToolLoop(
      model,
      [new HumanMessage('go')],
      [],
      {
        maxIterations: 5,
        signal: controller.signal,
        shouldHalt,
        onHalted,
      },
    )

    expect(result.stopReason).toBe('aborted')
    // LLM never invoked — aborted check happens at the top of each iteration
    expect(result.llmCalls).toBe(0)
    // Since the loop never reached the LLM call, shouldHalt and onHalted
    // should not have been invoked.
    expect(shouldHalt).not.toHaveBeenCalled()
    expect(onHalted).not.toHaveBeenCalled()
  })
})
