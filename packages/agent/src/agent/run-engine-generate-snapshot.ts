/**
 * Run-state snapshot helpers (MC-026b-2).
 *
 * Hosts the fire-and-forget snapshot writer wired into the generate
 * tool loop. Extracted from `run-engine-generate-helpers.ts` so the
 * MC-AGT-04 Phase 1 plumbing (durable run-state snapshots at iteration
 * and termination boundaries) lives in its own module.
 *
 * The writer guarantees:
 *  - Failures NEVER abort an in-progress run; errors are logged and
 *    swallowed.
 *  - Iteration and terminal writes reach the store in call order, even
 *    if a slow iteration write would otherwise complete after the
 *    terminal write.
 */

import type { BaseMessage } from '@langchain/core/messages'
import type { TokenUsage } from '@dzupagent/core/llm'
import type { DzupRunState, DzupRunStateStore } from '@dzupagent/core/persistence'
import { secureLogger } from '@dzupagent/core/utils'
import type { ExecuteGenerateRunParams } from './run-engine/types.js'

/**
 * Inputs accepted by {@link persistRunStateSnapshot}. All fields are
 * forwarded as-is into the {@link DzupRunState} payload, except optional
 * ones which are omitted from the payload when undefined.
 */
export interface RunStateSnapshotParams {
  store: DzupRunStateStore
  runId: string
  agentId: string
  tenantId?: string
  iteration: number
  messages: BaseMessage[]
  cumulativeUsage: TokenUsage[]
  terminalReason?: string
}

/**
 * Function signature exposed by {@link createRunStateSnapshotWriter}.
 * Calls into the wrapped store but enforces ordered, fire-and-forget
 * delivery.
 */
export type RunStateSnapshotWriter = (
  params: Omit<RunStateSnapshotParams, 'store'>,
) => void

/**
 * Build a {@link DzupRunState} from the supplied loop state and write
 * it to the configured store. Snapshot failures are logged via
 * {@link secureLogger.warn} but never rethrow.
 */
export function persistRunStateSnapshot(params: RunStateSnapshotParams): Promise<void> {
  const snapshot: DzupRunState = {
    version: 1,
    runId: params.runId,
    agentId: params.agentId,
    ...(params.tenantId !== undefined ? { tenantId: params.tenantId } : {}),
    messages: params.messages,
    iteration: params.iteration,
    cumulativeUsage: params.cumulativeUsage,
    snapshotAt: Date.now(),
    ...(params.terminalReason !== undefined
      ? { terminalReason: params.terminalReason }
      : {}),
  }
  // Fire-and-forget — snapshot failure must never abort the run.
  return params.store.save(snapshot).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    secureLogger.warn(`[dzip-agent] run-state snapshot failed: ${msg}`)
  })
}

/**
 * Create an ordered, fire-and-forget snapshot writer for one run.
 *
 * Iteration snapshots and terminal snapshots are written asynchronously,
 * but they must still reach the store in call order. Without this queue,
 * a slow durable iteration write could complete after the terminal write
 * and overwrite the latest state with a non-terminal snapshot.
 */
export function createRunStateSnapshotWriter(
  store: DzupRunStateStore,
): RunStateSnapshotWriter {
  let writeChain: Promise<void> = Promise.resolve()

  return (params) => {
    writeChain = writeChain
      .then(() => persistRunStateSnapshot({ store, ...params }))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        secureLogger.warn(
          `[dzip-agent] run-state snapshot queue failed: ${msg}`,
        )
      })
    void writeChain
  }
}

/**
 * Resolve the durable run id used for snapshot keys. Prefers the
 * caller-provided `options.runId`, then `toolExecution.runId`, and
 * finally synthesises a stable id keyed by agent for runs that did not
 * supply one (so single-process replays still locate their snapshot).
 */
export function resolveRunStateRunId(
  agentId: string,
  options: ExecuteGenerateRunParams['options'],
  toolExecutionRunId: string | undefined,
): string {
  return (
    options?.runId
    ?? toolExecutionRunId
    ?? `agent:${agentId}`
  )
}
