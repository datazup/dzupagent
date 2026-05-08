/**
 * StructuredOutput retry helpers.
 *
 * Wraps the structured-output correction-prompt rebuild and the registry
 * fallback-collection loop used by the non-streaming executor. Keeping
 * the retry/fallback orchestration here lets the executor module focus on
 * orchestrating the parse/retry loops themselves.
 */

import { buildStructuredOutputCorrectionPrompt } from '@dzupagent/core/pipeline'
import type { OutputSchema } from '@dzupagent/core/pipeline'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AgentCompletedEvent,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'

/**
 * Execute an adapter via the registry fallback chain and collect all events.
 * Returns the completed event (if any) and all yielded events.
 */
export async function collectExecution(
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

/**
 * Build the input for a retry attempt: replace the prompt with the
 * structured-output correction prompt while preserving the rest of the
 * baseline input (output schema, system prompt, working directory, ...).
 */
export function buildRetryInput<T>(input: {
  baseInput: AgentInput
  schema: OutputSchema<T>
  error: string
}): AgentInput {
  return {
    ...input.baseInput,
    prompt: buildStructuredOutputCorrectionPrompt(
      {
        schemaName: input.schema.name,
        schemaHash: input.schema.schemaHash,
        description: input.schema.describe(),
      },
      input.error,
    ),
  }
}

/**
 * Optionally enrich `AgentInput` with a JSON / Regex output schema so the
 * adapter can apply provider-side schema enforcement when supported.
 */
export function buildStructuredInput<T>(
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

/**
 * Compose the initial structured-output prompt: optionally append the
 * schema's `describe()` blurb so the model sees the expected format.
 */
export function buildInitialPrompt<T>(input: {
  baseInput: AgentInput
  schema: OutputSchema<T>
  injectFormatInstructions: boolean
}): string {
  return input.injectFormatInstructions
    ? `${input.baseInput.prompt}\n\nIMPORTANT: Respond with ${input.schema.describe()}`
    : input.baseInput.prompt
}
