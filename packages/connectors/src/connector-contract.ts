import type { DynamicStructuredTool, StructuredToolInterface } from '@langchain/core/tools'
import type { BaseConnectorTool, BaseConnectorToolLike } from '@dzupagent/core/tools'
import type { FlowConnectorSecurityManifest } from '@dzupagent/flow-ast'
import { validateFlowConnectorSecurityManifest } from '@dzupagent/flow-ast'
import { isBaseConnectorTool, normalizeBaseConnectorTool } from '@dzupagent/core/tools'

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
  /** Serializable provider/classification/credential/effect/evidence policy. */
  readonly securityManifest?: FlowConnectorSecurityManifest
}

export interface ConnectorSecurityReadiness {
  readonly ready: boolean
  readonly issues: readonly string[]
}

/** Factory function signature for connectors that return toolkits */
export type ConnectorFactory<TConfig> = (config: TConfig) => ConnectorToolkit

/** Connector tool — domain alias of BaseConnectorTool */
export type ConnectorTool<Input = unknown, Output = unknown> = BaseConnectorTool<Input, Output>

export type ConnectorToolLike<Input = unknown, Output = unknown> =
  | DynamicStructuredTool
  | StructuredToolInterface
  | ConnectorTool<Input, Output>
  | BaseConnectorToolLike<Input, Output>

/** Re-export the canonical type guard under the domain name */
export const isConnectorTool: (value: unknown) => value is ConnectorTool = isBaseConnectorTool

export function normalizeConnectorTool<Input = unknown, Output = unknown>(
  tool: ConnectorToolLike<Input, Output>,
): ConnectorTool<Input, Output> {
  return normalizeBaseConnectorTool<Input, Output>(tool)
}

export function normalizeConnectorTools<Input = unknown, Output = unknown>(
  tools: readonly ConnectorToolLike<Input, Output>[],
): ConnectorTool<Input, Output>[] {
  return tools.map((tool) => normalizeConnectorTool(tool))
}

/** Bind a reviewed manifest without mutating the connector toolkit. */
export function attachConnectorSecurityManifest(
  toolkit: ConnectorToolkit,
  manifest: FlowConnectorSecurityManifest,
): ConnectorToolkit {
  const issues = connectorSecurityIssues(toolkit, manifest)
  if (issues.length > 0) {
    throw new TypeError(`invalid connector security binding: ${issues.join('; ')}`)
  }
  return Object.freeze({ ...toolkit, securityManifest: manifest })
}

/** Explain policy readiness for one concrete connector toolkit. */
export function resolveConnectorSecurityReadiness(
  toolkit: ConnectorToolkit,
): ConnectorSecurityReadiness {
  if (toolkit.securityManifest === undefined) {
    return Object.freeze({
      ready: false,
      issues: Object.freeze([
        `connector toolkit "${toolkit.name}" has no security manifest`,
      ]),
    })
  }
  const issues = connectorSecurityIssues(toolkit, toolkit.securityManifest)
  return Object.freeze({
    ready: issues.length === 0,
    issues: Object.freeze(issues),
  })
}

function connectorSecurityIssues(
  toolkit: ConnectorToolkit,
  manifest: FlowConnectorSecurityManifest,
): string[] {
  const issues = validateFlowConnectorSecurityManifest(manifest)
  const declared = new Set(manifest.tools.map((tool) => tool.toolRef))
  const published = toolkit.tools.map((tool) => tool.name).sort()
  for (const name of published) {
    if (!declared.has(name)) {
      issues.push(`published tool "${name}" has no security policy`)
    }
  }
  for (const ref of declared) {
    if (!published.includes(ref)) {
      issues.push(`security policy references unpublished tool "${ref}"`)
    }
  }
  return issues
}
