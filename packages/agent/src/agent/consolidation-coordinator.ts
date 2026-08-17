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
import { randomUUID } from 'node:crypto'
import { ConsolidationEngine } from '@dzupagent/memory'
import type {
  ConsolidationStore,
  MemoryOperationDegradation,
  MemoryOperationStatus,
} from '@dzupagent/memory'
import { defaultLogger } from '@dzupagent/core/utils'
import type { DzupAgentConfig } from './agent-types.js'

export interface AgentConsolidationResult {
  summarized: number
  summaries: string[]
  status: MemoryOperationStatus
  degradations: MemoryOperationDegradation[]
}

/**
 * Build a degraded result that carries a stable reason code — never driver
 * text (ERR-C-30). Full detail, when there is any, goes to the log with an
 * opaque `errorId` that joins it back to this result.
 */
function unavailable(
  reason: MemoryOperationDegradation['reason'],
  error?: unknown,
): AgentConsolidationResult {
  const errorId = randomUUID()
  if (error !== undefined) {
    try {
      defaultLogger.error(
        JSON.stringify({
          level: 'error',
          timestamp: new Date().toISOString(),
          component: 'consolidation-coordinator',
          operation: `degradation:get:source-unavailable:${reason}`,
          errorId,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : { name: 'NonError', message: String(error), stack: undefined },
        }),
      )
    } catch {
      // Logging must never take down a non-fatal path.
    }
  }
  return {
    summarized: 0,
    summaries: [],
    status: 'degraded',
    degradations: [
      {
        operation: 'get',
        impact: 'source-unavailable',
        reason,
        errorId,
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
    return unavailable('not-configured')
  }

  const getStore = (memory as { getStore?: () => unknown }).getStore
  if (typeof getStore !== 'function') {
    return unavailable('not-configured')
  }

  let store: unknown
  try {
    store = getStore.call(memory)
  } catch (error) {
    return unavailable(
      error instanceof Error ? 'backend-error' : 'unknown-error',
      error,
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
      error instanceof Error ? 'backend-error' : 'unknown-error',
      error,
    )
  }
}
