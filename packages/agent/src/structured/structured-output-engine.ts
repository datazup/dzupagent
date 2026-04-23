/**
 * Structured output engine — extracts typed data from LLM responses.
 *
 * Implements a fallback chain: detected strategy -> generic-parse -> fallback-prompt,
 * with retry logic on validation failure.
 */
import {
  attachStructuredOutputErrorContext,
  executeStructuredParseLoop,
  buildStructuredOutputCorrectionPrompt,
  buildStructuredOutputExhaustedError,
  detectStructuredOutputStrategy,
  isStructuredOutputExhaustedErrorMessage,
  prepareStructuredOutputSchemaContract,
  resolveStructuredOutputCapabilities,
  resolveStructuredOutputSchemaProvider,
  unwrapStructuredEnvelope,
} from '@dzupagent/core'
import type { StructuredOutputFailureCategory } from '@dzupagent/core'
import type {
  StructuredOutputCapabilities,
  StructuredOutputConfig,
  StructuredOutputResult,
  StructuredOutputStrategy,
} from './structured-output-types.js'

export {
  detectStructuredOutputStrategy as detectStrategy,
  resolveStructuredOutputCapabilities,
}

/** Minimal LLM interface required by the structured output engine. */
export interface StructuredLLM {
  invoke(messages: unknown[]): Promise<{ content: string }>
}

/** Extended LLM interface with model name for strategy detection. */
export interface StructuredLLMWithMeta extends StructuredLLM {
  model?: string
  modelName?: string
  name?: string
  structuredOutputCapabilities?: StructuredOutputCapabilities
}

/**
 * Extract JSON from a raw LLM response string.
 *
 * Handles:
 * - Raw JSON
 * - JSON wrapped in ```json ... ``` code blocks
 * - JSON wrapped in ``` ... ``` code blocks
 */
function extractJson(raw: string): string {
  const trimmed = raw.trim()

  // Try code block extraction first
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim()
  }

  // Try raw JSON (starts with { or [)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return trimmed
  }

  // Last resort: find the first { ... } or [ ... ] block
  const objMatch = trimmed.match(/(\{[\s\S]*\})/)
  if (objMatch?.[1]) {
    return objMatch[1]
  }
  const arrMatch = trimmed.match(/(\[[\s\S]*\])/)
  if (arrMatch?.[1]) {
    return arrMatch[1]
  }

  return trimmed
}

/**
 * Build a schema description string from a Zod schema for the fallback-prompt strategy.
 */
function buildSchemaPrompt(
  schemaName: string,
  schemaDescription: string | undefined,
  descriptor: ReturnType<typeof prepareStructuredOutputSchemaContract>['responseSchemaDescriptor'],
): string {
  const desc = schemaDescription ?? `Structured ${schemaName} object`
  return [
    `You must respond with a valid JSON object matching this schema.`,
    `Schema name: ${schemaName}`,
    `Description: ${desc}`,
    `Schema hash: ${descriptor.schemaHash}`,
    `JSON Schema:`,
    '```json',
    JSON.stringify(descriptor.jsonSchema, null, 2),
    '```',
    `Respond ONLY with the JSON object, no other text.`,
  ].join('\n')
}

/**
 * Attempt to parse and validate raw LLM output against the schema.
 */
function tryParse<T>(
  raw: string,
  contract: ReturnType<typeof prepareStructuredOutputSchemaContract>,
): { success: true; data: T } | { success: false; error: string } {
  try {
    const jsonStr = extractJson(raw)
    const parsed: unknown = JSON.parse(jsonStr)
    const result = contract.responseSchema.safeParse(parsed)
    if (result.success) {
      return {
        success: true,
        data: unwrapStructuredEnvelope<T>(result.data, contract.requiresEnvelope),
      }
    }
    // Format validation errors
    const issues = 'error' in result && result.error && 'issues' in result.error
      ? (result.error.issues as Array<{ path: Array<string | number>; message: string }>)
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')
      : 'Validation failed'
    return { success: false, error: `Schema validation failed:\n${issues}` }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: `JSON parse error: ${message}` }
  }
}

/**
 * Try a single strategy to get structured output.
 * Returns the result or null if the strategy fails.
 */
async function tryStrategy<T>(
  llm: StructuredLLM,
  messages: unknown[],
  config: StructuredOutputConfig<T>,
  strategy: StructuredOutputStrategy,
  maxRetries: number,
  contract: ReturnType<typeof prepareStructuredOutputSchemaContract>,
): Promise<
  | { kind: 'success'; result: StructuredOutputResult<T> }
  | { kind: 'continue' }
  | { kind: 'error'; error: Error; failureCategory: StructuredOutputFailureCategory }
> {
  const initialMessages = [...messages]

  if (contract.requiresEnvelope) {
    initialMessages.push({
      role: 'system',
      content: 'Return the final JSON payload inside the top-level "result" property.',
    })
  }

  // For fallback-prompt, inject schema instructions
  if (strategy === 'fallback-prompt') {
    const schemaPrompt = buildSchemaPrompt(
      contract.schemaName,
      config.schemaDescription,
      contract.responseSchemaDescriptor,
    )
    initialMessages.push(
      { role: 'user', content: schemaPrompt },
    )
  }

  try {
    const result = await executeStructuredParseLoop({
      initialState: initialMessages,
      maxRetries,
      invoke: async (currentMessages) => {
        const response = await llm.invoke(currentMessages)
        return {
          raw: typeof response.content === 'string'
            ? response.content
            : JSON.stringify(response.content),
          meta: null,
        }
      },
      parse: (raw) => tryParse(raw, contract),
      onRetryState: (currentMessages, { raw, error }) => [
        ...currentMessages,
        { role: 'assistant', content: raw },
        {
          role: 'user',
          content: buildStructuredOutputCorrectionPrompt({
            schemaName: contract.requestSchemaDescriptor.schemaName,
            schemaHash: contract.requestSchemaDescriptor.schemaHash,
            description: 'Respond ONLY with valid JSON.',
          }, error),
        },
      ],
    })

    if (!result.success) {
      return { kind: 'continue' }
    }

    return {
      kind: 'success',
      result: {
        data: result.data as T,
        strategy,
        retries: result.retries,
        raw: result.raw,
        schemaName: contract.requestSchemaDescriptor.schemaName,
        schemaHash: contract.requestSchemaDescriptor.schemaHash,
      },
    }
  } catch (err) {
    return {
      kind: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
      failureCategory: 'provider_execution_failed',
    }
  }
}

/**
 * Generate structured output from an LLM with automatic strategy detection,
 * fallback chain, and retry logic.
 *
 * Fallback chain: detected strategy -> generic-parse -> fallback-prompt.
 *
 * @throws Error if all strategies and retries are exhausted.
 */
export async function generateStructured<T>(
  llm: StructuredLLM,
  messages: unknown[],
  config: StructuredOutputConfig<T>,
): Promise<StructuredOutputResult<T>> {
  const maxRetries = config.maxRetries ?? 2
  const capabilities = resolveStructuredOutputCapabilities(
    llm as StructuredLLMWithMeta,
    config,
  )
  const primaryStrategy = config.strategy ?? capabilities.preferredStrategy
  const schemaProvider = resolveStructuredOutputSchemaProvider(config.schemaProvider, capabilities)
  const schemaContract = prepareStructuredOutputSchemaContract(config.schema, {
    agentId: config.agentId ?? null,
    intent: config.intent ?? null,
    schemaName: config.schemaName,
    schemaProvider,
  })
  const schemaName = schemaContract.schemaName
  let lastProviderFailure: Error | null = null
  let sawParseExhaustion = false

  // When callers explicitly select a strategy, respect that exact execution mode.
  // Only auto-detected calls build the multi-strategy fallback chain.
  const strategies: StructuredOutputStrategy[] = config.strategy
    ? [config.strategy]
    : [primaryStrategy]
  if (!config.strategy) {
    if (capabilities.fallbackStrategies && capabilities.fallbackStrategies.length > 0) {
      for (const strategy of capabilities.fallbackStrategies) {
        if (!strategies.includes(strategy)) {
          strategies.push(strategy)
        }
      }
    } else {
      if (primaryStrategy !== 'generic-parse') {
        strategies.push('generic-parse')
      }
      if (primaryStrategy !== 'fallback-prompt') {
        strategies.push('fallback-prompt')
      }
    }
  }

  for (const strategy of strategies) {
    const attempt = await tryStrategy(llm, messages, {
      ...config,
      schemaName,
      schemaProvider,
    }, strategy, maxRetries, schemaContract)
    if (attempt.kind === 'success') {
      return attempt.result
    }
    if (attempt.kind === 'error') {
      lastProviderFailure = attempt.error
      continue
    }
    sawParseExhaustion = true
  }

  const modelName = 'model' in llm && typeof llm.model === 'string'
    ? llm.model
    : 'modelName' in llm && typeof llm.modelName === 'string'
      ? llm.modelName
      : 'name' in llm && typeof llm.name === 'string'
        ? llm.name
        : 'unknown'
  const terminalError = sawParseExhaustion || !lastProviderFailure
    ? new Error(buildStructuredOutputExhaustedError({
      schemaName: schemaContract.requestSchemaDescriptor.schemaName,
      schemaHash: schemaContract.requestSchemaDescriptor.schemaHash,
    }, maxRetries + 1))
    : lastProviderFailure
  const failureCategory: StructuredOutputFailureCategory =
    sawParseExhaustion || !lastProviderFailure
      ? 'parse_exhausted'
      : 'provider_execution_failed'
  const enriched = attachStructuredOutputErrorContext(terminalError, {
    agentId: config.agentId ?? null,
    intent: config.intent ?? null,
    provider: schemaContract.requestSchemaDescriptor.provider,
    model: modelName,
    failureCategory: isStructuredOutputExhaustedErrorMessage(terminalError.message, {
      schemaName: schemaContract.requestSchemaDescriptor.schemaName,
      schemaHash: schemaContract.requestSchemaDescriptor.schemaHash,
    })
      ? 'parse_exhausted'
      : failureCategory,
    requiresEnvelope: schemaContract.requiresEnvelope,
    messageCount: messages.length + (schemaContract.requiresEnvelope ? 1 : 0),
    requestSchema: schemaContract.requestSchemaDescriptor,
    responseSchema: schemaContract.responseSchemaDescriptor,
  })
  Object.assign(enriched, {
    structuredOutputStrategies: strategies,
    structuredOutputMaxRetriesPerStrategy: maxRetries,
  })
  throw enriched
}
