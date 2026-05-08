/**
 * StructuredOutputAdapter — public types and event union.
 *
 * Pure type definitions used by the structured-output coordinator and its
 * sibling modules (parser, retry, executor). Re-exported through
 * `./structured-output.ts`.
 */

import type { DzupEventBus } from '@dzupagent/core/events'
import type {
  OutputSchema,
  StructuredOutputErrorSchemaRef,
  StructuredOutputFailureCategory,
} from '@dzupagent/core/pipeline'

import type { AdapterProviderId, AgentEvent } from '../types.js'

// Re-export the shared, framework-agnostic primitives so existing callers of
// `@dzupagent/agent-adapters` continue to work without code changes.
export type { OutputSchema }

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
  structuredOutput?:
    | {
        requiresEnvelope: boolean
        requestSchema: StructuredOutputErrorSchemaRef
        responseSchema?: StructuredOutputErrorSchemaRef
        failureCategory?: StructuredOutputFailureCategory
      }
    | undefined
}

export interface StructuredRunResult<T> {
  result: ParseResult<T>
  durationMs: number
  fallbackUsed: boolean
  events: AgentEvent[]
}

/** Discriminated union of structured-output observability events. */
export type StructuredOutputObservabilityEvent =
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
    }

export class MissingCompletedStreamResultError extends Error {
  constructor() {
    super('Structured output streamed execution completed without adapter:completed result')
  }
}
