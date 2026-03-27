import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  generateStructured,
  detectStrategy,
} from '../structured/structured-output-engine.js'
import type {
  StructuredLLM,
  StructuredLLMWithMeta,
} from '../structured/structured-output-engine.js'

/** Create a mock LLM that returns a fixed response. */
function mockLLM(response: string, modelName?: string): StructuredLLMWithMeta {
  return {
    model: modelName,
    invoke: async () => ({ content: response }),
  }
}

/** Create a mock LLM that returns different responses on successive calls. */
function mockLLMSequence(responses: string[], modelName?: string): StructuredLLMWithMeta {
  let callIndex = 0
  return {
    model: modelName,
    invoke: async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1]!
      callIndex++
      return { content: response }
    },
  }
}

const PersonSchema = z.object({
  name: z.string(),
  age: z.number(),
})

describe('detectStrategy', () => {
  it('detects anthropic-tool-use for Claude models', () => {
    expect(detectStrategy({ model: 'claude-3-sonnet', invoke: async () => ({ content: '' }) }))
      .toBe('anthropic-tool-use')
  })

  it('detects anthropic-tool-use for anthropic models', () => {
    expect(detectStrategy({ model: 'anthropic/claude-3', invoke: async () => ({ content: '' }) }))
      .toBe('anthropic-tool-use')
  })

  it('detects openai-json-schema for GPT models', () => {
    expect(detectStrategy({ model: 'gpt-4o', invoke: async () => ({ content: '' }) }))
      .toBe('openai-json-schema')
  })

  it('detects openai-json-schema for openai models', () => {
    expect(detectStrategy({ model: 'openai/gpt-4', invoke: async () => ({ content: '' }) }))
      .toBe('openai-json-schema')
  })

  it('defaults to generic-parse for unknown models', () => {
    expect(detectStrategy({ model: 'llama-3', invoke: async () => ({ content: '' }) }))
      .toBe('generic-parse')
  })

  it('defaults to generic-parse when no model name', () => {
    expect(detectStrategy({ invoke: async () => ({ content: '' }) }))
      .toBe('generic-parse')
  })
})

describe('generateStructured', () => {
  it('parses valid JSON output correctly', async () => {
    const llm = mockLLM('{"name": "Alice", "age": 30}')
    const result = await generateStructured(llm, [], {
      schema: PersonSchema,
      strategy: 'generic-parse',
    })

    expect(result.data).toEqual({ name: 'Alice', age: 30 })
    expect(result.strategy).toBe('generic-parse')
    expect(result.retries).toBe(0)
    expect(result.raw).toBe('{"name": "Alice", "age": 30}')
  })

  it('parses JSON from code blocks', async () => {
    const llm = mockLLM('```json\n{"name": "Bob", "age": 25}\n```')
    const result = await generateStructured(llm, [], {
      schema: PersonSchema,
      strategy: 'generic-parse',
    })

    expect(result.data).toEqual({ name: 'Bob', age: 25 })
  })

  it('retries on validation failure', async () => {
    const llm = mockLLMSequence([
      '{"name": "Alice"}',               // Missing age
      '{"name": "Alice", "age": 30}',    // Valid
    ])

    const result = await generateStructured(llm, [], {
      schema: PersonSchema,
      strategy: 'generic-parse',
      maxRetries: 2,
    })

    expect(result.data).toEqual({ name: 'Alice', age: 30 })
    expect(result.retries).toBe(1)
  })

  it('falls back through strategy chain', async () => {
    // First strategy (anthropic-tool-use) returns invalid JSON
    // generic-parse also gets invalid
    // fallback-prompt succeeds
    let callCount = 0
    const llm: StructuredLLMWithMeta = {
      model: 'claude-test',
      invoke: async () => {
        callCount++
        // First 3 calls fail (anthropic strategy: 1 initial + 2 retries)
        // Next 3 calls fail (generic strategy: 1 initial + 2 retries)
        // 7th call succeeds (fallback-prompt)
        if (callCount >= 7) {
          return { content: '{"name": "Charlie", "age": 40}' }
        }
        return { content: 'not json at all' }
      },
    }

    const result = await generateStructured(llm, [], {
      schema: PersonSchema,
      maxRetries: 2,
    })

    expect(result.data).toEqual({ name: 'Charlie', age: 40 })
    expect(result.strategy).toBe('fallback-prompt')
  })

  it('throws when max retries exceeded on all strategies', async () => {
    const llm = mockLLM('not json', 'unknown-model')

    await expect(
      generateStructured(llm, [], {
        schema: PersonSchema,
        maxRetries: 1,
      }),
    ).rejects.toThrow('Structured output extraction failed')
  })

  it('uses specified strategy when provided', async () => {
    const llm = mockLLM('{"name": "Dana", "age": 28}')
    const result = await generateStructured(llm, [], {
      schema: PersonSchema,
      strategy: 'fallback-prompt',
    })

    expect(result.strategy).toBe('fallback-prompt')
    expect(result.data).toEqual({ name: 'Dana', age: 28 })
  })

  it('passes messages to the LLM', async () => {
    const receivedMessages: unknown[][] = []
    const llm: StructuredLLM = {
      invoke: async (msgs) => {
        receivedMessages.push(msgs)
        return { content: '{"name": "Eve", "age": 22}' }
      },
    }

    await generateStructured(llm, [{ role: 'user', content: 'hi' }], {
      schema: PersonSchema,
      strategy: 'generic-parse',
    })

    expect(receivedMessages.length).toBe(1)
    expect(receivedMessages[0]).toEqual([{ role: 'user', content: 'hi' }])
  })
})
