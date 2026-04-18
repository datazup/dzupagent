/**
 * Tool format adapters — convert between ToolSchemaDescriptor, OpenAI, MCP,
 * and Zod/JSON Schema formats.
 */
import { z } from 'zod'
import type { OpenAIFunctionDefinition, OpenAIToolDefinition } from './openai-function-types.js'

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
// Zod <-> JSON Schema (basic subset)
// ---------------------------------------------------------------------------

/**
 * Convert a Zod schema to a basic JSON Schema representation.
 *
 * Handles: z.object, z.string, z.number, z.boolean, z.array, z.enum, z.optional.
 * Does not cover every Zod feature — only the common subset needed for tool definitions.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return convertZodNode(schema)
}

/**
 * Strip Zod constraints that OpenAI's structured outputs strict mode rejects.
 *
 * OpenAI's response_format JSON Schema does not support: minLength, maxLength,
 * minItems, maxItems, minimum, maximum, multipleOf, pattern.
 * LangChain's withStructuredOutput passes the Zod schema through zod-to-json-schema,
 * which emits these constraints — OpenAI rejects the call entirely.
 *
 * This wrapper unwraps constraint decorators from Zod nodes so the schema sent
 * to OpenAI only contains type information, while Zod still validates the response
 * after parsing (constraints remain in the caller's original schema).
 */
export function toOpenAISafeSchema<T extends z.ZodType>(schema: T): T {
  return stripZodConstraints(schema) as T
}

function stripZodConstraints(node: z.ZodType): z.ZodType {
  // ZodOptional — unwrap, strip inner, re-wrap
  if (node instanceof z.ZodOptional) {
    return stripZodConstraints(node.unwrap() as z.ZodType).optional()
  }

  // ZodNullable — unwrap, strip inner, re-wrap
  if (node instanceof z.ZodNullable) {
    return stripZodConstraints(node.unwrap() as z.ZodType).nullable()
  }

  // ZodObject — recurse into each property
  if (node instanceof z.ZodObject) {
    const shape = node.shape as Record<string, z.ZodType>
    const strippedShape: Record<string, z.ZodType> = {}
    for (const [key, value] of Object.entries(shape)) {
      strippedShape[key] = stripZodConstraints(value)
    }
    return z.object(strippedShape)
  }

  // ZodArray — recurse into element, drop min/max item constraints
  if (node instanceof z.ZodArray) {
    return z.array(stripZodConstraints(node.element as z.ZodType))
  }

  // ZodString — return plain string, drop minLength/maxLength/regex constraints
  if (node instanceof z.ZodString) {
    return z.string()
  }

  // ZodNumber — return plain number, drop min/max/int/positive constraints
  if (node instanceof z.ZodNumber) {
    return z.number()
  }

  // ZodBoolean, ZodEnum, ZodLiteral, ZodUnknown — pass through unchanged
  return node
}

function convertZodNode(node: z.ZodType): Record<string, unknown> {
  // Unwrap ZodOptional
  if (node instanceof z.ZodOptional) {
    return convertZodNode(node.unwrap() as z.ZodType)
  }

  // ZodObject
  if (node instanceof z.ZodObject) {
    const shape = node.shape as Record<string, z.ZodType>
    const properties: Record<string, Record<string, unknown>> = {}
    const required: string[] = []

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convertZodNode(value)
      // Check if the field is NOT optional
      if (!(value instanceof z.ZodOptional)) {
        required.push(key)
      }
    }

    const result: Record<string, unknown> = {
      type: 'object',
      properties,
    }
    if (required.length > 0) {
      result['required'] = required
    }
    return result
  }

  // ZodString
  if (node instanceof z.ZodString) {
    return { type: 'string' }
  }

  // ZodNumber
  if (node instanceof z.ZodNumber) {
    return { type: 'number' }
  }

  // ZodBoolean
  if (node instanceof z.ZodBoolean) {
    return { type: 'boolean' }
  }

  // ZodArray
  if (node instanceof z.ZodArray) {
    return {
      type: 'array',
      items: convertZodNode(node.element as z.ZodType),
    }
  }

  // ZodEnum
  if (node instanceof z.ZodEnum) {
    return {
      type: 'string',
      enum: node.options as string[],
    }
  }

  // Fallback for unknown types
  return {}
}

/**
 * Convert a basic JSON Schema to a Zod schema.
 *
 * Handles: object, string, number, integer, boolean, array, enum.
 * Produces ZodType instances matching the schema structure.
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  return convertJsonSchemaNode(schema)
}

function convertJsonSchemaNode(node: Record<string, unknown>): z.ZodType {
  const type = node['type'] as string | undefined
  const enumValues = node['enum'] as string[] | undefined

  // Handle enum on string type
  if (enumValues && Array.isArray(enumValues) && enumValues.length > 0) {
    return z.enum(enumValues as [string, ...string[]])
  }

  switch (type) {
    case 'string':
      return z.string()

    case 'number':
    case 'integer':
      return z.number()

    case 'boolean':
      return z.boolean()

    case 'array': {
      const items = node['items'] as Record<string, unknown> | undefined
      if (items) {
        return z.array(convertJsonSchemaNode(items))
      }
      return z.array(z.unknown())
    }

    case 'object': {
      const properties = node['properties'] as Record<string, Record<string, unknown>> | undefined
      const required = node['required'] as string[] | undefined
      const requiredSet = new Set(required ?? [])

      if (!properties) {
        return z.object({})
      }

      const shape: Record<string, z.ZodType> = {}
      for (const [key, propSchema] of Object.entries(properties)) {
        const propZod = convertJsonSchemaNode(propSchema)
        shape[key] = requiredSet.has(key) ? propZod : propZod.optional()
      }

      return z.object(shape)
    }

    default:
      return z.unknown()
  }
}

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
