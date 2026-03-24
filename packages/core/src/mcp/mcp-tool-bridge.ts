/**
 * MCP ↔ LangChain tool bridge.
 *
 * Converts MCP tool descriptors to LangChain StructuredToolInterface
 * and vice versa. Enables MCP tools to be used seamlessly in LangGraph
 * agent loops.
 */
import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { MCPClient } from './mcp-client.js'
import type { MCPToolDescriptor, MCPToolParameter } from './mcp-types.js'

// ---------------------------------------------------------------------------
// JSON Schema → Zod conversion
// ---------------------------------------------------------------------------

/**
 * Convert a JSON Schema property to a Zod schema.
 * Handles the common subset used by MCP tool input schemas.
 */
function jsonSchemaToZod(param: MCPToolParameter): z.ZodType {
  switch (param.type) {
    case 'string':
      if (param.enum && param.enum.length > 0) {
        return z.enum(param.enum as [string, ...string[]])
      }
      return param.description ? z.string().describe(param.description) : z.string()

    case 'number':
    case 'integer':
      return param.description ? z.number().describe(param.description) : z.number()

    case 'boolean':
      return param.description ? z.boolean().describe(param.description) : z.boolean()

    case 'array':
      if (param.items) {
        return z.array(jsonSchemaToZod(param.items))
      }
      return z.array(z.unknown())

    case 'object':
      if (param.properties) {
        const shape: Record<string, z.ZodType> = {}
        for (const [key, prop] of Object.entries(param.properties)) {
          shape[key] = prop.required === false
            ? jsonSchemaToZod(prop).optional()
            : jsonSchemaToZod(prop)
        }
        return z.object(shape)
      }
      return z.record(z.string(), z.unknown())

    default:
      return z.unknown()
  }
}

/**
 * Build a Zod object schema from an MCP tool's inputSchema.
 */
function buildInputSchema(descriptor: MCPToolDescriptor): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {}
  const required = new Set(descriptor.inputSchema.required ?? [])

  for (const [key, prop] of Object.entries(descriptor.inputSchema.properties)) {
    const zodType = jsonSchemaToZod(prop)
    shape[key] = required.has(key) ? zodType : zodType.optional()
  }

  return z.object(shape)
}

// ---------------------------------------------------------------------------
// MCP → LangChain
// ---------------------------------------------------------------------------

/**
 * Convert a single MCP tool descriptor to a LangChain tool.
 * The tool's execute function calls back to the MCPClient.
 */
export function mcpToolToLangChain(
  descriptor: MCPToolDescriptor,
  client: MCPClient,
): StructuredToolInterface {
  const inputSchema = buildInputSchema(descriptor)

  return tool(
    async (args) => {
      const result = await client.invokeTool(descriptor.name, args)

      if (result.isError) {
        const errorText = result.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n')
        return `Error: ${errorText}`
      }

      return result.content
        .map(c => {
          if (c.type === 'text') return c.text ?? ''
          if (c.type === 'image') return `[Image: ${c.mimeType ?? 'unknown'}]`
          if (c.type === 'resource') return `[Resource: ${c.mimeType ?? 'unknown'}]`
          return ''
        })
        .join('\n')
    },
    {
      name: descriptor.name,
      description: descriptor.description,
      schema: inputSchema,
    },
  )
}

/**
 * Convert all eagerly-loaded MCP tools to LangChain tools.
 */
export function mcpToolsToLangChain(client: MCPClient): StructuredToolInterface[] {
  return client.getEagerTools().map(descriptor => mcpToolToLangChain(descriptor, client))
}

// ---------------------------------------------------------------------------
// LangChain → MCP (for exposing agents as MCP servers)
// ---------------------------------------------------------------------------

/**
 * Convert a Zod schema to a simplified JSON Schema for MCP.
 * Uses zodToJsonSchema from the schema's toJsonSchema() if available,
 * otherwise falls back to simple type string.
 */
function zodToJsonSchema(schema: z.ZodType): MCPToolParameter {
  // Use Zod's built-in JSON Schema conversion when available
  const def = (schema as unknown as Record<string, unknown>)['_zod'] as
    | { def?: { type?: string; innerType?: z.ZodType; values?: string[]; element?: z.ZodType; shape?: Record<string, z.ZodType> } }
    | undefined

  const typeName = def?.def?.type

  // Unwrap optionals
  if (typeName === 'optional' || typeName === 'default') {
    const inner = def?.def?.innerType
    if (inner) {
      const result = zodToJsonSchema(inner)
      return { ...result, required: false }
    }
  }

  if (typeName === 'string') {
    return { type: 'string', description: schema.description }
  }
  if (typeName === 'number' || typeName === 'int') {
    return { type: 'number', description: schema.description }
  }
  if (typeName === 'boolean') {
    return { type: 'boolean', description: schema.description }
  }
  if (typeName === 'array') {
    const element = def?.def?.element
    return {
      type: 'array',
      items: element ? zodToJsonSchema(element) : { type: 'string' },
      description: schema.description,
    }
  }
  if (typeName === 'object') {
    const shape = def?.def?.shape
    if (shape) {
      const properties: Record<string, MCPToolParameter> = {}
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value)
      }
      return { type: 'object', properties, description: schema.description }
    }
    return { type: 'object', description: schema.description }
  }
  if (typeName === 'enum') {
    const values = def?.def?.values
    return { type: 'string', enum: values as unknown[] ?? [], description: schema.description }
  }

  // Fallback: try to infer from description
  return { type: 'string', description: schema.description }
}

/**
 * Convert a LangChain tool to an MCP tool descriptor.
 */
export function langChainToolToMcp(
  langChainTool: StructuredToolInterface,
  serverId: string,
): MCPToolDescriptor {
  const schema = langChainTool.schema as z.ZodObject<Record<string, z.ZodType>>
  const shape = schema.shape as Record<string, z.ZodType>
  const properties: Record<string, MCPToolParameter> = {}
  const required: string[] = []

  for (const [key, value] of Object.entries(shape)) {
    const param = zodToJsonSchema(value)
    properties[key] = param
    if (param.required !== false) {
      required.push(key)
    }
  }

  return {
    name: langChainTool.name,
    description: langChainTool.description,
    inputSchema: {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
    },
    serverId,
  }
}
