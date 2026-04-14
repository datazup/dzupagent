import { describe, it, expect } from 'vitest'
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { DzupAgent } from '../agent/dzip-agent.js'

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
    expect(toolMsg.content).toBe('raw-a-b')
  })
})
