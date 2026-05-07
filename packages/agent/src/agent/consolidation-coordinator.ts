/**
 * Memory consolidation coordinator for {@link DzupAgent}.
 *
 * Wraps `ConsolidationEngine` so the agent class can stay a thin
 * coordinator. Mirrors the original `consolidate()` semantics one-for-one:
 *
 *   - returns `{ summarized: 0, summaries: [] }` silently when memory,
 *     namespace, or scope is unconfigured
 *   - returns `{ summarized: 0, summaries: [] }` silently when the
 *     memory provider does not expose `getStore()` (compatibility with
 *     non-{@link MemoryService} providers)
 *   - swallows `ConsolidationEngine` failures so a manual consolidation
 *     sweep never throws to the caller
 *
 * Extracted from `dzip-agent.ts` (MC-004).
 */
import { ConsolidationEngine } from '@dzupagent/memory'
import type { ConsolidationStore } from '@dzupagent/memory'
import type { DzupAgentConfig } from './agent-types.js'

/**
 * Run a consolidation sweep on the agent's memory namespace.
 *
 * Clusters semantically related entries and summarises each cluster
 * into a single record with low-strength children (pruned on the next
 * decay sweep).
 */
export async function runConsolidation(
  params: { agentId: string; config: DzupAgentConfig },
): Promise<{ summarized: number; summaries: string[] }> {
  const { agentId, config } = params
  const memory = config.memory
  const namespace = config.memoryNamespace
  const scope = config.memoryScope
  if (!memory || !namespace || !scope) return { summarized: 0, summaries: [] }

  const getStore = (memory as { getStore?: () => unknown }).getStore
  if (typeof getStore !== 'function') return { summarized: 0, summaries: [] }

  let store: unknown
  try {
    store = getStore.call(memory)
  } catch {
    return { summarized: 0, summaries: [] }
  }

  const engine = new ConsolidationEngine({
    minClusterSize: config.memoryPolicy?.consolidateMinCluster ?? 3,
  })

  try {
    const result = await engine.consolidate(
      agentId,
      namespace,
      store as ConsolidationStore,
    )
    return { summarized: result.summarized, summaries: result.summaries }
  } catch {
    return { summarized: 0, summaries: [] }
  }
}
