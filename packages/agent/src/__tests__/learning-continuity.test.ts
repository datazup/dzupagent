import { describe, expect, it, vi } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  type StandardMessageStructure,
  type UsageMetadata,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'

import { DzupAgent } from '../agent/dzip-agent.js'
import type {
  AgentStreamEvent,
  DzupAgentConfig,
} from '../agent/agent-types.js'

function message(
  content: string,
  usage: UsageMetadata,
  toolCall?: { id: string; name: string; args: Record<string, unknown> },
): AIMessage {
  return new AIMessage<StandardMessageStructure>({
    content,
    usage_metadata: usage,
    ...(toolCall ? { tool_calls: [toolCall] } : {}),
  })
}

function modelFor(
  responses: AIMessage[],
  nativeStream: boolean,
): BaseChatModel {
  let invokeIndex = 0
  let streamIndex = 0
  const model: Record<string, unknown> = {
    invoke: vi.fn(async () => {
      const response = responses[invokeIndex] ?? responses.at(-1)!
      invokeIndex += 1
      return response
    }),
    bindTools: vi.fn().mockReturnThis(),
    model: 'learning-test-model',
  }
  if (nativeStream) {
    model.stream = vi.fn(async function* () {
      const response = responses[streamIndex] ?? responses.at(-1)!
      streamIndex += 1
      yield response
    })
  }
  return model as unknown as BaseChatModel
}

function tool(
  name: string,
  invoke: () => Promise<string> | string,
): StructuredToolInterface {
  return {
    name,
    description: `Learning test tool ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(invoke),
  } as unknown as StructuredToolInterface
}

function config(
  model: BaseChatModel,
  tools: StructuredToolInterface[],
  overrides: Partial<DzupAgentConfig> = {},
): DzupAgentConfig {
  return {
    id: 'learning-continuity-agent',
    instructions: 'Exercise the real learning lifecycle.',
    model,
    tools,
    ...overrides,
  }
}

async function drain(agent: DzupAgent): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const event of agent.stream([new HumanMessage('run')])) {
    events.push(event)
  }
  return events
}

const toolUsage: UsageMetadata = {
  input_tokens: 10,
  output_tokens: 2,
  total_tokens: 12,
}
const finalUsage: UsageMetadata = {
  input_tokens: 5,
  output_tokens: 3,
  total_tokens: 8,
}

describe('T2-9 learning continuity', () => {
  it('records a real generate tool and exposes exact completed learnings', async () => {
    const onToolLearning = vi.fn(async (_signal: unknown) => {})
    const onRunLearnings = vi.fn(async () => {})
    const specialistConfig = {
      category: 'search',
      modelTier: 'balanced' as const,
      reflectionDepth: 1,
      verificationStrategy: 'single' as const,
      maxFixAttempts: 2,
      qualityThreshold: 0.8,
    }
    const specialistRegistry = {
      getConfig: vi.fn(async () => specialistConfig),
    }
    const search = tool('search', () => 'hits')
    const agent = new DzupAgent(config(
      modelFor([
        message('', toolUsage, { id: 'tool-1', name: 'search', args: { q: 'x' } }),
        message('done', finalUsage),
      ], false),
      [search],
      {
        selfLearning: {
          enabled: true,
          onToolLearning,
          onRunLearnings,
          specialistRegistry: specialistRegistry as never,
          featureCategory: 'search',
          riskClass: 'standard',
        },
      },
    ))

    const result = await agent.generate([new HumanMessage('search')])

    expect(onToolLearning).toHaveBeenCalledOnce()
    expect(onToolLearning).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'search',
      success: true,
    }))
    expect(onToolLearning.mock.calls[0]?.[0]).not.toHaveProperty('error')
    expect(onRunLearnings).toHaveBeenCalledOnce()
    expect(specialistRegistry.getConfig).toHaveBeenCalledWith('search', 'standard')
    expect(result.learnings).toMatchObject({
      llmCalls: 2,
      totalInputTokens: 15,
      totalOutputTokens: 5,
      stopReason: 'complete',
      wasStuck: false,
      specialistConfig,
      toolStats: [expect.objectContaining({ name: 'search', calls: 1, errors: 0 })],
      skillMetrics: [expect.objectContaining({ name: 'search' })],
    })
    expect(onRunLearnings).toHaveBeenCalledWith(result.learnings)
  })

  it('records a real native-stream tool error and keeps rejecting callbacks fail-soft', async () => {
    const onToolLearning = vi.fn(async () => {
      throw new Error('tool-learning store unavailable')
    })
    const onRunLearnings = vi.fn(async () => {
      throw new Error('run-learning store unavailable')
    })
    const failingTool = tool('explode', () => {
      throw new Error('tool exploded')
    })
    const agent = new DzupAgent(config(
      modelFor([
        message('', toolUsage, { id: 'tool-2', name: 'explode', args: {} }),
        message('recovered', finalUsage),
      ], true),
      [failingTool],
      {
        selfLearning: { enabled: true, onToolLearning, onRunLearnings },
      },
    ))

    const events = await drain(agent)
    const done = events.findLast(event => event.type === 'done')

    expect(onToolLearning).toHaveBeenCalledOnce()
    expect(onToolLearning).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'explode',
      success: false,
      error: 'tool exploded',
    }))
    expect(onRunLearnings).toHaveBeenCalledOnce()
    expect(done?.data.learnings).toMatchObject({
      llmCalls: 2,
      totalInputTokens: 15,
      totalOutputTokens: 5,
      stopReason: 'complete',
      toolStats: [expect.objectContaining({ name: 'explode', calls: 1, errors: 1 })],
    })
  })

  it('forwards the generate completion once through the non-stream fallback', async () => {
    const onRunLearnings = vi.fn(async () => {})
    const agent = new DzupAgent(config(
      modelFor([message('fallback done', finalUsage)], false),
      [],
      { selfLearning: { enabled: true, onRunLearnings } },
    ))

    const events = await drain(agent)
    const done = events.findLast(event => event.type === 'done')

    expect(onRunLearnings).toHaveBeenCalledOnce()
    expect(done?.data.learnings).toMatchObject({
      llmCalls: 1,
      totalInputTokens: 5,
      totalOutputTokens: 3,
      stopReason: 'complete',
    })
  })

  it('preserves disabled learning compatibility on native stream', async () => {
    const onToolLearning = vi.fn(async () => {})
    const onRunLearnings = vi.fn(async () => {})
    const agent = new DzupAgent(config(
      modelFor([message('done', finalUsage)], true),
      [],
      {
        selfLearning: {
          enabled: false,
          onToolLearning,
          onRunLearnings,
        },
      },
    ))

    const events = await drain(agent)
    const done = events.findLast(event => event.type === 'done')

    expect(onToolLearning).not.toHaveBeenCalled()
    expect(onRunLearnings).not.toHaveBeenCalled()
    expect(done?.data).not.toHaveProperty('learnings')
  })

  it('does not swallow an engine output-filter failure as a learning failure', async () => {
    const onRunLearnings = vi.fn(async () => {})
    const agent = new DzupAgent(config(
      modelFor([message('done', finalUsage)], false),
      [],
      {
        selfLearning: { enabled: true, onRunLearnings },
        guardrails: {
          outputFilter: async () => {
            throw new Error('correctness filter failed')
          },
        },
      },
    ))

    await expect(agent.generate([new HumanMessage('run')]))
      .rejects.toThrow('correctness filter failed')
    expect(onRunLearnings).not.toHaveBeenCalled()
  })
})
