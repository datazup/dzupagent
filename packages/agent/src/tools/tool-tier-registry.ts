/**
 * Tool tier registry — associates a {@link PermissionTier} with a
 * {@link StructuredToolInterface} without mutating the tool object
 * (MC-AGT-05).
 *
 * Why a side registry instead of a property on the tool?
 *
 * LangChain's `StructuredToolInterface` is a stable public surface and
 * does not have a `requiredTier` slot; adding one via property mutation
 * would couple consumers to an undocumented field and break tools shared
 * across multiple agents with different tier policies.  A `WeakMap` keyed
 * off the tool instance keeps the metadata package-local and lets multiple
 * agents register independent tiers (or not) without contention.
 *
 * Resolution rules:
 *
 *   - Agent-owned framework tools must register a tier at construction.
 *   - Third-party tools without metadata follow an explicit compatibility
 *     policy. The current default preserves the historical `'read-only'`
 *     behavior; security-sensitive hosts can select `'require-full-access'`
 *     to fail closed until the tool is classified.
 *   - Tools tagged at a higher tier are filtered out for agents whose
 *     {@link PermissionTier} does not satisfy the requirement; see
 *     {@link filterToolsByTier}.
 */
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { PermissionTier } from '@dzupagent/core/tools'
import { tierSatisfies } from '@dzupagent/core/tools'

/**
 * Module-private metadata store. Keyed by the tool instance so the entry
 * is garbage-collected with the tool — avoids leaks for tests / agents
 * that build many short-lived tools.
 */
const registry: WeakMap<object, PermissionTier> = new WeakMap()

export type UnclassifiedToolPolicy =
  | 'compatibility-read-only'
  | 'require-full-access'

export type ToolTierSource =
  | 'explicit'
  | 'unclassified-compatibility'
  | 'unclassified-fail-closed'

export interface ToolTierResolution {
  requiredTier: PermissionTier
  source: ToolTierSource
}

/**
 * Compatibility default for unclassified third-party tools.
 *
 * This preserves the pre-metadata behavior while making it observable.
 * Hosts that require fail-closed admission should configure
 * `'require-full-access'` until every third-party tool is classified.
 */
export const DEFAULT_UNCLASSIFIED_TOOL_POLICY: UnclassifiedToolPolicy =
  'compatibility-read-only'

/**
 * Default tier for tools that have not been explicitly tagged.
 *
 * Exported for tests / introspection so callers can verify the default
 * without hard-coding the literal in their assertions.
 */
export const DEFAULT_TOOL_TIER: PermissionTier = 'read-only'

/**
 * Tag a tool with the {@link PermissionTier} required to invoke it.
 *
 * Calling `setToolTier` again with a new tier overwrites the previous
 * registration. The tool object itself is never mutated — pass the same
 * tool to multiple agents safely.
 */
export function setToolTier(
  tool: StructuredToolInterface,
  tier: PermissionTier,
): void {
  registry.set(tool, tier)
}

/** Return true only when the tool producer registered explicit metadata. */
export function hasExplicitToolTier(tool: StructuredToolInterface): boolean {
  return registry.has(tool)
}

/**
 * Resolve both the effective tier and its provenance for auditing.
 */
export function resolveToolTier(
  tool: StructuredToolInterface,
  unclassifiedPolicy: UnclassifiedToolPolicy = DEFAULT_UNCLASSIFIED_TOOL_POLICY,
): ToolTierResolution {
  const explicitTier = registry.get(tool)
  if (explicitTier !== undefined) {
    return { requiredTier: explicitTier, source: 'explicit' }
  }

  return unclassifiedPolicy === 'require-full-access'
    ? { requiredTier: 'full-access', source: 'unclassified-fail-closed' }
    : {
        requiredTier: DEFAULT_TOOL_TIER,
        source: 'unclassified-compatibility',
      }
}

/**
 * Resolve the {@link PermissionTier} for a tool. Returns
 * {@link DEFAULT_TOOL_TIER} when no explicit registration exists.
 */
export function getToolTier(
  tool: StructuredToolInterface,
  unclassifiedPolicy: UnclassifiedToolPolicy = DEFAULT_UNCLASSIFIED_TOOL_POLICY,
): PermissionTier {
  return resolveToolTier(tool, unclassifiedPolicy).requiredTier
}

/**
 * Return a new array containing only the tools an agent on `agentTier`
 * is permitted to invoke. A tool is kept when
 * `tierSatisfies(agentTier, getToolTier(tool))` returns `true` —
 * i.e. when the agent tier is at least as permissive as the tool's
 * required tier.
 *
 * The input array is not mutated; the returned array preserves input
 * order and is empty when `tools` is empty.
 */
export function filterToolsByTier(
  tools: ReadonlyArray<StructuredToolInterface>,
  agentTier: PermissionTier,
  unclassifiedPolicy: UnclassifiedToolPolicy = DEFAULT_UNCLASSIFIED_TOOL_POLICY,
): StructuredToolInterface[] {
  return tools.filter((tool) =>
    tierSatisfies(agentTier, getToolTier(tool, unclassifiedPolicy)),
  )
}
