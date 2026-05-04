/**
 * Shared, framework-agnostic structured output primitives.
 *
 * These types and base classes are consumed by:
 *   - `@dzupagent/agent-adapters` (StructuredOutputAdapter, registry-driven flow)
 *   - `@dzupagent/agent` (generateStructured, LangChain-style flow)
 *
 * Anything that depends on adapter-specific types (AdapterProviderId, AgentEvent,
 * ProviderAdapterRegistry) belongs in `@dzupagent/agent-adapters`. Anything that
 * depends on LangChain belongs in `@dzupagent/agent`. This module must remain
 * dependency-free beyond `zod` and core internals.
 */
import type { z } from 'zod'
import { ForgeError } from '../errors/index.js'
import {
  prepareStructuredOutputSchemaContract,
  unwrapStructuredEnvelope,
} from '../formats/structured-output-contract.js'
import type {
  StructuredOutputErrorSchemaRef,
  StructuredOutputFailureCategory,
  StructuredOutputSchemaContract,
} from '../formats/index.js'

// ---------------------------------------------------------------------------
// OutputSchema interface
// ---------------------------------------------------------------------------

/**
 * Schema that validates and parses raw LLM output into a typed value.
 *
 * Consumers (adapter or LangChain runtimes) call `parse(raw)` after each
 * model invocation and use `describe()` to inject format hints into prompts.
 */
export interface OutputSchema<T = unknown> {
  /** Schema name for error messages */
  name: string
  /** Optional stable schema hash for diagnostics and bug reports */
  schemaHash?: string | undefined
  /** Optional provider-facing JSON Schema for adapters that support native structured output. */
  outputSchema?: Record<string, unknown> | undefined
  /** Optional structured-output diagnostics aligned with the main throwing runtimes. */
  structuredOutput?: {
    requiresEnvelope: boolean
    requestSchema: StructuredOutputErrorSchemaRef
    responseSchema?: StructuredOutputErrorSchemaRef
    failureCategory?: StructuredOutputFailureCategory
  } | undefined
  /** Validate and parse raw output. Returns parsed value or throws. */
  parse(raw: string): T
  /** Get a description of the expected format (for prompt injection). */
  describe(): string
}

/**
 * Generic, runtime-agnostic parse result.
 *
 * Adapter and LangChain runtimes wrap this with their own provider-specific
 * fields (e.g. `providerId`, `events`).
 */
export interface ParseResult<T> {
  success: boolean
  value?: T | undefined
  raw: string
  schemaName: string
  schemaHash?: string | undefined
  parseAttempts: number
  error?: string | undefined
  failureCategory?: StructuredOutputFailureCategory | undefined
  structuredOutput?: {
    requiresEnvelope: boolean
    requestSchema: StructuredOutputErrorSchemaRef
    responseSchema?: StructuredOutputErrorSchemaRef
    failureCategory?: StructuredOutputFailureCategory
  } | undefined
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract JSON content from markdown fenced code blocks.
 * Matches ```json ... ``` or ``` ... ```.
 */
export function extractJsonFromMarkdown(text: string): string | null {
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  return match?.[1]?.trim() ?? null
}

/**
 * Convert a structured-output schema descriptor to an error-friendly schema ref.
 */
export function toSchemaRef(
  descriptor: StructuredOutputSchemaContract['requestSchemaDescriptor'],
): StructuredOutputErrorSchemaRef {
  return {
    name: descriptor.schemaName,
    hash: descriptor.schemaHash,
    preview: descriptor.schemaPreview,
    summary: descriptor.summary,
  }
}

/**
 * Build a Zod-backed validator that strips an optional structured-output envelope.
 */
export function createZodStructuredValidator<T>(
  contract: StructuredOutputSchemaContract,
): (data: unknown) => T {
  return (data: unknown) => {
    const parsed = contract.responseSchema.parse(data)
    return unwrapStructuredEnvelope<T>(parsed, contract.requiresEnvelope)
  }
}

// ---------------------------------------------------------------------------
// Built-in schemas
// ---------------------------------------------------------------------------

/**
 * JSON output schema — parses raw text as JSON, optionally extracting from
 * markdown code blocks, then validates with a user-supplied validator
 * (e.g. Zod `.parse`).
 */
export class JsonOutputSchema<T> implements OutputSchema<T> {
  readonly name: string
  readonly schemaHash: string | undefined
  readonly outputSchema: Record<string, unknown> | undefined
  readonly structuredOutput:
    | {
        requiresEnvelope: boolean
        requestSchema: StructuredOutputErrorSchemaRef
        responseSchema: StructuredOutputErrorSchemaRef
        failureCategory?: StructuredOutputFailureCategory
      }
    | undefined
  private readonly validator: (data: unknown) => T
  private readonly schemaDescription: string

  constructor(
    name: string,
    validator: (data: unknown) => T,
    schemaDescription?: string,
    metadata?: {
      schemaHash?: string
      outputSchema?: Record<string, unknown>
      structuredOutput?: {
        requiresEnvelope: boolean
        requestSchema: StructuredOutputErrorSchemaRef
        responseSchema: StructuredOutputErrorSchemaRef
        failureCategory?: StructuredOutputFailureCategory
      }
    },
  ) {
    this.name = name
    this.validator = validator
    this.schemaDescription = schemaDescription ?? 'valid JSON matching the expected schema'
    this.schemaHash = metadata?.schemaHash
    this.outputSchema = metadata?.outputSchema
    this.structuredOutput = metadata?.structuredOutput
  }

  static fromZod<T>(
    schema: z.ZodType<T>,
    options?: {
      schemaName?: string
      agentId?: string
      intent?: string
      provider?: 'generic' | 'openai'
      schemaDescription?: string
    },
  ): JsonOutputSchema<T> {
    const contract = prepareStructuredOutputSchemaContract(schema, {
      ...(options?.schemaName === undefined ? {} : { schemaName: options.schemaName }),
      agentId: options?.agentId ?? null,
      intent: options?.intent ?? null,
      schemaProvider: options?.provider ?? 'generic',
    })
    const schemaDescription = options?.schemaDescription
      ?? [
        `valid JSON matching schema "${contract.requestSchemaDescriptor.schemaName}"`,
        `(schema hash: ${contract.requestSchemaDescriptor.schemaHash})`,
        `JSON Schema: ${JSON.stringify(contract.responseSchemaDescriptor.jsonSchema)}`,
      ].join(' ')

    return new JsonOutputSchema(
      contract.requestSchemaDescriptor.schemaName,
      createZodStructuredValidator(contract),
      schemaDescription,
      {
        schemaHash: contract.requestSchemaDescriptor.schemaHash,
        outputSchema: contract.requestSchemaDescriptor.jsonSchema,
        structuredOutput: {
          requiresEnvelope: contract.requiresEnvelope,
          requestSchema: toSchemaRef(contract.requestSchemaDescriptor),
          responseSchema: toSchemaRef(contract.responseSchemaDescriptor),
        },
      },
    )
  }

  parse(raw: string): T {
    let parsed: unknown

    // Attempt 1: direct JSON.parse
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Attempt 2: extract from markdown code blocks
      const extracted = extractJsonFromMarkdown(raw)
      if (extracted === null) {
        throw new ForgeError({
          code: 'OUTPUT_PARSE_FAILED',
          message: `[${this.name}] Output is not valid JSON and contains no JSON code block`,
          recoverable: true,
        })
      }
      try {
        parsed = JSON.parse(extracted)
      } catch {
        throw new ForgeError({
          code: 'OUTPUT_PARSE_FAILED',
          message: `[${this.name}] Extracted code block is not valid JSON`,
          recoverable: true,
        })
      }
    }

    // Validate with the user-supplied validator
    return this.validator(parsed)
  }

  describe(): string {
    return `${this.schemaDescription}. Output raw JSON only — no markdown, no explanation.`
  }
}

/**
 * Regex output schema — matches raw output against a regular expression.
 */
export class RegexOutputSchema implements OutputSchema<RegExpMatchArray> {
  readonly name: string
  private readonly pattern: RegExp
  private readonly description: string

  constructor(name: string, pattern: RegExp, description?: string) {
    this.name = name
    this.pattern = pattern
    this.description = description ?? `text matching the pattern: ${pattern.source}`
  }

  parse(raw: string): RegExpMatchArray {
    const match = raw.match(this.pattern)
    if (!match) {
      throw new ForgeError({
        code: 'OUTPUT_PARSE_FAILED',
        message: `[${this.name}] Output does not match pattern: ${this.pattern.source}`,
        recoverable: true,
      })
    }
    return match
  }

  describe(): string {
    return this.description
  }
}
