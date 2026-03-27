/**
 * Connector types — interface for pre-built integrations that produce LangChain tools.
 */
import type { DynamicStructuredTool } from '@langchain/core/tools'

/** Configuration for a connector */
export interface ConnectorConfig {
  /** Authentication credentials */
  credentials: Record<string, string>
  /** Subset of tools to expose (default: all) */
  enabledTools?: string[]
}

/** A connector that produces tools for a specific service */
export interface Connector {
  name: string
  description: string
  /** Create LangChain tools from this connector's config */
  createTools(config: ConnectorConfig): DynamicStructuredTool[]
}

/** Filter tools by enabled list */
export function filterTools(
  tools: DynamicStructuredTool[],
  enabledTools?: string[],
): DynamicStructuredTool[] {
  if (!enabledTools) return tools
  return tools.filter(t => enabledTools.includes(t.name))
}
