import { describe, expect, it, vi } from 'vitest'
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { DzupAgent } from '../agent/dzip-agent.js'
import type { AgentStreamEvent, GenerateOptions } from '../agent/agent-types.js'

function createMockModel(
  responses: AIMessage[],
  options?: { stream?: boolean },
): BaseChatModel & {
  invoke: ReturnType<typeof vi.fn>
  bindTools: ReturnType<typeof vi.fn>
  stream?: ReturnType<typeof vi.fn>
} {
  let invokeIndex = 0
  let streamIndex = 0

  const model = {
    invoke: vi.fn(async (_messages: BaseMessage[]) => {
      const response = responses[invokeIndex] ?? responses.at(-1) ?? new AIMessage('done')
      invokeIndex += 1
      return response
    }),
    bindTools: vi.fn().mockReturnThis(),
  }

  if (options?.stream === false) {
    return model as unknown as BaseChatModel & {
      invoke: ReturnType<typeof vi.fn>
      bindTools: ReturnType<typeof vi.fn>
    }
  }

  return {
    ...model,
    stream: vi.fn(async function* (_messages: BaseMessage[]) {
      const response = responses[streamIndex] ?? responses.at(-1) ?? new AIMessage('done')
      streamIndex += 1
      yield response
    }),
  } as unknown as BaseChatModel & {
    invoke: ReturnType<typeof vi.fn>
    bindTools: ReturnType<typeof vi.fn>
    stream: ReturnType<typeof vi.fn>
  }
}

function aiWithToolCall(name: string, args: Record<string, unknown>) {
  return new AIMessage({
    content: '',
    tool_calls: [{ id: `call-${name}`, name, args }],
  })
}

async function collectStreamEvents(
  agent: DzupAgent,
  options?: GenerateOptions,
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const event of agent.stream([new HumanMessage('run')], options)) {
    events.push(event)
  }
  return events
}

describe('DzupAgent generate()/stream() parity', () => {
  it('applies identical tool-result middleware semantics in the streaming loop', async () => {
    const responses = [
      aiWithToolCall('echo', { text: 'x' }),
      new AIMessage('done'),
    ]

    const makeAgent = () => {
      const model = createMockModel(responses)
      const echoTool = tool(
        async () => 'raw',
        {
          name: 'echo',
          description: 'echo test tool',
          schema: z.object({ text: z.string() }),
        },
      )

      return new DzupAgent({
        id: 'parity-stream-tool',
        instructions: 'test',
        model,
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
    }

    const generateAgent = makeAgent()
    const generateResult = await generateAgent.generate([new HumanMessage('run')])
    const toolMessage = generateResult.messages.find(
      message => message instanceof ToolMessage,
    ) as ToolMessage | undefined

    expect(toolMessage?.content).toBe('raw-a-b')

    const streamAgent = makeAgent()
    const streamEvents = await collectStreamEvents(streamAgent)
    const toolResultEvent = streamEvents.find(event => event.type === 'tool_result')
    const doneEvent = streamEvents.findLast(event => event.type === 'done')

    expect(toolResultEvent?.data.result).toBe('raw-a-b')
    expect(doneEvent?.data).toMatchObject({
      content: 'done',
      stopReason: 'complete',
    })
  })

  it('reports iteration-limit completion in stream() the same way generate() does', async () => {
    const responses = [
      aiWithToolCall('echo', { text: 'loop' }),
      aiWithToolCall('echo', { text: 'loop' }),
      aiWithToolCall('echo', { text: 'loop' }),
    ]

    const makeAgent = () => {
      const model = createMockModel(responses)
      const echoTool = tool(
        async () => 'looped',
        {
          name: 'echo',
          description: 'echo test tool',
          schema: z.object({ text: z.string() }),
        },
      )

      return new DzupAgent({
        id: 'parity-iteration-limit',
        instructions: 'test',
        model,
        tools: [echoTool],
      })
    }

    const generateResult = await makeAgent().generate([new HumanMessage('run')], { maxIterations: 2 })
    expect(generateResult.stopReason).toBe('iteration_limit')
    expect(generateResult.hitIterationLimit).toBe(true)

    const streamEvents = await collectStreamEvents(makeAgent(), { maxIterations: 2 })
    const doneEvent = streamEvents.findLast(event => event.type === 'done')

    expect(doneEvent?.data).toMatchObject({
      stopReason: 'iteration_limit',
      hitIterationLimit: true,
    })
  })

  it('reports stuck completion in stream() when repeated tool errors trigger the detector', async () => {
    const responses = [
      aiWithToolCall('echo', { text: 'retry-1' }),
      aiWithToolCall('echo', { text: 'retry-2' }),
      aiWithToolCall('echo', { text: 'retry-3' }),
      new AIMessage('unreachable'),
    ]

    const makeAgent = () => {
      const model = createMockModel(responses)
      const echoTool = tool(
        async () => {
          throw new Error('tool failed')
        },
        {
          name: 'echo',
          description: 'echo test tool',
          schema: z.object({ text: z.string() }),
        },
      )

      return new DzupAgent({
        id: 'parity-stuck',
        instructions: 'test',
        model,
        tools: [echoTool],
        guardrails: {
          stuckDetector: {
            maxRepeatCalls: 10,
            maxErrorsInWindow: 3,
            errorWindowMs: 60_000,
            maxIdleIterations: 10,
          },
        },
      })
    }

    const generateResult = await makeAgent().generate([new HumanMessage('run')], { maxIterations: 5 })
    expect(generateResult.stopReason).toBe('stuck')

    const streamEvents = await collectStreamEvents(makeAgent(), { maxIterations: 5 })
    const stuckEvent = streamEvents.find(event => event.type === 'stuck')
    const doneEvent = streamEvents.findLast(event => event.type === 'done')

    expect(stuckEvent?.data.reason).toBeDefined()
    expect(doneEvent?.data).toMatchObject({ stopReason: 'stuck' })
  })

  it('falls back through the shared generate runner when streaming is unavailable', async () => {
    const model = createMockModel([new AIMessage('model-result')], { stream: false })
    let beforeAgentCalls = 0

    const agent = new DzupAgent({
      id: 'parity-fallback',
      instructions: 'test',
      model,
      middleware: [
        {
          name: 'before-agent',
          beforeAgent: async () => {
            beforeAgentCalls += 1
          },
        },
        {
          name: 'override-model',
          wrapModelCall: async () => new AIMessage({ content: 'wrapped-result' }),
        },
      ],
    })

    const streamEvents = await collectStreamEvents(agent)
    const doneEvent = streamEvents.findLast(event => event.type === 'done')

    expect(beforeAgentCalls).toBe(1)
    expect(model.invoke).not.toHaveBeenCalled()
    expect(doneEvent?.data).toMatchObject({
      content: 'wrapped-result',
      stopReason: 'complete',
    })
  })
})
