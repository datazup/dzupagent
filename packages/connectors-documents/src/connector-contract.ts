import type { StructuredToolInterface } from '@langchain/core/tools'
import type { BaseConnectorTool } from '@dzupagent/core'
import { normalizeBaseConnectorTool } from '@dzupagent/core'

/** Document connector tool — domain alias of BaseConnectorTool */
export type DocumentConnectorTool<Input = unknown, Output = unknown> = BaseConnectorTool<Input, Output>

export function normalizeDocumentTool<Input = unknown, Output = unknown>(
  tool: StructuredToolInterface,
): DocumentConnectorTool<Input, Output> {
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
  } as unknown as DocumentConnectorTool<Input, Output>
}

export function normalizeDocumentTools<Input = unknown, Output = unknown>(
  tools: readonly StructuredToolInterface[],
): DocumentConnectorTool<Input, Output>[] {
  return tools.map((tool) => normalizeDocumentTool<Input, Output>(tool))
}
