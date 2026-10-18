import { describe, expect, it, vi } from 'vitest'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { AgentMiddleware } from '@dzupagent/core/llm'

import { AgentMiddlewareRuntime } from '../agent/middleware-runtime.js'

function fakeModel(content = 'model-result') {
  return {
    invoke: vi.fn(async () => new AIMessage({ content })),
  }
}

describe('AgentMiddlewareRuntime afterModel', () => {
  it('runs afterModel in reverse middleware order after the wrapModelCall chain returns', async () => {
    const calls: string[] = []
    const wrapping = (name: string): AgentMiddleware => ({
      name,
      wrapModelCall: async (model: BaseChatModel, messages: BaseMessage[]) => {
        calls.push(`${name}:wrap`)
        return model.invoke(messages)
      },
      afterModel: async () => {
        calls.push(`${name}:after`)
      },
    })
    const runtime = new AgentMiddlewareRuntime({
      agentId: 'agent-after-1',
      middleware: [wrapping('a'), wrapping('b')],
    })

    await runtime.invokeModel(fakeModel() as never, [new HumanMessage('hi')])

    expect(calls).toEqual(['a:wrap', 'b:wrap', 'b:after', 'a:after'])
  })

  it('passes the request, the response and the state to afterModel, and returns the same response', async () => {
    const seen: Array<{ request: BaseMessage[]; response: BaseMessage; state: Record<string, unknown> }> = []
    const runtime = new AgentMiddlewareRuntime({
      agentId: 'agent-after-2',
      middleware: [
        {
          name: 'observer',
          afterModel: async (ctx) => {
            seen.push({ ...ctx, state: { ...ctx.state } })
          },
        },
      ],
    })
    const model = fakeModel('the-answer')
    const request = [new HumanMessage('question')]
    const state = { turn: 1 }

    const response = await runtime.invokeModel(model as never, request, { state })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.request).toBe(request)
    expect(seen[0]?.response).toBe(response)
    expect((seen[0]?.response as AIMessage).content).toBe('the-answer')
    expect(seen[0]?.state).toEqual({ turn: 1 })
    // No wrapper defined: the no-wrapper fast path still calls the model as before.
    expect(model.invoke).toHaveBeenCalledWith(request)
    expect(await model.invoke.mock.results[0]?.value).toBe(response)
  })

  it('merges afterModel patches into the caller state so the next call sees them in its wrapModelCall context', async () => {
    const contexts: Array<Record<string, unknown> | undefined> = []
    const runtime = new AgentMiddlewareRuntime({
      agentId: 'agent-after-3',
      middleware: [
        {
          name: 'counter',
          wrapModelCall: async (model, messages, config) => {
            const state = config?.['state'] as Record<string, unknown> | undefined
            contexts.push(state ? { ...state } : undefined)
            return model.invoke(messages)
          },
          afterModel: async ({ state }) => ({
            calls: ((state['calls'] as number | undefined) ?? 0) + 1,
          }),
        },
      ],
    })
    const state: Record<string, unknown> = {}
    const model = fakeModel()

    await runtime.invokeModel(model as never, [new HumanMessage('one')], { state })
    await runtime.invokeModel(model as never, [new HumanMessage('two')], { state })

    expect(contexts).toEqual([{}, { calls: 1 }])
    expect(state).toEqual({ calls: 2 })
  })

  it('skips middleware without afterModel', async () => {
    const after = vi.fn(async () => ({ seen: true }))
    const runtime = new AgentMiddlewareRuntime({
      agentId: 'agent-after-4',
      middleware: [
        { name: 'before-only', beforeAgent: async () => ({}) },
        { name: 'after', afterModel: after },
        { name: 'tool-only', wrapToolCall: async (_n, _i, result) => result },
      ],
    })
    const state: Record<string, unknown> = {}

    const response = await runtime.invokeModel(fakeModel() as never, [new HumanMessage('x')], { state })

    expect((response as AIMessage).content).toBe('model-result')
    expect(after).toHaveBeenCalledTimes(1)
    expect(state).toEqual({ seen: true })
  })

  it('treats a throwing afterModel as non-fatal: no patch from it, and later hooks still run', async () => {
    const order: string[] = []
    const runtime = new AgentMiddlewareRuntime({
      agentId: 'agent-after-5',
      middleware: [
        {
          name: 'outer',
          afterModel: async () => {
            order.push('outer')
            return { fromOuter: true }
          },
        },
        {
          name: 'thrower',
          afterModel: async () => {
            order.push('thrower')
            throw new Error('boom')
          },
        },
        {
          name: 'inner',
          afterModel: async () => {
            order.push('inner')
            return { fromInner: true }
          },
        },
      ],
    })
    const state: Record<string, unknown> = {}

    const response = await runtime.invokeModel(fakeModel() as never, [new HumanMessage('x')], { state })

    expect((response as AIMessage).content).toBe('model-result')
    expect(order).toEqual(['inner', 'thrower', 'outer'])
    expect(state).toEqual({ fromInner: true, fromOuter: true })
  })
})
