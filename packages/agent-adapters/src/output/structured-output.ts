/**
 * StructuredOutputAdapter — wraps adapter execution with schema validation,
 * output parsing, and retry/fallback when output doesn't match expected format.
 *
 * Supports arbitrary output schemas (JSON with Zod validators, regex patterns,
 * or custom parsers). On parse failure, retries with a correction prompt, then
 * falls back to alternative providers if retries are exhausted.
 */

import { z } from 'zod'
import {
  ForgeError,
  executeStructuredParseLoop,
  executeStructuredParseStreamLoop,
  buildStructuredOutputCorrectionPrompt,
  buildStructuredOutputExhaustedError,
  prepareStructuredOutputSchemaContract,
  unwrapStructuredEnvelope,
} from '@dzupagent/core'
import type {
  DzupEventBus,
  StructuredOutputErrorSchemaRef,
  StructuredOutputFailureCategory,
  StructuredOutputSchemaContract,
} from '@dzupagent/core'

import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'
import type { AdapterRegistry } from '../registry/adapter-registry.js'

// ---------------------------------------------------------------------------
// Schema interfaces
// ---------------------------------------------------------------------------

/** Schema that validates and parses raw LLM output into a typed value. */
export interface OutputSchema<T = unknown> {
  /** Schema name for error messages */
  name: string
  /** Optional stable schema hash for diagnostics and bug reports */
  schemaHash?: string
  /** Optional provider-facing JSON Schema for adapters that support native structured output. */
  outputSchema?: Record<string, unknown>
  /** Optional structured-output diagnostics aligned with the main throwing runtimes. */
  structuredOutput?: {
    requiresEnvelope: boolean
    requestSchema: StructuredOutputErrorSchemaRef
    responseSchema?: StructuredOutputErrorSchemaRef
    failureCategory?: StructuredOutputFailureCategory
  }
  /** Validate and parse raw output. Returns parsed value or throws. */
  parse(raw: string): T
  /** Get a description of the expected format (for prompt injection) */
  describe(): string
}

// ---------------------------------------------------------------------------
// Config & result types
// ---------------------------------------------------------------------------

export interface StructuredOutputConfig {
  /** Max parse retries before fallback. Default 2 */
  maxRetries?: number | undefined
  /** Whether to inject format instructions into the prompt. Default true */
  injectFormatInstructions?: boolean | undefined
  /** Event bus for observability */
  eventBus?: DzupEventBus | undefined
}

export interface ParseResult<T> {
  success: boolean
  value?: T | undefined
  raw: string
  providerId: AdapterProviderId
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

export interface StructuredRunResult<T> {
  result: ParseResult<T>
  durationMs: number
  fallbackUsed: boolean
  events: AgentEvent[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract JSON content from markdown fenced code blocks.
 * Matches ```json ... ``` or ``` ... ```.
 */
function extractJsonFromMarkdown(text: string): string | null {
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  return match?.[1]?.trim() ?? null
}

function toSchemaRef(descriptor: StructuredOutputSchemaContract['requestSchemaDescriptor']): StructuredOutputErrorSchemaRef {
  return {
    name: descriptor.schemaName,
    hash: descriptor.schemaHash,
    preview: descriptor.schemaPreview,
    summary: descriptor.summary,
  }
}

function createZodStructuredValidator<T>(
  contract: StructuredOutputSchemaContract,
): (data: unknown) => T {
  return (data: unknown) => {
    const parsed = contract.responseSchema.parse(data)
    return unwrapStructuredEnvelope<T>(parsed, contract.requiresEnvelope)
  }
}

function withFailureCategory(
  structuredOutput: OutputSchema['structuredOutput'] | undefined,
  failureCategory: StructuredOutputFailureCategory | undefined,
): ParseResult<unknown>['structuredOutput'] | undefined {
  if (structuredOutput === undefined) {
    return undefined
  }
  if (failureCategory === undefined) {
    return structuredOutput
  }

  return {
    ...structuredOutput,
    failureCategory,
  }
}

function buildFailureResult<T>(
  input: {
    providerId: AdapterProviderId
    schema: OutputSchema<T>
    parseAttempts: number
    error: string
    failureCategory: StructuredOutputFailureCategory
  },
): ParseResult<T> {
  return {
    success: false,
    raw: '',
    providerId: input.providerId,
    schemaName: input.schema.name,
    ...(input.schema.schemaHash === undefined ? {} : { schemaHash: input.schema.schemaHash }),
    parseAttempts: input.parseAttempts,
    error: input.error,
    failureCategory: input.failureCategory,
    ...(input.schema.structuredOutput === undefined
      ? {}
      : {
          structuredOutput: withFailureCategory(
            input.schema.structuredOutput,
            input.failureCategory,
          ),
        }),
  }
}

/**
 * Execute an adapter via the registry fallback chain and collect all events.
 * Returns the completed event (if any) and all yielded events.
 */
async function collectExecution(
  registry: AdapterRegistry,
  input: AgentInput,
  task: TaskDescriptor,
): Promise<{ completed: AgentCompletedEvent | undefined; events: AgentEvent[] }> {
  const events: AgentEvent[] = []
  let completed: AgentCompletedEvent | undefined

  const gen = registry.executeWithFallback(input, task)
  for await (const event of gen) {
    events.push(event)
    if (event.type === 'adapter:completed') {
      completed = event
    }
  }

  return { completed, events }
}

class MissingCompletedStreamResultError extends Error {
  constructor() {
    super('Structured output streamed execution completed without adapter:completed result')
  }
}

// ---------------------------------------------------------------------------
// Built-in schemas
// ---------------------------------------------------------------------------

/**
 * JSON output schema — parses raw text as JSON, optionally extracting from
 * markdown code blocks, then validates with a user-supplied validator (e.g. Zod .parse).
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
      schemaName: options?.schemaName,
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

// ---------------------------------------------------------------------------
// StructuredOutputAdapter
// ---------------------------------------------------------------------------

export class StructuredOutputAdapter {
  private readonly registry: AdapterRegistry
  private readonly maxRetries: number
  private readonly injectFormatInstructions: boolean
  private readonly eventBus: DzupEventBus | undefined

  constructor(
    registry: AdapterRegistry,
    config?: StructuredOutputConfig,
  ) {
    this.registry = registry
    this.maxRetries = config?.maxRetries ?? 2
    this.injectFormatInstructions = config?.injectFormatInstructions ?? true
    this.eventBus = config?.eventBus
  }

  /**
   * Execute with structured output validation.
   *
   * 1. Optionally inject format instructions into the prompt.
   * 2. Execute via the registry's fallback chain.
   * 3. Parse the result against the schema.
   * 4. On parse failure, retry with a correction prompt (up to maxRetries).
   * 5. Return a StructuredRunResult with parsed value, timing, and collected events.
   */
  async execute<T>(
    input: AgentInput,
    schema: OutputSchema<T>,
    task?: TaskDescriptor,
  ): Promise<StructuredRunResult<T>> {
    const startMs = Date.now()
    const collectedEvents: AgentEvent[] = []

    const effectiveTask: TaskDescriptor = task ?? {
      prompt: input.prompt,
      tags: ['structured-output'],
    }

    // Build the initial prompt with optional format instructions
    const baseInput = this.buildStructuredInput(input, schema)
    const basePrompt = this.injectFormatInstructions
      ? `${baseInput.prompt}\n\nIMPORTANT: Respond with ${schema.describe()}`
      : baseInput.prompt

    let lastProviderId: AdapterProviderId | undefined
    let totalParseAttempts = 0
    let lastParseError = ''
    const attemptedProviders = new Set<AdapterProviderId>()

    try {
      const parsed = await executeStructuredParseLoop({
        initialState: { ...baseInput, prompt: basePrompt },
        maxRetries: this.maxRetries,
        invoke: async (currentInput) => {
          const result = await collectExecution(this.registry, currentInput, effectiveTask)
          collectedEvents.push(...result.events)

          for (const event of result.events) {
            if (
              event.type === 'adapter:started'
              || event.type === 'adapter:completed'
              || event.type === 'adapter:failed'
            ) {
              attemptedProviders.add(event.providerId)
              lastProviderId = event.providerId
            }
          }

          const completed = result.completed
          if (!completed) {
            throw new Error('Structured output adapter execution completed without adapter:completed result')
          }

          return {
            raw: completed.result,
            meta: completed,
          }
        },
        parse: (raw) => {
          totalParseAttempts++
          try {
            return {
              success: true as const,
              data: schema.parse(raw),
            }
          } catch (err) {
            lastParseError = err instanceof Error ? err.message : String(err)
            this.emitEvent({
              type: 'structured_output:parse_failed',
              schemaName: schema.name,
              ...(schema.schemaHash === undefined ? {} : { schemaHash: schema.schemaHash }),
              providerId: lastProviderId ?? ('unknown' as AdapterProviderId),
              attempt: totalParseAttempts,
              error: lastParseError,
            })
            return { success: false as const, error: lastParseError }
          }
        },
        onRetryState: (_currentInput, { error }) => ({
          ...baseInput,
          prompt: buildStructuredOutputCorrectionPrompt({
            schemaName: schema.name,
            schemaHash: schema.schemaHash,
            description: schema.describe(),
          }, error),
        }),
      })

      if (parsed.success) {
        const providerId = parsed.meta.providerId
        this.emitEvent({
          type: 'structured_output:parsed',
          schemaName: schema.name,
          ...(schema.schemaHash === undefined ? {} : { schemaHash: schema.schemaHash }),
          providerId,
          attempts: totalParseAttempts,
        })
        return {
          result: {
            success: true,
            value: parsed.data,
            raw: parsed.raw,
            providerId,
            schemaName: schema.name,
            ...(schema.schemaHash === undefined ? {} : { schemaHash: schema.schemaHash }),
            parseAttempts: totalParseAttempts,
            ...(schema.structuredOutput === undefined
              ? {}
              : { structuredOutput: withFailureCategory(schema.structuredOutput, undefined) }),
          },
          durationMs: Date.now() - startMs,
          fallbackUsed: attemptedProviders.size > 1,
          events: collectedEvents,
        }
      }

      return {
        result: buildFailureResult({
          providerId: lastProviderId ?? ('unknown' as AdapterProviderId),
          schema,
          parseAttempts: totalParseAttempts,
          error: buildStructuredOutputExhaustedError({
            schemaName: schema.name,
            schemaHash: schema.schemaHash,
          }, totalParseAttempts),
          failureCategory: 'parse_exhausted',
        }),
        durationMs: Date.now() - startMs,
        fallbackUsed: attemptedProviders.size > 1,
        events: collectedEvents,
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.emitEvent({
        type: 'structured_output:all_failed',
        schemaName: schema.name,
        ...(schema.schemaHash === undefined ? {} : { schemaHash: schema.schemaHash }),
        error: errorMsg,
      })
      return {
        result: buildFailureResult({
          providerId: lastProviderId ?? ('unknown' as AdapterProviderId),
          schema,
          parseAttempts: totalParseAttempts,
          error: errorMsg,
          failureCategory: 'provider_execution_failed',
        }),
        durationMs: Date.now() - startMs,
        fallbackUsed: attemptedProviders.size > 1,
        events: collectedEvents,
      }
    }
  }

  /**
   * Execute and stream events, with final result validated against schema.
   *
   * Yields all adapter events as they arrive. The final yielded event is
   * a synthetic 'adapter:completed' with the parsed result, or 'adapter:failed'
   * if parsing could not succeed.
   */
  async *executeStreamed<T>(
    input: AgentInput,
    schema: OutputSchema<T>,
    task?: TaskDescriptor,
  ): AsyncGenerator<AgentEvent> {
    const effectiveTask: TaskDescriptor = task ?? {
      prompt: input.prompt,
      tags: ['structured-output'],
    }

    const baseInput = this.buildStructuredInput(input, schema)
    const basePrompt = this.injectFormatInstructions
      ? `${baseInput.prompt}\n\nIMPORTANT: Respond with ${schema.describe()}`
      : baseInput.prompt

    let currentInput: AgentInput = { ...baseInput, prompt: basePrompt }
    let lastCompletedProviderId: AdapterProviderId | undefined
    let parseAttempts = 0
    const registry = this.registry
    let parsedResult:
      | {
          success: true
          data: T
          raw: string
          retries: number
          meta: AgentCompletedEvent
        }
      | {
          success: false
          retries: number
          meta?: AgentCompletedEvent
        }
      | null = null

    try {
      for await (const item of executeStructuredParseStreamLoop({
        initialState: currentInput,
        maxRetries: this.maxRetries,
        invoke: async function* (
          attemptInput: AgentInput,
        ): AsyncGenerator<AgentEvent, { raw: string; meta: AgentCompletedEvent }, undefined> {
          let completedEvent: AgentCompletedEvent | undefined

          const gen = registry.executeWithFallback(attemptInput, effectiveTask)
          for await (const event of gen) {
            yield event
            if (event.type === 'adapter:completed') {
              completedEvent = event
              lastCompletedProviderId = event.providerId
            }
          }

          if (!completedEvent) {
            throw new MissingCompletedStreamResultError()
          }

          return {
            raw: completedEvent.result,
            meta: completedEvent,
          }
        },
        parse: (raw) => {
          parseAttempts++
          try {
            return {
              success: true as const,
              data: schema.parse(raw),
            }
          } catch (parseErr) {
            const parseError = parseErr instanceof Error ? parseErr.message : String(parseErr)
            this.emitEvent({
              type: 'structured_output:parse_failed',
              schemaName: schema.name,
              ...(schema.schemaHash === undefined ? {} : { schemaHash: schema.schemaHash }),
              providerId: lastCompletedProviderId ?? ('unknown' as AdapterProviderId),
              attempt: parseAttempts,
              error: parseError,
            })
            return { success: false as const, error: parseError }
          }
        },
        onRetryState: (_currentInput, { error }) => {
          currentInput = {
            ...baseInput,
            prompt: buildStructuredOutputCorrectionPrompt({
              schemaName: schema.name,
              schemaHash: schema.schemaHash,
              description: schema.describe(),
            }, error),
          }
          return currentInput
        },
      })) {
        if (item.type === 'event') {
          yield item.event
          continue
        }

        parsedResult = item.result.success
          ? {
              success: true,
              data: item.result.data,
              raw: item.result.raw,
              retries: item.result.retries,
              meta: item.result.meta,
            }
          : {
              success: false,
              retries: item.result.retries,
              ...(item.result.meta === undefined ? {} : { meta: item.result.meta }),
            }
      }
    } catch (err) {
      if (err instanceof MissingCompletedStreamResultError) {
        // No completed event — adapter chain was exhausted (failures already yielded).
        return
      }

      throw err
    }

    if (parsedResult?.success) {
      this.emitEvent({
        type: 'structured_output:parsed',
        schemaName: schema.name,
        ...(schema.schemaHash === undefined ? {} : { schemaHash: schema.schemaHash }),
        providerId: parsedResult.meta.providerId,
        attempts: parseAttempts,
      })

      // Yield a synthetic completed event with the validated result
      yield {
        type: 'adapter:completed' as const,
        providerId: parsedResult.meta.providerId,
        sessionId: parsedResult.meta.sessionId,
        result: JSON.stringify(parsedResult.data),
        usage: parsedResult.meta.usage,
        durationMs: parsedResult.meta.durationMs,
        timestamp: Date.now(),
      }
      return
    }

    yield {
      type: 'adapter:failed' as const,
      providerId: parsedResult?.meta?.providerId ?? ('unknown' as AdapterProviderId),
      error: buildStructuredOutputExhaustedError({
        schemaName: schema.name,
        schemaHash: schema.schemaHash,
      }, parseAttempts),
      code: 'OUTPUT_PARSE_FAILED',
      timestamp: Date.now(),
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildStructuredInput<T>(
    input: AgentInput,
    schema: OutputSchema<T>,
  ): AgentInput {
    return schema.outputSchema === undefined
      ? input
      : {
          ...input,
          outputSchema: schema.outputSchema,
        }
  }

  private emitEvent(
    event:
      | {
          type: 'structured_output:parsed'
          schemaName: string
          schemaHash?: string
          providerId: AdapterProviderId
          attempts: number
        }
      | {
          type: 'structured_output:parse_failed'
          schemaName: string
          schemaHash?: string
          providerId: AdapterProviderId
          attempt: number
          error: string
        }
      | {
          type: 'structured_output:all_failed'
          schemaName: string
          schemaHash?: string
          error: string
        },
  ): void {
    if (this.eventBus) {
      // These are adapter-level observability events; emit via the bus.
      // The structured_output:* event types are not part of the core DzupEvent
      // union, so we cast through unknown to satisfy the type checker.
      this.eventBus.emit(event as unknown as Parameters<DzupEventBus['emit']>[0])
    }
  }
}
