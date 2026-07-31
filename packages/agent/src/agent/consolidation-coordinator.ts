/**
 * Memory consolidation coordinator for {@link DzupAgent}.
 *
 * Wraps `ConsolidationEngine` so the agent class can stay a thin
 * coordinator. The operation remains non-fatal, but unavailable inputs and
 * partial work are reported through structured outcome metadata:
 *
 *   - unconfigured memory and missing `getStore()` return `status: degraded`
 *   - engine degradations are propagated to the caller
 *   - thrown failures become non-throwing degraded results
 *
 * Extracted from `dzip-agent.ts` (MC-004).
 */
import { ConsolidationEngine } from '@dzupagent/memory'
import type {
  ConsolidationStore,
  MemoryOperationDegradation,
  MemoryOperationStatus,
} from '@dzupagent/memory'
import type { DzupAgentConfig } from './agent-types.js'

export interface AgentConsolidationResult {
  summarized: number
  summaries: string[]
  status: MemoryOperationStatus
  degradations: MemoryOperationDegradation[]
}

function unavailable(reason: string): AgentConsolidationResult {
  return {
    summarized: 0,
    summaries: [],
    status: 'degraded',
    degradations: [
      {
        operation: 'get',
        impact: 'source-unavailable',
        reason,
      },
    ],
  }
}

/**
 * Run a consolidation sweep on the agent's memory namespace.
 *
 * Clusters semantically related entries and summarises each cluster
 * into a single record with low-strength children (pruned on the next
 * decay sweep).
 */
export async function runConsolidation(
  params: { agentId: string; config: DzupAgentConfig },
): Promise<AgentConsolidationResult> {
  const { agentId, config } = params
  const memory = config.memory
  const namespace = config.memoryNamespace
  const scope = config.memoryScope
  if (!memory || !namespace || !scope) {
    return unavailable('memory, namespace, or scope is not configured')
  }

  const getStore = (memory as { getStore?: () => unknown }).getStore
  if (typeof getStore !== 'function') {
    return unavailable('memory provider does not expose getStore()')
  }

  let store: unknown
  try {
    store = getStore.call(memory)
  } catch (error) {
    return unavailable(
      error instanceof Error ? error.message : String(error),
    )
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
    return {
      summarized: result.summarized,
      summaries: result.summaries,
      status: result.status,
      degradations: result.degradations,
    }
  } catch (error) {
    return unavailable(
      error instanceof Error ? error.message : String(error),
    )
  }
}
