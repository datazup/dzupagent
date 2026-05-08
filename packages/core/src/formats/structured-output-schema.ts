/**
 * Structured-output schema utilities — canonicalize, hash, summarize, and
 * attach error context for provider-specific structured-output contracts.
 *
 * These helpers normalize equivalent Zod schemas so they produce stable
 * hashes and previews across call sites, enabling reliable caching and
 * diagnostic correlation.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type {
  StructuredOutputErrorContextInput,
  StructuredOutputErrorSchemaRef,
  StructuredOutputSchemaDescriptor,
  StructuredOutputSchemaSummary,
} from './tool-format-types.js'

/**
 * Strip Zod constraints that OpenAI's structured outputs strict mode rejects.
 *
 * OpenAI's response_format JSON Schema does not support: minLength, maxLength,
 * minItems, maxItems, minimum, maximum, multipleOf, pattern.
 * LangChain's withStructuredOutput passes the Zod schema through zod-to-json-schema,
 * which emits these constraints — OpenAI rejects the call entirely.
 *
 * This wrapper unwraps constraint decorators from Zod nodes so the schema sent
 * to OpenAI only contains type information, while Zod still validates the response
 * after parsing (constraints remain in the caller's original schema).
 */
export function toOpenAISafeSchema<T extends z.ZodType>(schema: T): T {
  return stripZodConstraints(schema) as T
}

/**
 * Convert a Zod schema into a normalized JSON Schema suitable for prompting,
 * logging, hashing, and provider-specific structured-output contracts.
 *
 * The returned schema is canonicalized so equivalent schemas produce stable
 * hashes and previews across different call sites.
 */
export function toStructuredOutputJsonSchema(
  schema: z.ZodType,
  options?: { provider?: 'generic' | 'openai' },
): Record<string, unknown> {
  const provider = options?.provider ?? 'generic'
  const sourceSchema = provider === 'openai'
    ? toOpenAISafeSchema(schema)
    : schema

  const raw = z.toJSONSchema(sourceSchema) as Record<string, unknown>
  return canonicalizeJsonSchema(raw) as Record<string, unknown>
}

export function describeStructuredOutputSchema(
  schema: z.ZodType,
  options?: {
    schemaName?: string
    provider?: 'generic' | 'openai'
    previewChars?: number
  },
): StructuredOutputSchemaDescriptor {
  const provider = options?.provider ?? 'generic'
  const jsonSchema = toStructuredOutputJsonSchema(schema, { provider })
  const stable = JSON.stringify(jsonSchema)
  const previewChars = options?.previewChars ?? 600

  return {
    schemaName: options?.schemaName ?? 'output',
    provider,
    jsonSchema,
    schemaHash: createHash('sha256').update(stable).digest('hex').slice(0, 16),
    schemaPreview: stable.length > previewChars
      ? `${stable.slice(0, previewChars)}...`
      : stable,
    summary: summarizeJsonSchema(jsonSchema),
  }
}

export function buildStructuredOutputSchemaName(
  input: {
    agentId?: string | null
    intent?: string | null
    requiresEnvelope?: boolean
  },
): string {
  const agentId = input.agentId && input.agentId.trim().length > 0
    ? input.agentId
    : 'agent'
  const intentPart = input.intent
    ? input.intent.replace(/[^a-z0-9]+/gi, '.').replace(/^\.+|\.+$/g, '').toLowerCase()
    : 'structured.output'

  return input.requiresEnvelope
    ? `${agentId}.${intentPart}.envelope`
    : `${agentId}.${intentPart}`
}

export function attachStructuredOutputErrorContext(
  err: unknown,
  input: StructuredOutputErrorContextInput,
): Error {
  const error = err instanceof Error ? err : new Error(String(err))
  const requestSchema = toStructuredOutputErrorSchemaRef(input.requestSchema)
  const responseSchema = input.responseSchema
    ? toStructuredOutputErrorSchemaRef(input.responseSchema)
    : null

  Object.assign(error, {
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    ...(input.intent === undefined ? {} : { intent: input.intent }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.failureCategory === undefined ? {} : { failureCategory: input.failureCategory }),
    schemaName: requestSchema.name,
    schemaHash: requestSchema.hash,
    schemaPreview: requestSchema.preview,
    schemaTopLevelType: requestSchema.summary.topLevelType,
    schemaPropertyCount: requestSchema.summary.totalProperties,
    schemaRequiredCount: requestSchema.summary.totalRequired,
    ...(input.messageCount === undefined ? {} : { messageCount: input.messageCount }),
    structuredOutput: {
      ...(input.failureCategory === undefined ? {} : { failureCategory: input.failureCategory }),
      requiresEnvelope: input.requiresEnvelope ?? false,
      ...(responseSchema ? { responseSchema } : {}),
      requestSchema,
    },
  })

  return error
}

function stripZodConstraints(node: z.ZodType): z.ZodType {
  // ZodOptional — unwrap, strip inner, re-wrap
  if (node instanceof z.ZodOptional) {
    return stripZodConstraints(node.unwrap() as z.ZodType).optional()
  }

  // ZodNullable — unwrap, strip inner, re-wrap
  if (node instanceof z.ZodNullable) {
    return stripZodConstraints(node.unwrap() as z.ZodType).nullable()
  }

  // ZodObject — recurse into each property
  if (node instanceof z.ZodObject) {
    const shape = node.shape as Record<string, z.ZodType>
    const strippedShape: Record<string, z.ZodType> = {}
    for (const [key, value] of Object.entries(shape)) {
      strippedShape[key] = stripZodConstraints(value)
    }
    return z.object(strippedShape)
  }

  // ZodArray — recurse into element, drop min/max item constraints
  if (node instanceof z.ZodArray) {
    return z.array(stripZodConstraints(node.element as z.ZodType))
  }

  // ZodString — return plain string, drop minLength/maxLength/regex constraints
  if (node instanceof z.ZodString) {
    return z.string()
  }

  // ZodNumber — return plain number, drop min/max/int/positive constraints
  if (node instanceof z.ZodNumber) {
    return z.number()
  }

  // ZodBoolean, ZodEnum, ZodLiteral, ZodUnknown — pass through unchanged
  return node
}

function canonicalizeJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJsonSchema(entry))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const obj = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    if (key === '$schema') continue
    const normalized = canonicalizeJsonSchema(obj[key])
    if (normalized !== undefined) {
      result[key] = normalized
    }
  }
  return result
}

function toStructuredOutputErrorSchemaRef(
  descriptor: StructuredOutputSchemaDescriptor,
): StructuredOutputErrorSchemaRef {
  return {
    name: descriptor.schemaName,
    hash: descriptor.schemaHash,
    preview: descriptor.schemaPreview,
    summary: descriptor.summary,
  }
}

function summarizeJsonSchema(schema: Record<string, unknown>): StructuredOutputSchemaSummary {
  const summary: StructuredOutputSchemaSummary = {
    topLevelType: typeof schema['type'] === 'string' ? schema['type'] as string : null,
    topLevelAdditionalProperties: typeof schema['additionalProperties'] === 'boolean'
      ? schema['additionalProperties'] as boolean
      : null,
    totalProperties: 0,
    totalRequired: 0,
    enumCount: 0,
    nullableCount: 0,
    maxDepth: 0,
  }

  function walk(node: unknown, depth: number): void {
    if (!node || typeof node !== 'object') return
    summary.maxDepth = Math.max(summary.maxDepth, depth)

    const obj = node as Record<string, unknown>
    const properties = obj['properties']
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      summary.totalProperties += Object.keys(properties as Record<string, unknown>).length
    }

    const required = obj['required']
    if (Array.isArray(required)) {
      summary.totalRequired += required.length
    }

    const enumValues = obj['enum']
    if (Array.isArray(enumValues) && enumValues.length > 0) {
      summary.enumCount += 1
    }

    const anyOf = obj['anyOf']
    if (Array.isArray(anyOf) && anyOf.some(
      (entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>)['type'] === 'null',
    )) {
      summary.nullableCount += 1
    }

    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) {
        for (const child of value) walk(child, depth + 1)
        continue
      }
      walk(value, depth + 1)
    }
  }

  walk(schema, 1)
  return summary
}
