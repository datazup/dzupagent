/**
 * Tool format adapters — convert between ToolSchemaDescriptor, OpenAI, MCP,
 * and Zod/JSON Schema formats.
 *
 * This module is now a thin barrel over the focused submodules:
 * - {@link ./tool-format-types.ts} — shared type definitions
 * - {@link ./zod-json-schema-converter.ts} — Zod ↔ JSON Schema (basic subset)
 * - {@link ./structured-output-schema.ts} — structured-output canonicalization
 *
 * Existing imports of `./tool-format-adapters.js` continue to work via the
 * re-exports below — public API is unchanged.
 */
import type { OpenAIFunctionDefinition, OpenAIToolDefinition } from './openai-function-types.js'
import type {
  MCPToolDescriptorCompat,
  ToolSchemaDescriptor,
} from './tool-format-types.js'

// ---------------------------------------------------------------------------
// Type re-exports (preserves backwards-compatible import paths)
// ---------------------------------------------------------------------------

export type {
  ToolSchemaDescriptor,
  MCPToolDescriptorCompat,
  StructuredOutputSchemaSummary,
  StructuredOutputSchemaDescriptor,
  StructuredOutputErrorSchemaRef,
  StructuredOutputFailureCategory,
  StructuredOutputErrorContextInput,
} from './tool-format-types.js'

// ---------------------------------------------------------------------------
// Zod ↔ JSON Schema re-exports
// ---------------------------------------------------------------------------

export { zodToJsonSchema, jsonSchemaToZod } from './zod-json-schema-converter.js'

// ---------------------------------------------------------------------------
// Structured-output schema re-exports
// ---------------------------------------------------------------------------

export {
  toOpenAISafeSchema,
  toStructuredOutputJsonSchema,
  describeStructuredOutputSchema,
  buildStructuredOutputSchemaName,
  attachStructuredOutputErrorContext,
} from './structured-output-schema.js'

// ---------------------------------------------------------------------------
// OpenAI adapters
// ---------------------------------------------------------------------------

/**
 * Convert a ToolSchemaDescriptor to an OpenAI function definition.
 */
export function toOpenAIFunction(tool: ToolSchemaDescriptor): OpenAIFunctionDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }
}

/**
 * Convert a ToolSchemaDescriptor to an OpenAI tool definition (wraps function).
 */
export function toOpenAITool(tool: ToolSchemaDescriptor): OpenAIToolDefinition {
  return {
    type: 'function',
    function: toOpenAIFunction(tool),
  }
}

/**
 * Convert an OpenAI function definition back to a ToolSchemaDescriptor.
 */
export function fromOpenAIFunction(fn: OpenAIFunctionDefinition): ToolSchemaDescriptor {
  return {
    name: fn.name,
    description: fn.description ?? '',
    inputSchema: fn.parameters,
  }
}

// ---------------------------------------------------------------------------
// MCP adapters
// ---------------------------------------------------------------------------

/**
 * Convert a ToolSchemaDescriptor to an MCP-compatible tool descriptor.
 */
export function toMCPToolDescriptor(tool: ToolSchemaDescriptor): MCPToolDescriptorCompat {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }
}

/**
 * Convert an MCP tool descriptor to a ToolSchemaDescriptor.
 */
export function fromMCPToolDescriptor(mcp: {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}): ToolSchemaDescriptor {
  return {
    name: mcp.name,
    description: mcp.description ?? '',
    inputSchema: mcp.inputSchema,
  }
}
