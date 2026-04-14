import type { AgentCLIAdapter, AdapterCapabilityProfile } from '../types.js'
import type { ProviderCostModel } from '../middleware/cost-models.js'

/**
 * Definition for a third-party adapter plugin.
 */
export interface AdapterPluginDefinition {
  /** Unique plugin identifier (used as provider ID) */
  id: string
  /** Human-readable name */
  name: string
  /** Plugin version (semver) */
  version: string
  /** Factory to create the adapter instance */
  createAdapter(config?: Record<string, unknown>): AgentCLIAdapter
  /** Declared capabilities */
  capabilities: AdapterCapabilityProfile
  /** Optional cost model for cost estimation */
  costModel?: ProviderCostModel
  /** Optional cleanup hook called when the plugin is unregistered */
  onUnload?: () => Promise<void> | void
}

/**
 * A registered adapter plugin with type marker.
 */
export interface AdapterPlugin extends AdapterPluginDefinition {
  readonly type: 'adapter-plugin'
}

/**
 * Define an adapter plugin for third-party provider integration.
 *
 * @example
 * ```typescript
 * import { defineAdapterPlugin } from '@dzupagent/agent-adapters'
 *
 * export default defineAdapterPlugin({
 *   id: 'my-provider',
 *   name: 'My Custom Provider',
 *   version: '1.0.0',
 *   createAdapter(config) {
 *     return new MyCustomAdapter(config)
 *   },
 *   capabilities: {
 *     supportsResume: false,
 *     supportsFork: false,
 *     supportsToolCalls: true,
 *     supportsStreaming: true,
 *     supportsCostUsage: false,
 *   },
 * })
 * ```
 */
export function defineAdapterPlugin(definition: AdapterPluginDefinition): AdapterPlugin {
  return { ...definition, type: 'adapter-plugin' as const }
}

/**
 * Validates that an object is a valid adapter plugin.
 */
export function isAdapterPlugin(value: unknown): value is AdapterPlugin {
  if (!value || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return obj['type'] === 'adapter-plugin'
    && typeof obj['id'] === 'string'
    && typeof obj['name'] === 'string'
    && typeof obj['version'] === 'string'
    && typeof obj['createAdapter'] === 'function'
    && obj['capabilities'] != null
}
