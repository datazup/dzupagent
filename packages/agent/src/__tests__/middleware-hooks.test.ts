import { describe, it, expect } from 'vitest'
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { DzupAgent } from '../agent/dzip-agent.js'
import { AgentMiddlewareRuntime } from '../agent/middleware-runtime.js'

describe('DzupAgent middleware hooks', () => {
  it('uses wrapModelCall when provided', async () => {
    let modelInvoked = false
    const model = {
      invoke: async () => {
        modelInvoked = true
        return new AIMessage({ content: 'model-result' })
      },
    }

    const agent = new DzupAgent({
      id: 'mw-model',
      instructions: 'test',
      model: model as never,
      middleware: [
        {
          name: 'override-model',
          wrapModelCall: async () => new AIMessage({ content: 'wrapped-result' }),
        },
      ],
    })

    const result = await agent.generate([new HumanMessage('hello')])
    expect(result.content).toBe('wrapped-result')
    expect(modelInvoked).toBe(false)
  })

  it('composes every wrapModelCall in configured order', async () => {
    const order: string[] = []
    const model = {
      invoke: async () => {
        order.push('model')
        return new AIMessage({ content: 'model-result' })
      },
    }

    const agent = new DzupAgent({
      id: 'mw-model-stack',
      instructions: 'test',
      model: model as never,
      middleware: [
        {
          name: 'outer',
          wrapModelCall: async (m, msgs) => {
            order.push('outer:before')
            const res = await m.invoke(msgs)
            order.push('outer:after')
            return res
          },
        },
        {
          name: 'inner',
          wrapModelCall: async (m, msgs) => {
            order.push('inner:before')
            const res = await m.invoke(msgs)
            order.push('inner:after')
            return new AIMessage({ content: `inner(${String(res.content)})` })
          },
        },
      ],
    })

    const result = await agent.generate([new HumanMessage('hello')])
    expect(result.content).toBe('inner(model-result)')
    expect(order).toEqual(['outer:before', 'inner:before', 'model', 'inner:after', 'outer:after'])
  })

  it('delivers an aborted signal to model.invoke through stacked wrappers', async () => {
    const controller = new AbortController()
    controller.abort()
    let seen: AbortSignal | undefined
    const model = {
      invoke: async (_messages: unknown, options?: { signal?: AbortSignal }) => {
        seen = options?.signal
        if (options?.signal?.aborted) throw new Error('aborted at provider')
        return new AIMessage({ content: 'should-not-happen' })
      },
    }
    const calls: string[] = []
    const contexts: Array<Record<string, unknown> | undefined> = []
    const runtime = new AgentMiddlewareRuntime({
      agentId: 'mw-abort',
      middleware: [
        { name: 'a', wrapModelCall: async (m, msgs, ctx) => { calls.push('a'); contexts.push(ctx); return m.invoke(msgs) } },
        { name: 'b', wrapModelCall: async (m, msgs) => { calls.push('b'); return m.invoke(msgs) } },
      ],
    })

    await expect(
      runtime.invokeModel(model as never, [new HumanMessage('x')], { signal: controller.signal }),
    ).rejects.toThrow('aborted at provider')
    expect(calls).toEqual(['a', 'b'])
    expect(seen).toBe(controller.signal)
    expect(seen?.aborted).toBe(true)
    expect(contexts[0]).toEqual({ agentId: 'mw-abort', signal: controller.signal })
  })

  it('applies wrapToolCall transformations in order', async () => {
    let calls = 0
    const model = {
      invoke: async () => {
        calls += 1
        if (calls === 1) {
          return new AIMessage({
            content: 'calling tool',
            tool_calls: [{ id: 'c1', name: 'echo', args: { text: 'x' } }],
          })
        }
        return new AIMessage({ content: 'done' })
      },
    }

    const echoTool = tool(
      async () => 'raw',
      {
        name: 'echo',
        description: 'echo test tool',
        schema: z.object({ text: z.string() }),
      },
    )

    const agent = new DzupAgent({
      id: 'mw-tool',
      instructions: 'test',
      model: model as never,
      tools: [echoTool],
      middleware: [
        {
          name: 'suffix-a',
          wrapToolCall: async (_name, _input, result) => `${result}-a`,
        },
        {
          name: 'suffix-b',
          wrapToolCall: async (_name, _input, result) => `${result}-b`,
        },
      ],
    })

    const result = await agent.generate([new HumanMessage('use tool')])
    expect(result.content).toBe('done')

    const toolMsg = result.messages.find((m) => m instanceof ToolMessage) as ToolMessage
    expect(toolMsg).toBeDefined()
    // MC-3 (AGENT-H-06): wrapToolCall middleware runs in order (raw → raw-a →
    // raw-a-b), and the final result is then wrapped in an
    // `<untrusted_content>` delimiter before entering message history.
    expect(toolMsg.content as string).toContain('raw-a-b')
    expect(toolMsg.content as string).toContain('<untrusted_content source="tool_result">')
  })
})
