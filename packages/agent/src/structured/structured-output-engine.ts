/**
 * Structured output engine — extracts typed data from LLM responses.
 *
 * Implements a fallback chain: detected strategy -> generic-parse -> fallback-prompt,
 * with retry logic on validation failure.
 */
import { zodToJsonSchema } from '@forgeagent/core'
import type {
  StructuredOutputConfig,
  StructuredOutputResult,
  StructuredOutputStrategy,
} from './structured-output-types.js'

/** Minimal LLM interface required by the structured output engine. */
export interface StructuredLLM {
  invoke(messages: unknown[]): Promise<{ content: string }>
}

/** Extended LLM interface with model name for strategy detection. */
export interface StructuredLLMWithMeta extends StructuredLLM {
  model?: string
  modelName?: string
  name?: string
}

/**
 * Detect the best structured output strategy based on the model name.
 */
export function detectStrategy(llm: StructuredLLMWithMeta): StructuredOutputStrategy {
  const name = (llm.model ?? llm.modelName ?? llm.name ?? '').toLowerCase()

  if (name.includes('claude') || name.includes('anthropic')) {
    return 'anthropic-tool-use'
  }
  if (name.includes('gpt') || name.includes('openai')) {
    return 'openai-json-schema'
  }
  return 'generic-parse'
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
function buildSchemaPrompt<T>(config: StructuredOutputConfig<T>): string {
  const jsonSchema = zodToJsonSchema(config.schema)
  const name = config.schemaName ?? 'output'
  const desc = config.schemaDescription ?? `Structured ${name} object`

  return [
    `You must respond with a valid JSON object matching this schema.`,
    `Schema name: ${name}`,
    `Description: ${desc}`,
    `JSON Schema:`,
    '```json',
    JSON.stringify(jsonSchema, null, 2),
    '```',
    `Respond ONLY with the JSON object, no other text.`,
  ].join('\n')
}

/**
 * Attempt to parse and validate raw LLM output against the schema.
 */
function tryParse<T>(
  raw: string,
  config: StructuredOutputConfig<T>,
): { success: true; data: T } | { success: false; error: string } {
  try {
    const jsonStr = extractJson(raw)
    const parsed: unknown = JSON.parse(jsonStr)
    const result = config.schema.safeParse(parsed)
    if (result.success) {
      return { success: true, data: result.data as T }
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
): Promise<StructuredOutputResult<T> | null> {
  let retries = 0
  let currentMessages = [...messages]

  // For fallback-prompt, inject schema instructions
  if (strategy === 'fallback-prompt') {
    const schemaPrompt = buildSchemaPrompt(config)
    currentMessages = [
      ...messages,
      { role: 'user', content: schemaPrompt },
    ]
  }

  while (retries <= maxRetries) {
    try {
      const response = await llm.invoke(currentMessages)
      const raw = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content)

      const parsed = tryParse(raw, config)
      if (parsed.success) {
        return {
          data: parsed.data,
          strategy,
          retries,
          raw,
        }
      }

      // Validation failed — send error back to LLM for retry
      if (retries < maxRetries) {
        currentMessages = [
          ...currentMessages,
          { role: 'assistant', content: raw },
          {
            role: 'user',
            content: `Your response did not match the required schema.\n${parsed.error}\n\nPlease fix the output and try again. Respond ONLY with valid JSON.`,
          },
        ]
        retries++
      } else {
        return null
      }
    } catch {
      return null
    }
  }

  return null
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
  const primaryStrategy = config.strategy ?? detectStrategy(llm as StructuredLLMWithMeta)

  // Build fallback chain (skip duplicates)
  const strategies: StructuredOutputStrategy[] = [primaryStrategy]
  if (primaryStrategy !== 'generic-parse') {
    strategies.push('generic-parse')
  }
  if (primaryStrategy !== 'fallback-prompt') {
    strategies.push('fallback-prompt')
  }

  for (const strategy of strategies) {
    const result = await tryStrategy(llm, messages, config, strategy, maxRetries)
    if (result) {
      return result
    }
  }

  throw new Error(
    `Structured output extraction failed after trying strategies: ${strategies.join(', ')}. ` +
    `Max retries per strategy: ${maxRetries}.`,
  )
}
