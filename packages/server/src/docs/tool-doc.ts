/**
 * Tool documentation renderer — produces markdown with a parameter table
 * derived from JSON Schema properties.
 *
 * @module docs/tool-doc
 */

export interface ToolDocInput {
  name: string
  description: string
  inputSchema?: Record<string, unknown>
}

interface SchemaProperty {
  type?: string
  description?: string
  default?: unknown
}

/**
 * Render a markdown document describing a tool, including a parameter table
 * if an input schema with `properties` is provided.
 */
export function renderToolDoc(tool: ToolDocInput): string {
  const lines: string[] = []

  lines.push(`# Tool: ${tool.name}`)
  lines.push('')
  lines.push(tool.description)
  lines.push('')

  if (tool.inputSchema) {
    const properties = tool.inputSchema['properties'] as
      | Record<string, SchemaProperty>
      | undefined
    const required = (tool.inputSchema['required'] as string[] | undefined) ?? []

    if (properties && Object.keys(properties).length > 0) {
      lines.push('## Parameters')
      lines.push('')
      lines.push('| Parameter | Type | Required | Description |')
      lines.push('|-----------|------|----------|-------------|')

      for (const [paramName, prop] of Object.entries(properties)) {
        const paramType = prop.type ?? 'unknown'
        const isRequired = required.includes(paramName) ? 'Yes' : 'No'
        const desc = prop.description ?? '-'
        lines.push(`| \`${paramName}\` | ${paramType} | ${isRequired} | ${desc} |`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}
