import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import {
  AgentCardV2Schema,
  validateAgentCard,
} from '../agent-card-types.js'
import {
  zodToJsonSchema,
  jsonSchemaToZod,
  toOpenAISafeSchema,
  toStructuredOutputJsonSchema,
  describeStructuredOutputSchema,
  buildStructuredOutputSchemaName,
  attachStructuredOutputErrorContext,
  toOpenAIFunction,
  toOpenAITool,
  fromOpenAIFunction,
  toMCPToolDescriptor,
  fromMCPToolDescriptor,
} from '../tool-format-adapters.js'
import type { ToolSchemaDescriptor } from '../tool-format-adapters.js'
import {
  executeStructuredParseLoop,
  executeStructuredParseStreamLoop,
  buildStructuredOutputCorrectionPrompt,
  buildStructuredOutputExhaustedError,
} from '../structured-output-retry.js'
import type { OpenAIFunctionDefinition } from '../openai-function-types.js'
import { parseAgentsMdV2, generateAgentsMd, toLegacyConfig } from '../agents-md-parser-v2.js'

function extractOpenAIResponseSchema(
  config: ConstructorParameters<typeof ChatOpenAI>[0],
  schema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const model = new ChatOpenAI(config)
  const structured = model.withStructuredOutput(schema, { method: 'jsonSchema' }) as {
    first: { defaultOptions?: { response_format?: Record<string, unknown> } }
  }
  const responseFormat = structured.first.defaultOptions?.response_format as {
    json_schema?: { schema?: Record<string, unknown> }
  }

  return responseFormat.json_schema?.schema
}

function extractAnthropicStructuredConfig(
  schema: z.ZodType,
  name = 'extract',
): {
  tools?: Array<Record<string, unknown>>
  tool_choice?: Record<string, unknown>
  ls_structured_output_format?: {
    kwargs?: Record<string, unknown>
    schema?: Record<string, unknown>
  }
} | undefined {
  const model = new ChatAnthropic({
    apiKey: 'test',
    model: 'claude-3-5-sonnet-latest',
  })
  const structured = model.withStructuredOutput(schema, { name }) as {
    bound?: {
      first?: {
        config?: {
          tools?: Array<Record<string, unknown>>
          tool_choice?: Record<string, unknown>
          ls_structured_output_format?: {
            kwargs?: Record<string, unknown>
            schema?: Record<string, unknown>
          }
        }
      }
    }
  }

  return structured.bound?.first?.config
}

// =========================================================================
// Agent Card V2 validation
// =========================================================================

describe('AgentCardV2Schema', () => {
  const validCard = {
    name: 'TestAgent',
    description: 'A test agent',
    url: 'https://example.com/agent',
    version: '1.0.0',
    provider: { organization: 'TestCo', url: 'https://testco.com' },
    capabilities: [
      {
        name: 'code-review',
        description: 'Reviews code for issues',
        inputSchema: { type: 'object', properties: { code: { type: 'string' } } },
      },
    ],
    skills: [
      { id: 'skill-1', name: 'Linting', description: 'Lint code', tags: ['code', 'quality'] },
    ],
    authentication: {
      schemes: [{ type: 'bearer' as const }],
    },
    defaultInputModes: ['text' as const],
    defaultOutputModes: ['text' as const, 'file' as const],
    sla: { maxLatencyMs: 5000, maxCostCents: 10, uptimeRatio: 0.99 },
    metadata: { custom: 'value' },
  }

  it('validates a fully populated agent card', () => {
    const result = AgentCardV2Schema.safeParse(validCard)
    expect(result.success).toBe(true)
  })

  it('validates a minimal agent card', () => {
    const result = AgentCardV2Schema.safeParse({
      name: 'Min',
      description: 'Minimal',
      url: 'https://example.com',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a card with missing required fields', () => {
    const result = AgentCardV2Schema.safeParse({ name: 'NoUrl' })
    expect(result.success).toBe(false)
  })

  it('rejects a card with invalid URL', () => {
    const result = AgentCardV2Schema.safeParse({
      name: 'Bad',
      description: 'Bad url',
      url: 'not-a-url',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid content mode', () => {
    const result = AgentCardV2Schema.safeParse({
      name: 'Bad',
      description: 'Bad mode',
      url: 'https://example.com',
      defaultInputModes: ['hologram'],
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid SLA uptimeRatio > 1', () => {
    const result = AgentCardV2Schema.safeParse({
      name: 'Bad',
      description: 'Bad sla',
      url: 'https://example.com',
      sla: { uptimeRatio: 1.5 },
    })
    expect(result.success).toBe(false)
  })
})

describe('validateAgentCard', () => {
  it('returns valid: true with parsed card on success', () => {
    const result = validateAgentCard({
      name: 'Agent',
      description: 'Desc',
      url: 'https://example.com',
    })
    expect(result.valid).toBe(true)
    expect(result.card).toBeDefined()
    expect(result.card!.name).toBe('Agent')
    expect(result.errors).toBeUndefined()
  })

  it('returns valid: false with error messages on failure', () => {
    const result = validateAgentCard({ name: '' })
    expect(result.valid).toBe(false)
    expect(result.errors).toBeDefined()
    expect(result.errors!.length).toBeGreaterThan(0)
  })
})

// =========================================================================
// zodToJsonSchema
// =========================================================================

describe('zodToJsonSchema', () => {
  it('converts z.object with string/number/boolean fields', () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
      active: z.boolean(),
    })
    const json = zodToJsonSchema(schema)

    expect(json).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
        active: { type: 'boolean' },
      },
      required: ['name', 'age', 'active'],
    })
  })

  it('handles optional fields', () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    })
    const json = zodToJsonSchema(schema)

    expect(json['required']).toEqual(['required'])
    const props = json['properties'] as Record<string, unknown>
    expect(props['optional']).toEqual({ type: 'string' })
  })

  it('converts z.array', () => {
    const schema = z.object({
      tags: z.array(z.string()),
    })
    const json = zodToJsonSchema(schema)
    const props = json['properties'] as Record<string, Record<string, unknown>>
    expect(props['tags']).toEqual({ type: 'array', items: { type: 'string' } })
  })

  it('converts z.enum', () => {
    const schema = z.object({
      status: z.enum(['active', 'inactive', 'pending']),
    })
    const json = zodToJsonSchema(schema)
    const props = json['properties'] as Record<string, Record<string, unknown>>
    expect(props['status']).toEqual({
      type: 'string',
      enum: ['active', 'inactive', 'pending'],
    })
  })

  it('handles nested objects', () => {
    const schema = z.object({
      nested: z.object({
        value: z.number(),
      }),
    })
    const json = zodToJsonSchema(schema)
    const props = json['properties'] as Record<string, Record<string, unknown>>
    expect(props['nested']).toEqual({
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
    })
  })
})

// =========================================================================
// toOpenAISafeSchema
// =========================================================================

describe('toOpenAISafeSchema', () => {
  it('strips string length constraints', () => {
    const schema = z.object({ title: z.string().min(1).max(500) })
    const safe = toOpenAISafeSchema(schema)
    // Should accept any string, not just length 1-500
    expect(safe.safeParse({ title: '' }).success).toBe(true)
    expect(safe.safeParse({ title: 'a'.repeat(1000) }).success).toBe(true)
  })

  it('strips array item constraints', () => {
    const schema = z.object({ tags: z.array(z.string()).min(1).max(20) })
    const safe = toOpenAISafeSchema(schema)
    expect(safe.safeParse({ tags: [] }).success).toBe(true)
    expect(safe.safeParse({ tags: Array(50).fill('x') }).success).toBe(true)
  })

  it('strips number range constraints', () => {
    const schema = z.object({ score: z.number().min(0).max(1) })
    const safe = toOpenAISafeSchema(schema)
    expect(safe.safeParse({ score: -1 }).success).toBe(true)
    expect(safe.safeParse({ score: 99 }).success).toBe(true)
  })

  it('strips .int().positive() from number', () => {
    const schema = z.object({ count: z.number().int().positive() })
    const safe = toOpenAISafeSchema(schema)
    expect(safe.safeParse({ count: -5 }).success).toBe(true)
    expect(safe.safeParse({ count: 1.5 }).success).toBe(true)
  })

  it('preserves nullable fields', () => {
    const schema = z.object({ notes: z.string().nullable() })
    const safe = toOpenAISafeSchema(schema)
    expect(safe.safeParse({ notes: null }).success).toBe(true)
    expect(safe.safeParse({ notes: 'hi' }).success).toBe(true)
  })

  it('preserves optional fields', () => {
    const schema = z.object({ label: z.string().max(100).optional() })
    const safe = toOpenAISafeSchema(schema)
    expect(safe.safeParse({}).success).toBe(true)
    expect(safe.safeParse({ label: 'x'.repeat(500) }).success).toBe(true)
  })

  it('preserves enum values', () => {
    const schema = z.object({ priority: z.enum(['LOW', 'HIGH']) })
    const safe = toOpenAISafeSchema(schema)
    expect(safe.safeParse({ priority: 'LOW' }).success).toBe(true)
    expect(safe.safeParse({ priority: 'INVALID' }).success).toBe(false)
  })

  it('handles nested objects', () => {
    const schema = z.object({
      step: z.object({
        description: z.string().min(1).max(10000),
        result: z.string().max(10000).nullable(),
      }),
    })
    const safe = toOpenAISafeSchema(schema)
    expect(safe.safeParse({ step: { description: '', result: null } }).success).toBe(true)
  })

  it('handles arrays of objects', () => {
    const schema = z.array(z.object({ name: z.string().max(200) }))
    const safe = toOpenAISafeSchema(schema)
    expect(safe.safeParse([{ name: 'x'.repeat(500) }]).success).toBe(true)
    expect(safe.safeParse([]).success).toBe(true)
  })

  it('original schema still enforces constraints', () => {
    const schema = z.object({ title: z.string().min(1).max(5) })
    const safe = toOpenAISafeSchema(schema)
    // Safe schema accepts anything
    expect(safe.safeParse({ title: 'toolong' }).success).toBe(true)
    // Original still rejects
    expect(schema.safeParse({ title: 'toolong' }).success).toBe(false)
  })
})

describe('toStructuredOutputJsonSchema', () => {
  it('uses Zod built-in JSON Schema conversion and canonicalizes output', () => {
    const schema = z.object({
      name: z.string(),
      details: z.object({
        count: z.number(),
      }),
      notes: z.string().nullable(),
    })

    const jsonSchema = toStructuredOutputJsonSchema(schema)

    expect(jsonSchema).toEqual({
      additionalProperties: false,
      properties: {
        details: {
          additionalProperties: false,
          properties: {
            count: {
              type: 'number',
            },
          },
          required: ['count'],
          type: 'object',
        },
        name: {
          type: 'string',
        },
        notes: {
          anyOf: [
            { type: 'string' },
            { type: 'null' },
          ],
        },
      },
      required: ['name', 'details', 'notes'],
      type: 'object',
    })
  })

  it('applies the OpenAI-safe conversion before generating provider schema', () => {
    const schema = z.object({
      title: z.string().min(1).max(100),
      tags: z.array(z.string()).min(1).max(5),
    })

    const jsonSchema = toStructuredOutputJsonSchema(schema, { provider: 'openai' })
    const properties = jsonSchema['properties'] as Record<string, Record<string, unknown>>

    expect(properties['title']).toEqual({ type: 'string' })
    expect(properties['tags']).toEqual({ type: 'array', items: { type: 'string' } })
  })
})

describe('describeStructuredOutputSchema', () => {
  it('returns stable schema hashes and useful summary metadata', () => {
    const schema = z.object({
      status: z.enum(['OPEN', 'CLOSED']),
      items: z.array(z.object({
        id: z.string(),
      })),
      notes: z.string().nullable(),
    })

    const descriptor = describeStructuredOutputSchema(schema, {
      schemaName: 'TicketList',
      provider: 'openai',
      previewChars: 80,
    })

    expect(descriptor.schemaName).toBe('TicketList')
    expect(descriptor.provider).toBe('openai')
    expect(descriptor.schemaHash).toMatch(/^[a-f0-9]{16}$/)
    expect(descriptor.summary.topLevelType).toBe('object')
    expect(descriptor.summary.topLevelAdditionalProperties).toBe(false)
    expect(descriptor.summary.totalProperties).toBeGreaterThanOrEqual(4)
    expect(descriptor.summary.totalRequired).toBeGreaterThanOrEqual(3)
    expect(descriptor.summary.enumCount).toBeGreaterThanOrEqual(1)
    expect(descriptor.summary.nullableCount).toBeGreaterThanOrEqual(1)
    expect(descriptor.schemaPreview.length).toBeLessThanOrEqual(83)
  })
})

describe('buildStructuredOutputSchemaName', () => {
  it('builds stable names from agent id and intent', () => {
    expect(buildStructuredOutputSchemaName({
      agentId: 'requirement-extractor',
      intent: 'generation:requirement-extraction',
      requiresEnvelope: true,
    })).toBe('requirement-extractor.generation.requirement.extraction.envelope')
  })

  it('falls back to generic defaults when inputs are missing', () => {
    expect(buildStructuredOutputSchemaName({})).toBe('agent.structured.output')
  })
})

describe('attachStructuredOutputErrorContext', () => {
  it('attaches stable schema diagnostics to the thrown error', () => {
    const requestSchema = describeStructuredOutputSchema(z.object({
      result: z.array(z.object({
        id: z.string(),
      })),
    }), {
      schemaName: 'requirement-extractor.generation.requirement.extraction.envelope',
      provider: 'openai',
      previewChars: 120,
    })
    const responseSchema = describeStructuredOutputSchema(z.object({
      result: z.array(z.object({
        id: z.string(),
      })),
    }), {
      schemaName: 'requirement-extractor.generation.requirement.extraction.envelope.response',
      provider: 'generic',
      previewChars: 120,
    })

    const enriched = attachStructuredOutputErrorContext(
      new Error('Invalid schema for response_format'),
      {
        agentId: 'requirement-extractor',
        intent: 'generation:requirement-extraction',
        provider: 'openai',
        model: 'gpt-4.1-mini',
        failureCategory: 'provider_execution_failed',
        requiresEnvelope: true,
        messageCount: 2,
        requestSchema,
        responseSchema,
      },
    )

    expect(enriched).toMatchObject({
      message: 'Invalid schema for response_format',
      agentId: 'requirement-extractor',
      intent: 'generation:requirement-extraction',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      failureCategory: 'provider_execution_failed',
      schemaName: 'requirement-extractor.generation.requirement.extraction.envelope',
      messageCount: 2,
    })
    expect((enriched as Error & { schemaHash?: string }).schemaHash).toMatch(/^[a-f0-9]{16}$/)
    expect(enriched).toHaveProperty('structuredOutput.requestSchema.hash')
    expect(enriched).toHaveProperty('structuredOutput.responseSchema.hash')
    expect(enriched).toHaveProperty('structuredOutput.failureCategory', 'provider_execution_failed')
  })
})

describe('structured output retry helpers', () => {
  it('retries until parsing succeeds', async () => {
    const result = await executeStructuredParseLoop({
      initialState: { value: 'bad' },
      maxRetries: 2,
      invoke: async (state) => ({ raw: state.value, meta: 'meta' }),
      parse: (raw) => raw === 'ok'
        ? { success: true as const, data: { ok: true } }
        : { success: false as const, error: 'bad output' },
      onRetryState: () => ({ value: 'ok' }),
    })

    expect(result).toMatchObject({
      success: true,
      data: { ok: true },
      retries: 1,
      raw: 'ok',
      meta: 'meta',
    })
  })

  it('returns failure metadata when retries are exhausted', async () => {
    const result = await executeStructuredParseLoop({
      initialState: { value: 'bad' },
      maxRetries: 1,
      invoke: async (state) => ({ raw: state.value, meta: 42 }),
      parse: () => ({ success: false as const, error: 'still bad' }),
      onRetryState: () => ({ value: 'bad-again' }),
    })

    expect(result).toEqual({
      success: false,
      retries: 1,
      state: { value: 'bad-again' },
      lastError: 'still bad',
      lastRaw: 'bad-again',
      meta: 42,
    })
  })

  it('supports streamed retries while preserving yielded events', async () => {
    const items: Array<unknown> = []

    for await (const item of executeStructuredParseStreamLoop({
      initialState: { value: 'bad' },
      maxRetries: 1,
      invoke: async function* (state) {
        yield `started:${state.value}`
        return { raw: state.value, meta: 'stream-meta' }
      },
      parse: (raw) => raw === 'ok'
        ? { success: true as const, data: { ok: true } }
        : { success: false as const, error: 'bad streamed output' },
      onRetryState: () => ({ value: 'ok' }),
    })) {
      items.push(item)
    }

    expect(items).toEqual([
      { type: 'event', event: 'started:bad' },
      { type: 'event', event: 'started:ok' },
      {
        type: 'result',
        result: {
          success: true,
          data: { ok: true },
          raw: 'ok',
          retries: 1,
          state: { value: 'ok' },
          meta: 'stream-meta',
        },
      },
    ])
  })

  it('builds standardized correction and exhausted messages', () => {
    expect(buildStructuredOutputCorrectionPrompt({
      schemaName: 'AnswerSchema',
      schemaHash: 'abcd1234efef5678',
      description: 'valid JSON only',
    }, 'missing field')).toContain('AnswerSchema')
    expect(buildStructuredOutputCorrectionPrompt({
      schemaName: 'AnswerSchema',
      schemaHash: 'abcd1234efef5678',
      description: 'valid JSON only',
    }, 'missing field')).toContain('abcd1234efef5678')

    expect(buildStructuredOutputExhaustedError({
      schemaName: 'AnswerSchema',
      schemaHash: 'abcd1234efef5678',
    }, 3)).toBe('Failed to parse output matching schema "AnswerSchema" (abcd1234efef5678) after 3 attempts')
  })
})

describe('OpenAI structured-output contract', () => {
  it('demonstrates that LangChain jsonSchema mode sends raw Zod internals when given a Zod schema', () => {
    const schema = z.object({
      answer: z.number(),
    })
    const model = new ChatOpenAI({
      apiKey: 'test',
      model: 'gpt-4o-mini',
    })
    const structured = model.withStructuredOutput(schema, { method: 'jsonSchema' }) as {
      first: { defaultOptions?: { response_format?: Record<string, unknown> } }
    }
    const responseFormat = structured.first.defaultOptions?.response_format as {
      json_schema?: { schema?: Record<string, unknown> }
    }

    expect(responseFormat.json_schema?.schema).toHaveProperty('def')
    expect(responseFormat.json_schema?.schema).toHaveProperty('type', 'object')
  })

  it('produces a real JSON Schema payload when given the provider-safe JSON Schema object', () => {
    const schema = z.object({
      answer: z.number(),
    })
    const providerSchema = toStructuredOutputJsonSchema(schema, { provider: 'openai' })
    const model = new ChatOpenAI({
      apiKey: 'test',
      model: 'gpt-4o-mini',
    })
    const structured = model.withStructuredOutput(providerSchema, { method: 'jsonSchema' }) as {
      first: { defaultOptions?: { response_format?: Record<string, unknown> } }
    }
    const responseFormat = structured.first.defaultOptions?.response_format as {
      json_schema?: { schema?: Record<string, unknown> }
    }

    expect(responseFormat.json_schema?.schema).toEqual({
      additionalProperties: false,
      properties: {
        answer: {
          type: 'number',
        },
      },
      required: ['answer'],
      type: 'object',
    })
    expect(responseFormat.json_schema?.schema).not.toHaveProperty('def')
  })

  it.each([
    {
      label: 'OpenAI',
      config: {
        apiKey: 'test',
        model: 'gpt-4o-mini',
      },
    },
    {
      label: 'OpenRouter',
      config: {
        apiKey: 'test',
        model: 'openai/gpt-4o-mini',
        configuration: { baseURL: 'https://openrouter.ai/api/v1' },
      },
    },
    {
      label: 'Google OpenAI-compatible',
      config: {
        apiKey: 'test',
        model: 'gemini-2.5-pro',
        configuration: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
      },
    },
    {
      label: 'Custom OpenAI-compatible gateway',
      config: {
        apiKey: 'test',
        model: 'gateway/gpt-4o-mini',
        configuration: { baseURL: 'https://gateway.example/v1' },
      },
    },
  ])('keeps provider-safe JSON Schema payload stable for $label ChatOpenAI-compatible transport', ({ config }) => {
    const schema = z.object({
      answer: z.number().min(0).max(100),
      tags: z.array(z.string()).min(1).max(5),
    })
    const providerSchema = toStructuredOutputJsonSchema(schema, { provider: 'openai' })
    const model = new ChatOpenAI(config)
    const structured = model.withStructuredOutput(providerSchema, { method: 'jsonSchema' }) as {
      first: { defaultOptions?: { response_format?: Record<string, unknown> } }
    }
    const responseFormat = structured.first.defaultOptions?.response_format as {
      json_schema?: { schema?: Record<string, unknown> }
    }

    expect(responseFormat.json_schema?.schema).toEqual(providerSchema)
    expect(responseFormat.json_schema?.schema).not.toHaveProperty('def')
    expect(responseFormat.json_schema?.schema).not.toHaveProperty('properties.answer.minimum')
  })

  it.each([
    {
      label: 'envelope-backed top-level array',
      schema: z.object({
        result: z.array(z.object({
          id: z.string(),
          priority: z.enum(['HIGH', 'LOW']),
        })),
      }),
      verify: (providerSchema: Record<string, unknown>) => {
        expect(providerSchema).toEqual({
          additionalProperties: false,
          properties: {
            result: {
              items: {
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  priority: {
                    enum: ['HIGH', 'LOW'],
                    type: 'string',
                  },
                },
                required: ['id', 'priority'],
                type: 'object',
              },
              type: 'array',
            },
          },
          required: ['result'],
          type: 'object',
        })
      },
    },
    {
      label: 'nested nullable arrays-of-objects',
      schema: z.object({
        metadata: z.object({
          notes: z.string().nullable(),
          items: z.array(z.object({
            id: z.string(),
            tags: z.array(z.string()).min(1).max(5),
          })),
        }),
      }),
      verify: (providerSchema: Record<string, unknown>) => {
        expect(providerSchema).toMatchObject({
          additionalProperties: false,
          properties: {
            metadata: {
              additionalProperties: false,
              properties: {
                notes: {
                  anyOf: [
                    { type: 'string' },
                    { type: 'null' },
                  ],
                },
                items: {
                  type: 'array',
                  items: {
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string' },
                      tags: {
                        items: { type: 'string' },
                        type: 'array',
                      },
                    },
                    required: ['id', 'tags'],
                    type: 'object',
                  },
                },
              },
              required: ['notes', 'items'],
              type: 'object',
            },
          },
          required: ['metadata'],
          type: 'object',
        })
        expect(JSON.stringify(providerSchema)).not.toContain('minItems')
        expect(JSON.stringify(providerSchema)).not.toContain('maxItems')
      },
    },
    {
      label: 'stripped scalar constraints',
      schema: z.object({
        title: z.string().min(1).max(100),
        score: z.number().min(0).max(1),
      }),
      verify: (providerSchema: Record<string, unknown>) => {
        expect(providerSchema).toEqual({
          additionalProperties: false,
          properties: {
            score: { type: 'number' },
            title: { type: 'string' },
          },
          required: ['title', 'score'],
          type: 'object',
        })
        expect(JSON.stringify(providerSchema)).not.toContain('minimum')
        expect(JSON.stringify(providerSchema)).not.toContain('maximum')
        expect(JSON.stringify(providerSchema)).not.toContain('minLength')
        expect(JSON.stringify(providerSchema)).not.toContain('maxLength')
      },
    },
  ])('keeps edge-case provider-safe schema stable across OpenAI-compatible transports for $label', ({ schema, verify }) => {
    const providerSchema = toStructuredOutputJsonSchema(schema, { provider: 'openai' })

    const openAiSchema = extractOpenAIResponseSchema({
      apiKey: 'test',
      model: 'gpt-4o-mini',
    }, providerSchema)
    const openRouterSchema = extractOpenAIResponseSchema({
      apiKey: 'test',
      model: 'openai/gpt-4o-mini',
      configuration: { baseURL: 'https://openrouter.ai/api/v1' },
    }, providerSchema)
    const googleSchema = extractOpenAIResponseSchema({
      apiKey: 'test',
      model: 'gemini-2.5-pro',
      configuration: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
    }, providerSchema)
    const customGatewaySchema = extractOpenAIResponseSchema({
      apiKey: 'test',
      model: 'gateway/gpt-4o-mini',
      configuration: { baseURL: 'https://gateway.example/v1' },
    }, providerSchema)

    expect(openAiSchema).toEqual(providerSchema)
    expect(openRouterSchema).toEqual(providerSchema)
    expect(googleSchema).toEqual(providerSchema)
    expect(customGatewaySchema).toEqual(providerSchema)
    verify(providerSchema)
  })
})

describe('Anthropic structured-output contract', () => {
  it('binds a native tool definition with real JSON Schema and explicit tool choice', () => {
    const schema = z.object({
      answer: z.string(),
      score: z.number(),
    })
    const config = extractAnthropicStructuredConfig(schema)

    expect(config?.tool_choice).toEqual({ type: 'tool', name: 'extract' })
    expect(config?.tools).toEqual([
      {
        name: 'extract',
        description: 'A function available to call.',
        input_schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {
            answer: { type: 'string' },
            score: { type: 'number' },
          },
          required: ['answer', 'score'],
          additionalProperties: false,
        },
      },
    ])
    expect(config?.ls_structured_output_format).toEqual({
      kwargs: { method: 'functionCalling' },
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          answer: { type: 'string' },
          score: { type: 'number' },
        },
        required: ['answer', 'score'],
        additionalProperties: false,
      },
    })
  })

  it.each([
    {
      label: 'envelope-backed top-level array',
      schema: z.object({
        result: z.array(z.object({
          id: z.string(),
          priority: z.enum(['HIGH', 'LOW']),
        })),
      }),
      verify: (inputSchema: Record<string, unknown>) => {
        expect(inputSchema).toMatchObject({
          type: 'object',
          additionalProperties: false,
          required: ['result'],
          properties: {
            result: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'priority'],
                properties: {
                  id: { type: 'string' },
                  priority: {
                    type: 'string',
                    enum: ['HIGH', 'LOW'],
                  },
                },
              },
            },
          },
        })
      },
    },
    {
      label: 'nested nullable object',
      schema: z.object({
        metadata: z.object({
          notes: z.string().nullable(),
          owner: z.object({
            id: z.string(),
          }),
        }),
      }),
      verify: (inputSchema: Record<string, unknown>) => {
        expect(inputSchema).toMatchObject({
          type: 'object',
          additionalProperties: false,
          required: ['metadata'],
          properties: {
            metadata: {
              type: 'object',
              additionalProperties: false,
              required: ['notes', 'owner'],
              properties: {
                notes: {
                  anyOf: [
                    { type: 'string' },
                    { type: 'null' },
                  ],
                },
                owner: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id'],
                  properties: {
                    id: { type: 'string' },
                  },
                },
              },
            },
          },
        })
      },
    },
  ])('keeps native tool schema stable for $label', ({ schema, verify }) => {
    const config = extractAnthropicStructuredConfig(schema)
    const inputSchema = config?.tools?.[0]?.['input_schema'] as Record<string, unknown> | undefined

    expect(config?.tool_choice).toEqual({ type: 'tool', name: 'extract' })
    expect(config?.ls_structured_output_format?.kwargs).toEqual({ method: 'functionCalling' })
    expect(inputSchema).toBeDefined()
    expect(inputSchema).not.toHaveProperty('def')
    verify(inputSchema!)
  })
})

// =========================================================================
// jsonSchemaToZod
// =========================================================================

describe('jsonSchemaToZod', () => {
  it('converts basic types', () => {
    const strSchema = jsonSchemaToZod({ type: 'string' })
    expect(strSchema.safeParse('hello').success).toBe(true)
    expect(strSchema.safeParse(123).success).toBe(false)

    const numSchema = jsonSchemaToZod({ type: 'number' })
    expect(numSchema.safeParse(42).success).toBe(true)

    const boolSchema = jsonSchemaToZod({ type: 'boolean' })
    expect(boolSchema.safeParse(true).success).toBe(true)
  })

  it('converts integer to z.number', () => {
    const schema = jsonSchemaToZod({ type: 'integer' })
    expect(schema.safeParse(42).success).toBe(true)
  })

  it('converts arrays', () => {
    const schema = jsonSchemaToZod({
      type: 'array',
      items: { type: 'string' },
    })
    expect(schema.safeParse(['a', 'b']).success).toBe(true)
    expect(schema.safeParse([1, 2]).success).toBe(false)
  })

  it('converts objects with required fields', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
    })
    expect(schema.safeParse({ name: 'Alice' }).success).toBe(true)
    expect(schema.safeParse({ age: 30 }).success).toBe(false) // name is required
    expect(schema.safeParse({ name: 'Alice', age: 30 }).success).toBe(true)
  })

  it('converts enum', () => {
    const schema = jsonSchemaToZod({
      type: 'string',
      enum: ['a', 'b', 'c'],
    })
    expect(schema.safeParse('a').success).toBe(true)
    expect(schema.safeParse('d').success).toBe(false)
  })
})

describe('zodToJsonSchema + jsonSchemaToZod round-trip', () => {
  it('round-trips a complex object schema', () => {
    const original = z.object({
      name: z.string(),
      count: z.number(),
      tags: z.array(z.string()),
      status: z.enum(['active', 'inactive']),
    })

    const jsonSchema = zodToJsonSchema(original)
    const roundTripped = jsonSchemaToZod(jsonSchema)

    const testData = { name: 'test', count: 5, tags: ['a'], status: 'active' }
    expect(roundTripped.safeParse(testData).success).toBe(true)

    const badData = { name: 'test', count: 'not-a-number', tags: ['a'], status: 'active' }
    expect(roundTripped.safeParse(badData).success).toBe(false)
  })
})

// =========================================================================
// OpenAI adapters
// =========================================================================

describe('toOpenAIFunction / fromOpenAIFunction', () => {
  const tool: ToolSchemaDescriptor = {
    name: 'search',
    description: 'Search for items',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    outputSchema: {
      type: 'object',
      properties: { results: { type: 'array' } },
    },
  }

  it('converts to OpenAI function definition', () => {
    const fn = toOpenAIFunction(tool)
    expect(fn.name).toBe('search')
    expect(fn.description).toBe('Search for items')
    expect(fn.parameters).toEqual(tool.inputSchema)
  })

  it('round-trips through OpenAI format', () => {
    const fn = toOpenAIFunction(tool)
    const back = fromOpenAIFunction(fn)
    expect(back.name).toBe(tool.name)
    expect(back.description).toBe(tool.description)
    expect(back.inputSchema).toEqual(tool.inputSchema)
  })

  it('handles missing description in fromOpenAIFunction', () => {
    const fn: OpenAIFunctionDefinition = {
      name: 'test',
      parameters: { type: 'object' },
    }
    const back = fromOpenAIFunction(fn)
    expect(back.description).toBe('')
  })
})

describe('toOpenAITool', () => {
  it('wraps function in tool definition', () => {
    const tool: ToolSchemaDescriptor = {
      name: 'read',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    }
    const result = toOpenAITool(tool)
    expect(result.type).toBe('function')
    expect(result.function.name).toBe('read')
  })
})

// =========================================================================
// MCP adapters
// =========================================================================

describe('toMCPToolDescriptor / fromMCPToolDescriptor', () => {
  const tool: ToolSchemaDescriptor = {
    name: 'git_status',
    description: 'Show git status',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object' },
  }

  it('converts to MCP descriptor (drops outputSchema)', () => {
    const mcp = toMCPToolDescriptor(tool)
    expect(mcp.name).toBe('git_status')
    expect(mcp.description).toBe('Show git status')
    expect(mcp.inputSchema).toEqual(tool.inputSchema)
    expect('outputSchema' in mcp).toBe(false)
  })

  it('round-trips through MCP format', () => {
    const mcp = toMCPToolDescriptor(tool)
    const back = fromMCPToolDescriptor(mcp)
    expect(back.name).toBe(tool.name)
    expect(back.description).toBe(tool.description)
    expect(back.inputSchema).toEqual(tool.inputSchema)
  })

  it('handles missing description in fromMCPToolDescriptor', () => {
    const back = fromMCPToolDescriptor({
      name: 'test',
      inputSchema: { type: 'object' },
    })
    expect(back.description).toBe('')
  })
})

// =========================================================================
// AGENTS.md V2 parser
// =========================================================================

describe('parseAgentsMdV2', () => {
  it('parses YAML front matter', () => {
    const content = `---
name: CodeReviewer
description: Reviews code for quality
version: 2.0.0
tags: [code, review, quality]
---

Some body content.`

    const doc = parseAgentsMdV2(content)
    expect(doc.metadata.name).toBe('CodeReviewer')
    expect(doc.metadata.description).toBe('Reviews code for quality')
    expect(doc.metadata.version).toBe('2.0.0')
    expect(doc.metadata.tags).toEqual(['code', 'review', 'quality'])
    expect(doc.rawContent).toBe(content)
  })

  it('parses capabilities section', () => {
    const content = `---
name: Agent
---

## Capabilities
- Code Review: Analyzes code for bugs and style issues
- Testing: Generates unit tests for functions
- Refactoring: Suggests code improvements`

    const doc = parseAgentsMdV2(content)
    expect(doc.capabilities).toHaveLength(3)
    expect(doc.capabilities![0]!.name).toBe('Code Review')
    expect(doc.capabilities![0]!.description).toBe('Analyzes code for bugs and style issues')
    expect(doc.capabilities![2]!.name).toBe('Refactoring')
  })

  it('parses memory section', () => {
    const content = `---
name: Agent
---

## Memory
namespaces: [conversations, lessons, conventions]
maxRecords: 1000`

    const doc = parseAgentsMdV2(content)
    expect(doc.memory).toBeDefined()
    expect(doc.memory!.namespaces).toEqual(['conversations', 'lessons', 'conventions'])
    expect(doc.memory!.maxRecords).toBe(1000)
  })

  it('parses security section with sub-headings', () => {
    const content = `---
name: Agent
---

## Security
### Allowed Tools
- read_file
- write_file
- search
### Blocked Tools
- rm_rf
- force_push`

    const doc = parseAgentsMdV2(content)
    expect(doc.security).toBeDefined()
    expect(doc.security!.allowedTools).toEqual(['read_file', 'write_file', 'search'])
    expect(doc.security!.blockedTools).toEqual(['rm_rf', 'force_push'])
  })

  it('parses security section with ! prefix convention', () => {
    const content = `---
name: Agent
---

## Security
- read_file
- write_file
- !delete_file`

    const doc = parseAgentsMdV2(content)
    expect(doc.security!.allowedTools).toEqual(['read_file', 'write_file'])
    expect(doc.security!.blockedTools).toEqual(['delete_file'])
  })

  it('handles content without front matter', () => {
    const content = `## Capabilities
- Coding: Write code`

    const doc = parseAgentsMdV2(content)
    expect(doc.metadata.name).toBe('')
    expect(doc.capabilities).toHaveLength(1)
  })

  it('handles empty content', () => {
    const doc = parseAgentsMdV2('')
    expect(doc.metadata.name).toBe('')
    expect(doc.capabilities).toBeUndefined()
    expect(doc.memory).toBeUndefined()
    expect(doc.security).toBeUndefined()
  })

  it('parses memory section with bullet-list namespaces', () => {
    const content = `---
name: Agent
---

## Memory
- conversations
- lessons`

    const doc = parseAgentsMdV2(content)
    expect(doc.memory).toBeDefined()
    expect(doc.memory!.namespaces).toEqual(['conversations', 'lessons'])
  })
})

// =========================================================================
// generateAgentsMd
// =========================================================================

describe('generateAgentsMd', () => {
  it('produces valid markdown with front matter', () => {
    const md = generateAgentsMd({
      metadata: { name: 'TestAgent', description: 'Does things', version: '1.0.0', tags: ['test'] },
      rawContent: '',
    })

    expect(md).toContain('---')
    expect(md).toContain('name: TestAgent')
    expect(md).toContain('description: Does things')
    expect(md).toContain('version: 1.0.0')
    expect(md).toContain('tags: [test]')
  })

  it('generates capabilities section', () => {
    const md = generateAgentsMd({
      metadata: { name: 'A' },
      capabilities: [{ name: 'Review', description: 'Reviews code' }],
      rawContent: '',
    })

    expect(md).toContain('## Capabilities')
    expect(md).toContain('- Review: Reviews code')
  })

  it('generates memory section', () => {
    const md = generateAgentsMd({
      metadata: { name: 'A' },
      memory: { namespaces: ['conv', 'lessons'], maxRecords: 500 },
      rawContent: '',
    })

    expect(md).toContain('## Memory')
    expect(md).toContain('namespaces: [conv, lessons]')
    expect(md).toContain('maxRecords: 500')
  })

  it('generates security section', () => {
    const md = generateAgentsMd({
      metadata: { name: 'A' },
      security: { allowedTools: ['read'], blockedTools: ['delete'] },
      rawContent: '',
    })

    expect(md).toContain('## Security')
    expect(md).toContain('### Allowed Tools')
    expect(md).toContain('- read')
    expect(md).toContain('### Blocked Tools')
    expect(md).toContain('- delete')
  })
})

// =========================================================================
// Round-trip: parse -> generate -> parse
// =========================================================================

describe('parseAgentsMdV2 -> generateAgentsMd -> parseAgentsMdV2 round-trip', () => {
  it('preserves metadata through round-trip', () => {
    const original = `---
name: RoundTripper
description: Tests round-tripping
version: 3.0.0
tags: [test, roundtrip]
---

## Capabilities
- Parse: Parses documents
- Generate: Generates output

## Memory
namespaces: [data, cache]
maxRecords: 200

## Security
### Allowed Tools
- read_file
### Blocked Tools
- rm_rf`

    const doc1 = parseAgentsMdV2(original)
    const generated = generateAgentsMd(doc1)
    const doc2 = parseAgentsMdV2(generated)

    // Metadata
    expect(doc2.metadata.name).toBe(doc1.metadata.name)
    expect(doc2.metadata.description).toBe(doc1.metadata.description)
    expect(doc2.metadata.version).toBe(doc1.metadata.version)
    expect(doc2.metadata.tags).toEqual(doc1.metadata.tags)

    // Capabilities
    expect(doc2.capabilities).toHaveLength(doc1.capabilities!.length)
    expect(doc2.capabilities![0]!.name).toBe(doc1.capabilities![0]!.name)
    expect(doc2.capabilities![0]!.description).toBe(doc1.capabilities![0]!.description)

    // Memory
    expect(doc2.memory!.namespaces).toEqual(doc1.memory!.namespaces)
    expect(doc2.memory!.maxRecords).toBe(doc1.memory!.maxRecords)

    // Security
    expect(doc2.security!.allowedTools).toEqual(doc1.security!.allowedTools)
    expect(doc2.security!.blockedTools).toEqual(doc1.security!.blockedTools)
  })
})

// =========================================================================
// toLegacyConfig backward compatibility
// =========================================================================

describe('toLegacyConfig', () => {
  it('converts v2 doc to legacy AgentsMdConfig', () => {
    const doc = parseAgentsMdV2(`---
name: Legacy
description: A legacy-compat agent
---

## Capabilities
- Lint: Lints code
- Format: Formats code

## Security
### Allowed Tools
- eslint
### Blocked Tools
- rm`)

    const legacy = toLegacyConfig(doc)

    expect(legacy.instructions).toContain('A legacy-compat agent')
    expect(legacy.instructions).toContain('Lint: Lints code')
    expect(legacy.instructions).toContain('Format: Formats code')
    expect(legacy.rules).toEqual([])
    expect(legacy.allowedTools).toEqual(['eslint'])
    expect(legacy.blockedTools).toEqual(['rm'])
  })

  it('produces valid AgentsMdConfig with no optional fields', () => {
    const doc = parseAgentsMdV2(`---
name: Minimal
---`)

    const legacy = toLegacyConfig(doc)
    expect(legacy.instructions).toEqual([])
    expect(legacy.rules).toEqual([])
    expect(legacy.allowedTools).toBeUndefined()
    expect(legacy.blockedTools).toBeUndefined()
  })
})
