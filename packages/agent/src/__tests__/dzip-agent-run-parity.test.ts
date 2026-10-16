import { describe, expect, it, vi } from 'vitest'
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { createEventBus, type DzupEvent } from '@dzupagent/core'
import { DzupAgent } from '../agent/dzip-agent.js'
import type { AgentStreamEvent, GenerateOptions } from '../agent/agent-types.js'

/**
 * One named alias for the mock's shape. Spelling the intersection out at
 * each `as` site produced two structurally identical but unrelated
 * `BaseChatModel` instantiations (TS2719).
 */
type MockChatModel = BaseChatModel & {
  invoke: ReturnType<typeof vi.fn>
  bindTools: ReturnType<typeof vi.fn>
  stream?: ReturnType<typeof vi.fn>
}

function createMockModel(
  responses: AIMessage[],
  options?: { stream?: boolean },
): MockChatModel {
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
    return model as unknown as MockChatModel
  }

  return {
    ...model,
    stream: vi.fn(async function* (_messages: BaseMessage[]) {
      const response = responses[streamIndex] ?? responses.at(-1) ?? new AIMessage('done')
      streamIndex += 1
      yield response
    }),
  } as unknown as MockChatModel
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

    // MC-3 (AGENT-H-06): the generate-path ToolMessage CONTEXT content is
    // wrapped in an `<untrusted_content>` delimiter (the wrapped value still
    // contains the middleware-transformed `raw-a-b` as quoted data), while the
    // emitted `tool_result` EVENT below stays raw — identical observability
    // semantics across generate() and stream() (parity, MJ-AGENT-02).
    expect(toolMessage?.content as string).toContain('raw-a-b')
    expect(toolMessage?.content as string).toContain('<untrusted_content source="tool_result">')

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

  it('emits one llm:invoked per model call with real tokens in stream(), matching generate()', async () => {
    const withUsage = (message: AIMessage, input: number, output: number) => {
      message.usage_metadata = {
        input_tokens: input,
        output_tokens: output,
        total_tokens: input + output,
      }
      return message
    }

    const runAgent = async (mode: 'generate' | 'stream') => {
      const responses = [
        withUsage(aiWithToolCall('echo', { text: 'x' }), 11, 7),
        withUsage(new AIMessage('done'), 13, 5),
      ]
      const bus = createEventBus()
      const invoked: Array<Extract<DzupEvent, { type: 'llm:invoked' }>> = []
      bus.on('llm:invoked', (event) => {
        invoked.push(event)
      })
      const echoTool = tool(async () => 'raw', {
        name: 'echo',
        description: 'echo',
        schema: z.object({ text: z.string() }),
      })
      const agent = new DzupAgent({
        id: `usage-${mode}`,
        instructions: 'test',
        model: createMockModel(responses),
        tools: [echoTool],
        eventBus: bus,
      })
      if (mode === 'generate') {
        await agent.generate([new HumanMessage('run')], { runId: 'run-usage' })
      } else {
        await collectStreamEvents(agent, { runId: 'run-usage' })
      }
      return invoked
    }

    const generated = await runAgent('generate')
    const streamed = await runAgent('stream')

    expect(generated).toHaveLength(2)
    expect(streamed).toHaveLength(2)
    for (const event of streamed) {
      expect(event.runId).toBe('run-usage')
      expect(event.agentId).toBe('usage-stream')
      expect(event.inputTokens).toBeGreaterThan(0)
      expect(event.outputTokens).toBeGreaterThan(0)
      expect(typeof event.costCents).toBe('number')
    }
    expect(streamed.map(e => [e.inputTokens, e.outputTokens])).toEqual(
      generated.map(e => [e.inputTokens, e.outputTokens]),
    )
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
    let beforeAgentState: Record<string, unknown> | undefined

    const agent = new DzupAgent({
      id: 'parity-fallback',
      instructions: 'test',
      model,
      middleware: [
        {
          name: 'before-agent',
          beforeAgent: async state => {
            beforeAgentCalls += 1
            // beforeAgent receives the run's initial state and returns a patch
            // that the runtime merges back in (see runBeforeAgentHooks). The
            // streaming path threads it exactly like generate() does.
            beforeAgentState = { ...state }
            return {}
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
    // The seam used to hand `beforeAgent` a literal `{}`; it now receives the
    // real initial run state.
    expect(beforeAgentState).toMatchObject({ agentId: 'parity-fallback' })
    expect(Array.isArray(beforeAgentState?.['messages'])).toBe(true)
    expect(model.invoke).not.toHaveBeenCalled()
    expect(doneEvent?.data).toMatchObject({
      content: 'wrapped-result',
      stopReason: 'complete',
    })
  })
})
