/**
 * StructuredOutputAdapter — execution engine.
 *
 * Wraps adapter execution with schema validation, output parsing, and
 * retry/fallback when output doesn't match the expected format. Both a
 * blocking (`execute`) and a streaming (`executeStreamed`) entry point
 * are provided; both share the parse/retry helpers in
 * `structured-output-parser.ts` and `structured-output-retry.ts`.
 */

import {
  buildStructuredOutputExhaustedError,
  executeStructuredParseLoop,
  executeStructuredParseStreamLoop,
} from '@dzupagent/core/pipeline'
import type { DzupEventBus } from '@dzupagent/core/events'
import type { OutputSchema } from '@dzupagent/core/pipeline'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'

import {
  buildFailureResult,
  emitStructuredEvent,
  parseWithSchema,
  withFailureCategory,
} from './structured-output-parser.js'
import {
  buildInitialPrompt,
  buildRetryInput,
  buildStructuredInput,
  collectExecution,
} from './structured-output-retry.js'
import {
  MissingCompletedStreamResultError,
  type StructuredOutputConfig,
  type StructuredRunResult,
} from './structured-output-types.js'

export class StructuredOutputAdapter {
  private readonly registry: ProviderAdapterRegistry
  private readonly maxRetries: number
  private readonly injectFormatInstructions: boolean
  private readonly eventBus: DzupEventBus | undefined

  constructor(registry: ProviderAdapterRegistry, config?: StructuredOutputConfig) {
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

    const baseInput = buildStructuredInput(input, schema)
    const basePrompt = buildInitialPrompt({
      baseInput,
      schema,
      injectFormatInstructions: this.injectFormatInstructions,
    })

    let lastProviderId: AdapterProviderId | undefined
    let totalParseAttempts = 0
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
            throw new Error(
              'Structured output adapter execution completed without adapter:completed result',
            )
          }

          return {
            raw: completed.result,
            meta: completed,
          }
        },
        parse: (raw) => {
          totalParseAttempts++
          return parseWithSchema({
            raw,
            schema,
            attempt: totalParseAttempts,
            providerId: lastProviderId,
            eventBus: this.eventBus,
          })
        },
        onRetryState: (_currentInput, { error }) =>
          buildRetryInput({ baseInput, schema, error }),
      })

      if (parsed.success) {
        const providerId = parsed.meta.providerId
        emitStructuredEvent(this.eventBus, {
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
          error: buildStructuredOutputExhaustedError(
            {
              schemaName: schema.name,
              schemaHash: schema.schemaHash,
            },
            totalParseAttempts,
          ),
          failureCategory: 'parse_exhausted',
        }),
        durationMs: Date.now() - startMs,
        fallbackUsed: attemptedProviders.size > 1,
        events: collectedEvents,
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      emitStructuredEvent(this.eventBus, {
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

    const baseInput = buildStructuredInput(input, schema)
    const basePrompt = buildInitialPrompt({
      baseInput,
      schema,
      injectFormatInstructions: this.injectFormatInstructions,
    })

    let currentInput: AgentInput = { ...baseInput, prompt: basePrompt }
    let lastCompletedProviderId: AdapterProviderId | undefined
    let parseAttempts = 0
    const registry = this.registry
    const eventBus = this.eventBus
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
          return parseWithSchema({
            raw,
            schema,
            attempt: parseAttempts,
            providerId: lastCompletedProviderId,
            eventBus,
          })
        },
        onRetryState: (_currentInput, { error }) => {
          currentInput = buildRetryInput({ baseInput, schema, error })
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
      emitStructuredEvent(this.eventBus, {
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
      error: buildStructuredOutputExhaustedError(
        {
          schemaName: schema.name,
          schemaHash: schema.schemaHash,
        },
        parseAttempts,
      ),
      code: 'OUTPUT_PARSE_FAILED',
      timestamp: Date.now(),
    }
  }
}
