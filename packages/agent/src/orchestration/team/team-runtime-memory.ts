/**
 * Post-run memory consolidation helper for `TeamRuntime`.
 *
 * Hosts can wire a custom `consolidate` callback or a `ConsolidationStore`
 * directly; this helper picks the right path, tolerates failures (memory
 * consolidation must never abort a successful run), and emits the
 * `team_consolidation_completed` lifecycle event on success.
 */

import { ConsolidationEngine, type ConsolidationStore } from '@dzupagent/memory'
import type { TeamPolicies } from './team-policy.js'
import type { TeamRuntimeEventEmitter } from './team-runtime-events.js'

/** Service port for post-run consolidation — see `TeamRuntimeOptions.memory`. */
export interface TeamRuntimeMemoryService {
  consolidate?(teamId: string, namespace: string): Promise<void>
  /** Optional backing store; the runtime uses `ConsolidationEngine` if set. */
  store?: ConsolidationStore
}

export interface ConsolidationContext {
  teamId: string
  runId: string
  policies: TeamPolicies
  memory: TeamRuntimeMemoryService | undefined
  emitEvent: TeamRuntimeEventEmitter
}

/**
 * Run the consolidation pass when both the policy enables it and a memory
 * service is configured. Failures are swallowed because consolidation is a
 * non-critical post-run cleanup step.
 */
export async function consolidateIfEnabled(ctx: ConsolidationContext): Promise<void> {
  const { policies, memory } = ctx
  if (policies.memory?.consolidateOnComplete !== true) return
  if (!memory?.consolidate && !memory?.store) return

  const namespace = ctx.teamId
  try {
    if (memory.consolidate) {
      await memory.consolidate(ctx.teamId, namespace)
    } else if (memory.store) {
      await new ConsolidationEngine().consolidate(ctx.teamId, namespace, memory.store)
    }
    ctx.emitEvent({
      type: 'team_consolidation_completed',
      teamId: ctx.teamId,
      runId: ctx.runId,
      namespace,
      at: new Date(),
    })
  } catch {
    // Consolidation is non-fatal — never abort the run on failure.
  }
}
