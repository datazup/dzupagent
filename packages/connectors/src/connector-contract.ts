import type { DynamicStructuredTool, StructuredToolInterface } from '@langchain/core/tools'
import type { BaseConnectorTool } from '@dzupagent/core'
import { isBaseConnectorTool, normalizeBaseConnectorTool } from '@dzupagent/core'

/**
 * Unified connector toolkit — a named set of tools produced by a connector.
 */
export interface ConnectorToolkit {
  /** Human-readable connector name */
  readonly name: string
  /** All tools provided by this connector */
  readonly tools: DynamicStructuredTool[]
  /** Subset of tool names enabled (undefined = all) */
  readonly enabledTools?: string[]
}

/** Factory function signature for connectors that return toolkits */
export type ConnectorFactory<TConfig> = (config: TConfig) => ConnectorToolkit

/** Connector tool — domain alias of BaseConnectorTool */
export type ConnectorTool<Input = unknown, Output = unknown> = BaseConnectorTool<Input, Output>

export type ConnectorToolLike<Input = unknown, Output = unknown> =
  | DynamicStructuredTool
  | StructuredToolInterface
  | ConnectorTool<Input, Output>

/** Re-export the canonical type guard under the domain name */
export const isConnectorTool: (value: unknown) => value is ConnectorTool = isBaseConnectorTool

export function normalizeConnectorTool<Input = unknown, Output = unknown>(
  tool: ConnectorToolLike<Input, Output>,
): ConnectorTool<Input, Output> {
  const id = 'id' in tool && typeof tool.id === 'string' ? tool.id : undefined
  const toModelOutput = 'toModelOutput' in tool && typeof tool.toModelOutput === 'function'
    ? tool.toModelOutput as (output: Output) => string
    : undefined
  return normalizeBaseConnectorTool<Input, Output>({
    ...( id !== undefined ? { id } : {}),
    name: tool.name,
    description: tool.description,
    schema: tool.schema,
    invoke: async (input: Input) => tool.invoke(input),
    ...(toModelOutput !== undefined ? { toModelOutput } : {}),
  })
}

export function normalizeConnectorTools<Input = unknown, Output = unknown>(
  tools: readonly ConnectorToolLike<Input, Output>[],
): ConnectorTool<Input, Output>[] {
  return tools.map((tool) => normalizeConnectorTool(tool))
}
