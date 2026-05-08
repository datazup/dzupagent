import type { DomainToolDefinition } from '../types.js'
import { InMemoryDomainToolRegistry } from '../registry.js'
import { websiteApprovalTools } from './website-approval-tools.js'
import { websiteReadTools } from './website-read-tools.js'
import { websiteWriteTools } from './website-write-tools.js'

/**
 * website.* — contract scaffold for the website-builder agent.
 *
 * These are pure {@link DomainToolDefinition} entries (metadata-only). The
 * runtime implementations live in `apps/website-app` (which is not yet
 * scaffolded). Consumers can import the definitions to wire LLM tool catalogs,
 * permission checks, and HITL gating before any executor exists.
 *
 * Three permission tiers are encoded:
 *
 * - **Read** (`permissionLevel: 'read'`, no side effects) — site/route/section
 *   inspection, design-token introspection, library browsing, SEO validation.
 * - **Write** (`permissionLevel: 'write'`, mutating side effects) — site
 *   creation, route generation, section editing, content-source binding.
 * - **Approval-gated write** (`permissionLevel: 'write'`, mutating side effects,
 *   `requiresApproval: true`) — publish, deployment-plan generation, structured
 *   clarification flows that must be reviewed before proceeding.
 */

export interface WebsiteToolRegistryBundle {
  /** Pre-populated registry keyed by tool name. */
  registry: InMemoryDomainToolRegistry
  /** Flat list of all `website.*` tool definitions. */
  tools: readonly DomainToolDefinition[]
}

/**
 * Flat list of every `website.*` tool definition. Order is stable: read tier,
 * then write tier, then approval-gated tier.
 */
export const websiteTools: readonly DomainToolDefinition[] = [
  ...websiteReadTools,
  ...websiteWriteTools,
  ...websiteApprovalTools,
]

/**
 * Pre-populated registry plus the source list, ready to merge into a larger
 * `BuiltinToolRegistryBundle` or used standalone for tool-catalog wiring.
 */
export const websiteToolBundle: WebsiteToolRegistryBundle = (() => {
  const registry = new InMemoryDomainToolRegistry()
  for (const tool of websiteTools) {
    registry.register(tool)
  }
  return { registry, tools: websiteTools }
})()
