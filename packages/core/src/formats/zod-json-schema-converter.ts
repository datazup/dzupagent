/**
 * Bidirectional Zod ↔ JSON Schema conversion (basic subset).
 *
 * Only covers the common tool-definition feature set — z.object, z.string,
 * z.number, z.boolean, z.array, z.enum, z.optional. Callers needing
 * structured-output canonicalization should use {@link
 * ./structured-output-schema.ts} instead.
 */
import { z } from 'zod'

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
 * Convert a basic JSON Schema to a Zod schema.
 *
 * Handles: object, string, number, integer, boolean, array, enum.
 * Produces ZodType instances matching the schema structure.
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  return convertJsonSchemaNode(schema)
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
