import type { BaseConnectorTool } from '@dzupagent/core'
import { normalizeBaseConnectorTool } from '@dzupagent/core'
import type { ScraperToolSchema } from './types.js'

/** Scraper connector tool — domain alias of BaseConnectorTool with typed schema */
export interface ScraperConnectorTool<Input = ScraperToolSchema, Output = string> extends BaseConnectorTool<Input, Output> {
  schema: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
  }
}

export function normalizeScraperTool(
  tool: Omit<ScraperConnectorTool, 'id'> & Partial<Pick<ScraperConnectorTool, 'id'>>,
): ScraperConnectorTool {
  const base = normalizeBaseConnectorTool({
    ...(tool.id !== undefined ? { id: tool.id } : {}),
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    invoke: tool.invoke,
  })
  return {
    ...base,
    schema: tool.schema,
  }
}
