/**
 * StructuredOutputAdapter — wraps adapter execution with schema validation,
 * output parsing, and retry/fallback when output doesn't match expected format.
 *
 * Supports arbitrary output schemas (JSON with Zod validators, regex patterns,
 * or custom parsers). On parse failure, retries with a correction prompt, then
 * falls back to alternative providers if retries are exhausted.
 */

import { ForgeError } from '@dzipagent/core'
import type { DzipEventBus } from '@dzipagent/core'

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
  maxRetries?: number
  /** Whether to inject format instructions into the prompt. Default true */
  injectFormatInstructions?: boolean
  /** Event bus for observability */
  eventBus?: DzipEventBus
}

export interface ParseResult<T> {
  success: boolean
  value?: T
  raw: string
  providerId: AdapterProviderId
  parseAttempts: number
  error?: string
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

// ---------------------------------------------------------------------------
// Built-in schemas
// ---------------------------------------------------------------------------

/**
 * JSON output schema — parses raw text as JSON, optionally extracting from
 * markdown code blocks, then validates with a user-supplied validator (e.g. Zod .parse).
 */
export class JsonOutputSchema<T> implements OutputSchema<T> {
  readonly name: string
  private readonly validator: (data: unknown) => T
  private readonly schemaDescription: string

  constructor(
    name: string,
    validator: (data: unknown) => T,
    schemaDescription?: string,
  ) {
    this.name = name
    this.validator = validator
    this.schemaDescription = schemaDescription ?? 'valid JSON matching the expected schema'
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
  private readonly eventBus: DzipEventBus | undefined

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
   * 5. If all retries exhausted, try a fresh execution (triggers different provider).
   * 6. Return a StructuredRunResult with parsed value, timing, and collected events.
   */
  async execute<T>(
    input: AgentInput,
    schema: OutputSchema<T>,
    task?: TaskDescriptor,
  ): Promise<StructuredRunResult<T>> {
    const startMs = Date.now()
    const collectedEvents: AgentEvent[] = []
    let fallbackUsed = false

    const effectiveTask: TaskDescriptor = task ?? {
      prompt: input.prompt,
      tags: ['structured-output'],
    }

    // Build the initial prompt with optional format instructions
    const basePrompt = this.injectFormatInstructions
      ? `${input.prompt}\n\nIMPORTANT: Respond with ${schema.describe()}`
      : input.prompt

    let lastProviderId: AdapterProviderId | undefined
    let totalParseAttempts = 0
    let lastParseError = ''

    // Outer loop: up to 2 full execution cycles (initial + fallback rotation)
    for (let providerAttempt = 0; providerAttempt < 2; providerAttempt++) {
      if (providerAttempt > 0) {
        fallbackUsed = true
      }

      // Inner loop: initial execution + retries with correction prompts
      for (let retry = 0; retry <= this.maxRetries; retry++) {
        const prompt = retry === 0
          ? basePrompt
          : `Your previous output was invalid. Error: ${lastParseError}. Please try again with the correct format: ${schema.describe()}`

        const execInput: AgentInput = { ...input, prompt }

        let completed: AgentCompletedEvent | undefined
        try {
          const result = await collectExecution(this.registry, execInput, effectiveTask)
          completed = result.completed
          collectedEvents.push(...result.events)

          // Track the provider that responded
          for (const event of result.events) {
            if (event.type === 'adapter:started' || event.type === 'adapter:completed') {
              lastProviderId = event.providerId
            }
          }
        } catch (err) {
          // All adapters exhausted during this execution
          const errorMsg = err instanceof Error ? err.message : String(err)
          this.emitEvent({
            type: 'structured_output:all_failed',
            schemaName: schema.name,
            error: errorMsg,
          })
          return {
            result: {
              success: false,
              raw: '',
              providerId: lastProviderId ?? ('unknown' as AdapterProviderId),
              parseAttempts: totalParseAttempts,
              error: errorMsg,
            },
            durationMs: Date.now() - startMs,
            fallbackUsed,
            events: collectedEvents,
          }
        }

        if (!completed) {
          // No completed event — unusual, skip to next attempt
          continue
        }

        lastProviderId = completed.providerId
        totalParseAttempts++

        try {
          const value = schema.parse(completed.result)
          this.emitEvent({
            type: 'structured_output:parsed',
            schemaName: schema.name,
            providerId: lastProviderId,
            attempts: totalParseAttempts,
          })
          return {
            result: {
              success: true,
              value,
              raw: completed.result,
              providerId: lastProviderId,
              parseAttempts: totalParseAttempts,
            },
            durationMs: Date.now() - startMs,
            fallbackUsed,
            events: collectedEvents,
          }
        } catch (parseErr) {
          lastParseError = parseErr instanceof Error ? parseErr.message : String(parseErr)
          this.emitEvent({
            type: 'structured_output:parse_failed',
            schemaName: schema.name,
            providerId: lastProviderId,
            attempt: totalParseAttempts,
            error: lastParseError,
          })
          // Continue to next retry iteration
        }
      }
      // All retries exhausted for this cycle — outer loop tries again with
      // a fresh execution (the registry may route to a different provider)
    }

    // All providers and retries exhausted
    return {
      result: {
        success: false,
        raw: '',
        providerId: lastProviderId ?? ('unknown' as AdapterProviderId),
        parseAttempts: totalParseAttempts,
        error: `Failed to parse output matching schema "${schema.name}" after ${totalParseAttempts} attempts`,
      },
      durationMs: Date.now() - startMs,
      fallbackUsed,
      events: collectedEvents,
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

    const basePrompt = this.injectFormatInstructions
      ? `${input.prompt}\n\nIMPORTANT: Respond with ${schema.describe()}`
      : input.prompt

    let currentInput: AgentInput = { ...input, prompt: basePrompt }
    let completedEvent: AgentCompletedEvent | undefined
    let parseAttempts = 0

    for (let retry = 0; retry <= this.maxRetries; retry++) {
      completedEvent = undefined

      const gen = this.registry.executeWithFallback(currentInput, effectiveTask)
      for await (const event of gen) {
        yield event
        if (event.type === 'adapter:completed') {
          completedEvent = event
        }
      }

      if (!completedEvent) {
        // No completed event — adapter chain was exhausted (failures already yielded)
        return
      }

      parseAttempts++
      try {
        const value = schema.parse(completedEvent.result)
        // Yield a synthetic completed event with the validated result
        yield {
          type: 'adapter:completed' as const,
          providerId: completedEvent.providerId,
          sessionId: completedEvent.sessionId,
          result: JSON.stringify(value),
          usage: completedEvent.usage,
          durationMs: completedEvent.durationMs,
          timestamp: Date.now(),
        }
        return
      } catch (parseErr) {
        const parseError = parseErr instanceof Error ? parseErr.message : String(parseErr)
        this.emitEvent({
          type: 'structured_output:parse_failed',
          schemaName: schema.name,
          providerId: completedEvent.providerId,
          attempt: parseAttempts,
          error: parseError,
        })

        if (retry < this.maxRetries) {
          currentInput = {
            ...input,
            prompt: `Your previous output was invalid. Error: ${parseError}. Please try again with the correct format: ${schema.describe()}`,
          }
        }
      }
    }

    // All retries exhausted
    yield {
      type: 'adapter:failed' as const,
      providerId: completedEvent?.providerId ?? ('unknown' as AdapterProviderId),
      error: `Failed to parse output matching schema "${schema.name}" after ${parseAttempts} attempts`,
      code: 'OUTPUT_PARSE_FAILED',
      timestamp: Date.now(),
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private emitEvent(
    event:
      | {
          type: 'structured_output:parsed'
          schemaName: string
          providerId: AdapterProviderId
          attempts: number
        }
      | {
          type: 'structured_output:parse_failed'
          schemaName: string
          providerId: AdapterProviderId
          attempt: number
          error: string
        }
      | {
          type: 'structured_output:all_failed'
          schemaName: string
          error: string
        },
  ): void {
    if (this.eventBus) {
      // These are adapter-level observability events; emit via the bus.
      // The structured_output:* event types are not part of the core DzipEvent
      // union, so we cast through unknown to satisfy the type checker.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.eventBus.emit(event as unknown as Parameters<DzipEventBus['emit']>[0])
    }
  }
}
