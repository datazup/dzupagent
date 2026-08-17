import { describe, expect, it, vi } from 'vitest'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'

import { AgentMiddlewareRuntime } from '../agent/middleware-runtime.js'

describe('AgentMiddlewareRuntime', () => {
  it('threads state through the beforeAgent chain, merges patches, and ignores hook failures', async () => {
    // Each hook records the state it OBSERVED, so the assertions below pin what
    // flowed in — not merely that the hook was called. The middle hook throws;
    // its failure must neither abort the chain nor discard the accumulated
    // state contributed before it.
    const observed: Array<Record<string, unknown>> = []
    const first = vi.fn(async (state: Record<string, unknown>) => {
      observed.push({ ...state })
      return { fromFirst: 1, shared: 'first' }
    })
    const second = vi.fn(async (state: Record<string, unknown>) => {
      observed.push({ ...state })
      throw new Error('boom')
    })
    const third = vi.fn(async (state: Record<string, unknown>) => {
      observed.push({ ...state })
      return { fromThird: 3, shared: 'third' }
    })
    const runtime = new AgentMiddlewareRuntime({
      agentId: 'agent-1',
      middleware: [
        { name: 'first', beforeAgent: first },
        { name: 'second', beforeAgent: second },
        { name: 'third', beforeAgent: third },
      ],
    })

    const seed = { seeded: 'yes' }
    const merged = await runtime.runBeforeAgentHooks(seed)

    // --- state IN: the seed reaches hook 1, and hook 1's patch reaches hook 3
    expect(observed).toHaveLength(3)
    expect(observed[0]).toEqual({ seeded: 'yes' })
    expect(observed[1]).toEqual({ seeded: 'yes', fromFirst: 1, shared: 'first' })
    expect(observed[2]).toEqual({ seeded: 'yes', fromFirst: 1, shared: 'first' })

    // --- state OUT: patches merged, later keys win, thrower contributed nothing
    expect(merged).toEqual({
      seeded: 'yes',
      fromFirst: 1,
      fromThird: 3,
      shared: 'third',
    })

    // The caller's own object is never mutated in place.
    expect(seed).toEqual({ seeded: 'yes' })
    expect(merged).not.toBe(seed)
  })

  it('defaults the seed state to an empty object when the caller supplies none', async () => {
    const hook = vi.fn(async () => ({ added: true }))
    const runtime = new AgentMiddlewareRuntime({
      agentId: 'agent-1b',
      middleware: [{ name: 'only', beforeAgent: hook }],
    })

    await expect(runtime.runBeforeAgentHooks()).resolves.toEqual({ added: true })
    expect(hook).toHaveBeenCalledWith({})
  })

  it('uses the first wrapModelCall middleware and skips model.invoke fallback', async () => {
    let modelInvoked = false
    const model = {
      invoke: async () => {
        modelInvoked = true
        return new AIMessage({ content: 'model-result' })
      },
    }
    const firstWrapper = vi.fn().mockResolvedValue(new AIMessage({ content: 'wrapped-result' }))
    const secondWrapper = vi.fn().mockResolvedValue(new AIMessage({ content: 'unused' }))
    const runtime = new AgentMiddlewareRuntime({
      agentId: 'agent-2',
      middleware: [
        { name: 'first', wrapModelCall: firstWrapper },
        { name: 'second', wrapModelCall: secondWrapper },
      ],
    })

    const message = new HumanMessage('hello')
    const result = await runtime.invokeModel(model as never, [message])

    expect(result).toBeInstanceOf(AIMessage)
    expect((result as AIMessage).content).toBe('wrapped-result')
    expect(firstWrapper).toHaveBeenCalledWith(model, [message], { agentId: 'agent-2' })
    expect(secondWrapper).not.toHaveBeenCalled()
    expect(modelInvoked).toBe(false)
  })

  it('falls back to model.invoke when no wrapModelCall middleware exists', async () => {
    const model = {
      invoke: vi.fn().mockResolvedValue(new AIMessage({ content: 'model-result' })),
    }
    const runtime = new AgentMiddlewareRuntime({
      agentId: 'agent-3',
      middleware: [{ name: 'before-only', beforeAgent: async () => ({}) }],
    })

    const message = new HumanMessage('hi')
    const result = await runtime.invokeModel(model as never, [message])

    expect((result as AIMessage).content).toBe('model-result')
    expect(model.invoke).toHaveBeenCalledWith([message])
  })

  it('applies tool result wrappers in order and ignores wrapper failures', async () => {
    const runtime = new AgentMiddlewareRuntime({
      agentId: 'agent-4',
      middleware: [
        {
          name: 'suffix-a',
          wrapToolCall: async (_name, _input, result) => `${result}-a`,
        },
        {
          name: 'explode',
          wrapToolCall: async () => {
            throw new Error('ignore me')
          },
        },
        {
          name: 'suffix-b',
          wrapToolCall: async (_name, _input, result) => `${result}-b`,
        },
      ],
    })

    const result = await runtime.transformToolResult('echo', { text: 'x' }, 'raw')

    expect(result).toBe('raw-a-b')
  })

  it('resolves base tools before middleware tools in registration order', () => {
    const baseTool = { name: 'base-tool' } as StructuredToolInterface
    const firstTool = { name: 'first-middleware-tool' } as StructuredToolInterface
    const secondTool = { name: 'second-middleware-tool' } as StructuredToolInterface
    const baseTools = [baseTool]
    const runtime = new AgentMiddlewareRuntime({
      agentId: 'agent-5',
      middleware: [
        { name: 'first', tools: [firstTool] },
        { name: 'missing-tools' },
        { name: 'second', tools: [secondTool] },
      ],
    })

    const resolved = runtime.resolveTools(baseTools)

    expect(resolved).not.toBe(baseTools)
    expect(resolved).toEqual([baseTool, firstTool, secondTool])
  })
})
