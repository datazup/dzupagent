import type { StructuredToolInterface } from '@langchain/core/tools'
import type { BaseConnectorTool } from '@dzupagent/core'
import { normalizeBaseConnectorTool } from '@dzupagent/core'

/** Browser connector tool — domain alias of BaseConnectorTool */
export type BrowserConnectorTool<Input = unknown, Output = unknown> = BaseConnectorTool<Input, Output>

export function normalizeBrowserTool<Input = unknown, Output = unknown>(
  tool: StructuredToolInterface,
): BrowserConnectorTool<Input, Output> {
  return normalizeBaseConnectorTool<Input, Output>(tool)
}

export function normalizeBrowserTools<Input = unknown, Output = unknown>(
  tools: readonly StructuredToolInterface[],
): BrowserConnectorTool<Input, Output>[] {
  return tools.map((tool) => normalizeBrowserTool<Input, Output>(tool))
}
