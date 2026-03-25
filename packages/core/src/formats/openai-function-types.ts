/**
 * OpenAI-compatible function/tool definition types.
 *
 * These types mirror the OpenAI API specification for function calling
 * so that ForgeAgent tools can be exposed as OpenAI-compatible tools.
 */

// ---------------------------------------------------------------------------
// OpenAI Function Definition
// ---------------------------------------------------------------------------

export interface OpenAIFunctionDefinition {
  /** The name of the function to be called. */
  name: string
  /** A description of what the function does. */
  description?: string
  /** The parameters the function accepts, described as a JSON Schema object. */
  parameters: Record<string, unknown>
  /** Whether to enable strict schema validation (OpenAI structured outputs). */
  strict?: boolean
}

// ---------------------------------------------------------------------------
// OpenAI Tool Definition
// ---------------------------------------------------------------------------

export interface OpenAIToolDefinition {
  /** The type of the tool. Currently only 'function' is supported. */
  type: 'function'
  /** The function definition. */
  function: OpenAIFunctionDefinition
}
