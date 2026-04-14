/**
 * Canonical Connector Tool Contract
 *
 * Shared interface for all connector packages (connectors, connectors-browser,
 * connectors-documents, scraper). Each package re-exports domain-specific type
 * aliases from this canonical base.
 */

/**
 * Base connector tool interface — the canonical shape that all connector
 * tool implementations must satisfy.
 */
export interface BaseConnectorTool<Input = unknown, Output = unknown> {
  /** Unique identifier (defaults to name if not provided) */
  id: string
  /** Tool name used for LLM function calling */
  name: string
  /** Human-readable description of what the tool does */
  description: string
  /** JSON Schema describing the tool's input parameters */
  schema: unknown
  /** Execute the tool with the given input */
  invoke(input: Input): Promise<Output>
  /** Optional: convert tool output to a string for model consumption */
  toModelOutput?: ((output: Output) => string) | undefined
}

/**
 * Type guard — checks if an unknown value satisfies the BaseConnectorTool shape.
 */
export function isBaseConnectorTool(value: unknown): value is BaseConnectorTool {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj['id'] === 'string' && obj['id'].trim().length > 0
    && typeof obj['name'] === 'string' && obj['name'].trim().length > 0
    && typeof obj['description'] === 'string' && obj['description'].trim().length > 0
    && 'schema' in obj
    && typeof obj['invoke'] === 'function'
  )
}

/**
 * Normalize a tool-like object into a BaseConnectorTool, defaulting `id` to `name`.
 */
export function normalizeBaseConnectorTool<Input = unknown, Output = unknown>(
  tool: {
    id?: string
    name: string
    description: string
    schema: unknown
    invoke(input: Input): Promise<Output>
    toModelOutput?: (output: Output) => string
  },
): BaseConnectorTool<Input, Output> {
  const normalized: BaseConnectorTool<Input, Output> = {
    id: (tool.id && tool.id.trim().length > 0) ? tool.id : tool.name,
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    invoke: async (input: Input) => tool.invoke(input),
  }

  if (typeof tool.toModelOutput === 'function') {
    normalized.toModelOutput = tool.toModelOutput
  }

  return normalized
}

/**
 * Normalize an array of tool-like objects into BaseConnectorTool instances.
 */
export function normalizeBaseConnectorTools<Input = unknown, Output = unknown>(
  tools: ReadonlyArray<{
    id?: string
    name: string
    description: string
    schema: unknown
    invoke(input: Input): Promise<Output>
    toModelOutput?: (output: Output) => string
  }>,
): BaseConnectorTool<Input, Output>[] {
  return tools.map((tool) => normalizeBaseConnectorTool(tool))
}
