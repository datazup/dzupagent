/**
 * Types for the structured output engine.
 *
 * Supports multiple strategies for extracting structured (typed) data
 * from LLM responses, with automatic fallback chains and retry logic.
 */
import type { z } from 'zod'

/**
 * Strategy for extracting structured output from an LLM.
 *
 * - `anthropic-tool-use`: Uses Anthropic's native tool_use for structured extraction.
 * - `openai-json-schema`: Uses OpenAI's JSON Schema / structured output mode.
 * - `generic-parse`: Extracts JSON from the LLM text response and validates with Zod.
 * - `fallback-prompt`: Sends the schema description as a prompt, asking the LLM to output JSON.
 */
export type StructuredOutputStrategy =
  | 'anthropic-tool-use'
  | 'openai-json-schema'
  | 'generic-parse'
  | 'fallback-prompt'

/**
 * Configuration for a structured output extraction call.
 */
export interface StructuredOutputConfig<T = unknown> {
  /** The Zod schema for the expected output. */
  schema: z.ZodType<T>
  /** Strategy to use. Auto-detected from model name if not specified. */
  strategy?: StructuredOutputStrategy
  /** Maximum retries on validation failure (default: 2). */
  maxRetries?: number
  /** Human-readable name for the schema (used in prompts/tool definitions). */
  schemaName?: string
  /** Description of the schema (used in fallback-prompt strategy). */
  schemaDescription?: string
}

/**
 * Result of a structured output extraction call.
 */
export interface StructuredOutputResult<T> {
  /** The parsed and validated data. */
  data: T
  /** The strategy that successfully produced the output. */
  strategy: StructuredOutputStrategy
  /** Number of retries that were needed. */
  retries: number
  /** Raw LLM output before parsing. */
  raw: string
}
