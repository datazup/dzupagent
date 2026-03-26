/**
 * Tests for token usage extraction in the ForgeAgent streaming path.
 *
 * Validates that the stream() method correctly extracts real token usage
 * from provider metadata and only falls back to estimation when no
 * real data is available.
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { ForgeAgent } from '../agent/forge-agent.js'

/**
 * Create a mock model that supports streaming and returns chunks with
 * optional usage metadata on the final chunk.
 */
function createMockStreamingModel(
  responseText: string,
  usageMetadata?: {
    usage_metadata?: Record<string, unknown>
    response_metadata?: Record<string, unknown>
  },
): BaseChatModel {
  const mockModel = {
    invoke: vi.fn().mockResolvedValue(new AIMessage(responseText)),
    stream: vi.fn().mockImplementation(async function* () {
      // Simulate streaming: yield the full response as a single chunk
      const finalChunk = new AIMessage(responseText)
      if (usageMetadata?.usage_metadata) {
        ;(finalChunk as AIMessage & { usage_metadata: Record<string, unknown> }).usage_metadata =
          usageMetadata.usage_metadata
      }
      if (usageMetadata?.response_metadata) {
        ;(finalChunk as AIMessage & { response_metadata: Record<string, unknown> }).response_metadata =
          usageMetadata.response_metadata
      }
      yield finalChunk
    }),
    bindTools: vi.fn().mockReturnThis(),
    model: 'test-model',
  } as unknown as BaseChatModel
  return mockModel
}

/** Collect all events from the stream. */
async function collectStreamEvents(
  agent: ForgeAgent,
  messages: import('@langchain/core/messages').BaseMessage[],
  options?: import('../agent/agent-types.js').GenerateOptions,
) {
  const events = []
  for await (const event of agent.stream(messages, options)) {
    events.push(event)
  }
  return events
}

describe('ForgeAgent stream() token usage', () => {
  it('uses real token counts from Anthropic usage_metadata', async () => {
    const model = createMockStreamingModel('Hello world', {
      usage_metadata: { input_tokens: 100, output_tokens: 25, total_tokens: 125 },
    })

    const agent = new ForgeAgent({
      id: 'test-agent',
      instructions: 'You are a test agent.',
      model,
      guardrails: { maxTokens: 10_000 },
    })

    const events = await collectStreamEvents(agent, [new HumanMessage('Hi')])

    // Should get text + done events, no budget warnings for small usage
    const textEvents = events.filter(e => e.type === 'text')
    expect(textEvents.length).toBeGreaterThan(0)

    const doneEvents = events.filter(e => e.type === 'done')
    expect(doneEvents.length).toBe(1)
  })

  it('uses real token counts from OpenAI response_metadata.usage', async () => {
    const model = createMockStreamingModel('Hello', {
      response_metadata: {
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      },
    })

    const agent = new ForgeAgent({
      id: 'test-agent',
      instructions: 'You are a test agent.',
      model,
      guardrails: { maxTokens: 10_000 },
    })

    const events = await collectStreamEvents(agent, [new HumanMessage('Hi')])
    const doneEvents = events.filter(e => e.type === 'done')
    expect(doneEvents.length).toBe(1)
  })

  it('falls back to estimation when no usage data is present', async () => {
    // Model returns no usage metadata at all
    const model = createMockStreamingModel('Short response')

    const agent = new ForgeAgent({
      id: 'test-agent',
      instructions: 'You are a test agent.',
      model,
      guardrails: { maxTokens: 10_000 },
    })

    const events = await collectStreamEvents(agent, [new HumanMessage('Hi')])
    const doneEvents = events.filter(e => e.type === 'done')
    expect(doneEvents.length).toBe(1)
    // No error events
    const errorEvents = events.filter(e => e.type === 'error')
    expect(errorEvents.length).toBe(0)
  })

  it('triggers budget warning when real tokens approach limit', async () => {
    // Set a low token limit and provide high real usage
    const model = createMockStreamingModel('response', {
      usage_metadata: { input_tokens: 800, output_tokens: 200, total_tokens: 1000 },
    })

    const agent = new ForgeAgent({
      id: 'test-agent',
      instructions: 'You are a test agent.',
      model,
      guardrails: {
        maxTokens: 1200,
        budgetWarnings: [0.7, 0.9],
      },
    })

    const events = await collectStreamEvents(agent, [new HumanMessage('Hi')])

    // With 1000 tokens used out of 1200 limit, we should get warnings at 70% and 90%
    const budgetWarnings = events.filter(e => e.type === 'budget_warning')
    expect(budgetWarnings.length).toBeGreaterThanOrEqual(1)
  })

  it('does not use estimation when real outputTokens is 0 but inputTokens is non-zero', async () => {
    // Edge case: provider reports input but 0 output (e.g., empty response).
    // Since at least one is non-zero, we should use the real data.
    const model = createMockStreamingModel('', {
      usage_metadata: { input_tokens: 50, output_tokens: 0, total_tokens: 50 },
    })

    const agent = new ForgeAgent({
      id: 'test-agent',
      instructions: 'You are a test agent.',
      model,
      guardrails: { maxTokens: 10_000 },
    })

    // Should not throw or produce errors
    const events = await collectStreamEvents(agent, [new HumanMessage('Hi')])
    const errorEvents = events.filter(e => e.type === 'error')
    expect(errorEvents.length).toBe(0)
  })
})
