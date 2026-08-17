import { describe, expect, it, vi } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
  type StandardMessageStructure,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { TokenUsage } from '@dzupagent/core/llm'

import { DzupAgent } from '../agent/dzip-agent.js'
import { IterationBudget } from '../guardrails/iteration-budget.js'

const INPUT_TOKENS_PER_TURN = 7
const OUTPUT_TOKENS_PER_TURN = 3

function repeatedToolCall(turn: number): AIMessage {
  const message = new AIMessage<StandardMessageStructure>({
    content: '',
    response_metadata: { model: 'gpt-4o' },
    usage_metadata: {
      input_tokens: INPUT_TOKENS_PER_TURN,
      output_tokens: OUTPUT_TOKENS_PER_TURN,
      total_tokens: INPUT_TOKENS_PER_TURN + OUTPUT_TOKENS_PER_TURN,
    },
  })
  ;(message as AIMessage & { tool_calls: unknown[] }).tool_calls = [
    {
      id: `repeat_${turn}`,
      name: 'repeat',
      args: { value: 'same' },
    },
  ]
  return message
}

function trackedTool(): {
  tool: StructuredToolInterface
  invoke: ReturnType<typeof vi.fn>
} {
  const invoke = vi.fn(async () => 'ok')
  return {
    tool: {
      name: 'repeat',
      description: 'Always succeeds with the same result',
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke,
    } as unknown as StructuredToolInterface,
    invoke,
  }
}

function generateModel(): BaseChatModel & { invoke: ReturnType<typeof vi.fn> } {
  let turn = 0
  return {
    invoke: vi.fn(async (_messages: BaseMessage[]) => repeatedToolCall(++turn)),
    bindTools: vi.fn().mockReturnThis(),
  } as unknown as BaseChatModel & { invoke: ReturnType<typeof vi.fn> }
}

function streamingModel(): BaseChatModel & { stream: ReturnType<typeof vi.fn> } {
  let turn = 0
  return {
    invoke: vi.fn(),
    bindTools: vi.fn().mockReturnThis(),
    stream: vi.fn(async function* () {
      yield repeatedToolCall(++turn)
    }),
  } as unknown as BaseChatModel & { stream: ReturnType<typeof vi.fn> }
}

describe('stuck-run model-cost bound', () => {
  it('distinguishes static guardrail denials from runtime stuck blocks', () => {
    const budget = new IterationBudget({ blockedTools: ['static-denial'] })

    expect(budget.isToolBlocked('static-denial')).toBe(true)
    expect(budget.isToolDynamicallyBlocked('static-denial')).toBe(false)

    budget.blockTool('runtime-block')
    expect(budget.isToolBlocked('runtime-block')).toBe(true)
    expect(budget.isToolDynamicallyBlocked('runtime-block')).toBe(true)
  })

  it('generate reaches terminal stuck with bounded model and token spend', async () => {
    const model = generateModel()
    const { tool, invoke } = trackedTool()
    const observedUsage: TokenUsage[] = []
    const agent = new DzupAgent({
      id: 'bounded-generate-stuck',
      instructions: 'Test repeated tool handling.',
      model,
      tools: [tool],
      maxIterations: 100,
      guardrails: { stuckDetector: { maxRepeatCalls: 2 } },
    })

    const result = await agent.generate([new HumanMessage('repeat forever')], {
      onUsage: usage => observedUsage.push(usage),
    })

    expect(result.stopReason).toBe('stuck')
    expect(model.invoke).toHaveBeenCalledTimes(4)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(
      observedUsage.reduce(
        (total, usage) => total + usage.inputTokens + usage.outputTokens,
        0,
      ),
    ).toBe(4 * (INPUT_TOKENS_PER_TURN + OUTPUT_TOKENS_PER_TURN))
  })

  it('native stream stops on the first retry after a stuck block', async () => {
    const model = streamingModel()
    const { tool, invoke } = trackedTool()
    const observedUsage: TokenUsage[] = []
    const agent = new DzupAgent({
      id: 'bounded-stream-stuck',
      instructions: 'Test repeated tool handling.',
      model,
      tools: [tool],
      maxIterations: 100,
      guardrails: { stuckDetector: { maxRepeatCalls: 2 } },
    })

    const events: Array<{ type: string; data?: Record<string, unknown> }> = []
    for await (const event of agent.stream(
      [new HumanMessage('repeat forever')],
      { onUsage: usage => observedUsage.push(usage) },
    )) {
      events.push(event as { type: string; data?: Record<string, unknown> })
    }

    expect(events.findLast(event => event.type === 'done')?.data?.stopReason).toBe(
      'stuck',
    )
    expect(model.stream).toHaveBeenCalledTimes(3)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(
      observedUsage.reduce(
        (total, usage) => total + usage.inputTokens + usage.outputTokens,
        0,
      ),
    ).toBe(3 * (INPUT_TOKENS_PER_TURN + OUTPUT_TOKENS_PER_TURN))
  })

  it('does not relabel a statically blocked tool as stuck', async () => {
    const model = generateModel()
    const { tool, invoke } = trackedTool()
    const agent = new DzupAgent({
      id: 'static-block-is-not-stuck',
      instructions: 'Test static tool denial.',
      model,
      tools: [tool],
      maxIterations: 4,
      guardrails: {
        blockedTools: ['repeat'],
        stuckDetector: { maxRepeatCalls: 1 },
      },
    })

    const result = await agent.generate([new HumanMessage('repeat forever')])

    expect(result.stopReason).toBe('iteration_limit')
    expect(result.stuckError).toBeUndefined()
    expect(model.invoke).toHaveBeenCalledTimes(4)
    expect(invoke).not.toHaveBeenCalled()
  })
})
