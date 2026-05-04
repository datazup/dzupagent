/**
 * StructuredOutputAdapter — wraps adapter execution with schema validation,
 * output parsing, and retry/fallback when output doesn't match expected format.
 *
 * The shared schema primitives (`OutputSchema`, `JsonOutputSchema`,
 * `RegexOutputSchema`) live in `@dzupagent/core/structured`. This module owns
 * the adapter-aware orchestration (`StructuredOutputAdapter`,
 * provider-aware `ParseResult`/`StructuredRunResult`) that depends on
 * `ProviderAdapterRegistry`, `AgentEvent`, and `AdapterProviderId`.
 */

import {
  executeStructuredParseLoop,
  executeStructuredParseStreamLoop,
  buildStructuredOutputCorrectionPrompt,
  buildStructuredOutputExhaustedError,
  JsonOutputSchema,
  RegexOutputSchema,
} from '@dzupagent/core'
import type {
  DzupEventBus,
  OutputSchema,
  StructuredOutputErrorSchemaRef,
  StructuredOutputFailureCategory,
} from '@dzupagent/core'

import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'
import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'

// Re-export the shared, framework-agnostic primitives so existing callers of
// `@dzupagent/agent-adapters` continue to work without code changes.
export { JsonOutputSchema, RegexOutputSchema }
export type { OutputSchema }

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
  registry: ProviderAdapterRegistry,
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
// StructuredOutputAdapter
// ---------------------------------------------------------------------------

export class StructuredOutputAdapter {
  private readonly registry: ProviderAdapterRegistry
  private readonly maxRetries: number
  private readonly injectFormatInstructions: boolean
  private readonly eventBus: DzupEventBus | undefined

  constructor(
    registry: ProviderAdapterRegistry,
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
