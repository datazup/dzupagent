/**
 * Tests for extractTokenUsage and estimateTokens utilities.
 *
 * Covers all provider-specific metadata paths that LangChain uses
 * to report token counts: Anthropic, OpenAI, LangChain 0.3+ standardized,
 * and older tokenUsage format.
 */
import { describe, it, expect } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import { extractTokenUsage, estimateTokens } from '../llm/invoke.js'

/** Helper to build an AIMessage with arbitrary metadata fields. */
function makeAIMessage(overrides: {
  response_metadata?: Record<string, unknown>
  usage_metadata?: Record<string, unknown>
}): AIMessage {
  const msg = new AIMessage('test response')
  if (overrides.response_metadata) {
    ;(msg as AIMessage & { response_metadata: Record<string, unknown> }).response_metadata =
      overrides.response_metadata
  }
  if (overrides.usage_metadata) {
    ;(msg as AIMessage & { usage_metadata: Record<string, unknown> }).usage_metadata =
      overrides.usage_metadata
  }
  return msg
}

describe('extractTokenUsage', () => {
  it('extracts from LangChain 0.3+ top-level usage_metadata', () => {
    const msg = makeAIMessage({
      usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    })
    const usage = extractTokenUsage(msg)
    expect(usage.inputTokens).toBe(100)
    expect(usage.outputTokens).toBe(50)
    expect(usage.model).toBe('unknown')
  })

  it('extracts from Anthropic response_metadata.usage (input_tokens/output_tokens)', () => {
    const msg = makeAIMessage({
      response_metadata: {
        usage: { input_tokens: 200, output_tokens: 80 },
        model: 'claude-3-5-sonnet-20241022',
      },
    })
    const usage = extractTokenUsage(msg)
    expect(usage.inputTokens).toBe(200)
    expect(usage.outputTokens).toBe(80)
    expect(usage.model).toBe('claude-3-5-sonnet-20241022')
  })

  it('extracts from OpenAI response_metadata.usage (prompt_tokens/completion_tokens)', () => {
    const msg = makeAIMessage({
      response_metadata: {
        usage: { prompt_tokens: 300, completion_tokens: 120, total_tokens: 420 },
        model: 'gpt-4o',
      },
    })
    const usage = extractTokenUsage(msg)
    expect(usage.inputTokens).toBe(300)
    expect(usage.outputTokens).toBe(120)
    expect(usage.model).toBe('gpt-4o')
  })

  it('extracts from response_metadata.usage_metadata (nested)', () => {
    const msg = makeAIMessage({
      response_metadata: {
        usage_metadata: { input_tokens: 150, output_tokens: 60 },
      },
    })
    const usage = extractTokenUsage(msg)
    expect(usage.inputTokens).toBe(150)
    expect(usage.outputTokens).toBe(60)
  })

  it('extracts from older response_metadata.tokenUsage (camelCase)', () => {
    const msg = makeAIMessage({
      response_metadata: {
        tokenUsage: { promptTokens: 400, completionTokens: 200, totalTokens: 600 },
      },
    })
    const usage = extractTokenUsage(msg)
    expect(usage.inputTokens).toBe(400)
    expect(usage.outputTokens).toBe(200)
  })

  it('prefers top-level usage_metadata over response_metadata.usage', () => {
    const msg = makeAIMessage({
      usage_metadata: { input_tokens: 10, output_tokens: 5 },
      response_metadata: {
        usage: { input_tokens: 999, output_tokens: 888 },
      },
    })
    const usage = extractTokenUsage(msg)
    expect(usage.inputTokens).toBe(10)
    expect(usage.outputTokens).toBe(5)
  })

  it('uses modelName parameter when provided', () => {
    const msg = makeAIMessage({
      response_metadata: {
        usage: { input_tokens: 100, output_tokens: 50 },
        model: 'some-other-model',
      },
    })
    const usage = extractTokenUsage(msg, 'my-custom-model')
    expect(usage.model).toBe('my-custom-model')
  })

  it('falls back to response_metadata.model when no modelName given', () => {
    const msg = makeAIMessage({
      response_metadata: { model: 'from-meta' },
    })
    const usage = extractTokenUsage(msg)
    expect(usage.model).toBe('from-meta')
  })

  it('returns zeros when no usage data is available', () => {
    const msg = makeAIMessage({})
    const usage = extractTokenUsage(msg)
    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(0)
    expect(usage.model).toBe('unknown')
  })

  it('returns zeros for empty response_metadata', () => {
    const msg = makeAIMessage({ response_metadata: {} })
    const usage = extractTokenUsage(msg)
    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(0)
  })

  it('returns zeros when usage fields are not numbers', () => {
    const msg = makeAIMessage({
      response_metadata: {
        usage: { input_tokens: 'not-a-number', output_tokens: null },
      },
    })
    const usage = extractTokenUsage(msg)
    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(0)
  })

  it('handles partial usage_metadata (only one field present)', () => {
    // If only input_tokens is present but output_tokens is missing, we should
    // NOT match the top-level path and fall through to next path
    const msg = makeAIMessage({
      usage_metadata: { input_tokens: 100 },
      response_metadata: {
        usage: { input_tokens: 200, output_tokens: 80 },
      },
    })
    const usage = extractTokenUsage(msg)
    // Falls through to response_metadata.usage since usage_metadata is incomplete
    expect(usage.inputTokens).toBe(200)
    expect(usage.outputTokens).toBe(80)
  })
})

describe('estimateTokens', () => {
  it('estimates roughly 4 chars per token', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('rounds up for partial tokens', () => {
    expect(estimateTokens('abc')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('handles long text', () => {
    const text = 'a'.repeat(1000)
    expect(estimateTokens(text)).toBe(250)
  })
})
