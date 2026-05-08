/**
 * StructuredOutput parser helpers.
 *
 * Owns the schema-aware parsing utilities shared by the non-streaming and
 * streaming executors: mapping `schema.parse` outcomes to a uniform
 * `{ success, data | error }` shape, building failure-result skeletons,
 * and applying failure-category metadata to `OutputSchema.structuredOutput`.
 */

import { typedEmit } from '@dzupagent/core/events'
import type { DzupEventBus } from '@dzupagent/core/events'
import type {
  OutputSchema,
  StructuredOutputFailureCategory,
} from '@dzupagent/core/pipeline'

import type { AdapterProviderId } from '../types.js'
import type {
  ParseResult,
  StructuredOutputObservabilityEvent,
} from './structured-output-types.js'

export function withFailureCategory(
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

export function buildFailureResult<T>(input: {
  providerId: AdapterProviderId
  schema: OutputSchema<T>
  parseAttempts: number
  error: string
  failureCategory: StructuredOutputFailureCategory
}): ParseResult<T> {
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
 * Run `schema.parse` and translate the outcome into the uniform tagged-union
 * shape consumed by `executeStructuredParseLoop` /
 * `executeStructuredParseStreamLoop`. Emits `structured_output:parse_failed`
 * on failure.
 */
export function parseWithSchema<T>(input: {
  raw: string
  schema: OutputSchema<T>
  attempt: number
  providerId: AdapterProviderId | undefined
  eventBus: DzupEventBus | undefined
}): { success: true; data: T } | { success: false; error: string } {
  try {
    return { success: true, data: input.schema.parse(input.raw) }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    emitStructuredEvent(input.eventBus, {
      type: 'structured_output:parse_failed',
      schemaName: input.schema.name,
      ...(input.schema.schemaHash === undefined ? {} : { schemaHash: input.schema.schemaHash }),
      providerId: input.providerId ?? ('unknown' as AdapterProviderId),
      attempt: input.attempt,
      error,
    })
    return { success: false, error }
  }
}

export function emitStructuredEvent(
  eventBus: DzupEventBus | undefined,
  event: StructuredOutputObservabilityEvent,
): void {
  typedEmit(eventBus, event)
}
