/**
 * Tool format type definitions — canonical descriptors used across format
 * adapters (Zod ↔ JSON Schema, OpenAI, MCP, structured-output contracts).
 *
 * Keeping types in their own module avoids loading the conversion runtime
 * when only the type surface is needed.
 */

// ---------------------------------------------------------------------------
// Canonical tool descriptor
// ---------------------------------------------------------------------------

export interface ToolSchemaDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// MCP tool descriptor (subset used for interop)
// ---------------------------------------------------------------------------

export interface MCPToolDescriptorCompat {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Structured output schema descriptors
// ---------------------------------------------------------------------------

export interface StructuredOutputSchemaSummary {
  topLevelType: string | null
  topLevelAdditionalProperties: boolean | null
  totalProperties: number
  totalRequired: number
  enumCount: number
  nullableCount: number
  maxDepth: number
}

export interface StructuredOutputSchemaDescriptor {
  schemaName: string
  provider: 'generic' | 'openai'
  jsonSchema: Record<string, unknown>
  schemaHash: string
  schemaPreview: string
  summary: StructuredOutputSchemaSummary
}

export interface StructuredOutputErrorSchemaRef {
  name: string
  hash: string
  preview: string
  summary: StructuredOutputSchemaSummary
}

export type StructuredOutputFailureCategory =
  | 'parse_exhausted'
  | 'provider_execution_failed'

export interface StructuredOutputErrorContextInput {
  agentId?: string | null
  intent?: string | null
  provider?: string | null
  model?: string | null
  failureCategory?: StructuredOutputFailureCategory
  requiresEnvelope?: boolean
  messageCount?: number
  requestSchema: StructuredOutputSchemaDescriptor
  responseSchema?: StructuredOutputSchemaDescriptor | null
}
