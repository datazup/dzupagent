import { describe, expect, it, vi } from 'vitest'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'

import { AgentMiddlewareRuntime } from '../agent/middleware-runtime.js'

describe('AgentMiddlewareRuntime', () => {
  it('runs beforeAgent hooks and ignores hook failures', async () => {
    const first = vi.fn().mockResolvedValue({})
    const second = vi.fn().mockRejectedValue(new Error('boom'))
    const third = vi.fn().mockResolvedValue({})
    const runtime = new AgentMiddlewareRuntime({
      agentId: 'agent-1',
      middleware: [
        { name: 'first', beforeAgent: first },
        { name: 'second', beforeAgent: second },
        { name: 'third', beforeAgent: third },
      ],
    })

    await expect(runtime.runBeforeAgentHooks()).resolves.toBeUndefined()

    expect(first).toHaveBeenCalledWith({})
    expect(second).toHaveBeenCalledWith({})
    expect(third).toHaveBeenCalledWith({})
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
