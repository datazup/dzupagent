import type { StructuredToolInterface } from '@langchain/core/tools'
import type { BaseConnectorTool } from '@dzupagent/core'
import { normalizeBaseConnectorTool } from '@dzupagent/core'

/** Browser connector tool — domain alias of BaseConnectorTool */
export type BrowserConnectorTool<Input = unknown, Output = unknown> = BaseConnectorTool<Input, Output>

export function normalizeBrowserTool<Input = unknown, Output = unknown>(
  tool: StructuredToolInterface,
): BrowserConnectorTool<Input, Output> {
  const normalized = normalizeBaseConnectorTool<Input, Output>({
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    invoke: async (input: Input) => tool.invoke(input),
  })
  return {
    ...normalized,
    invoke: async (input: Input, context?: { signal?: AbortSignal }) =>
      tool.invoke(input, context),
  } as unknown as BrowserConnectorTool<Input, Output>
}

export function normalizeBrowserTools<Input = unknown, Output = unknown>(
  tools: readonly StructuredToolInterface[],
): BrowserConnectorTool<Input, Output>[] {
  return tools.map((tool) => normalizeBrowserTool<Input, Output>(tool))
}
