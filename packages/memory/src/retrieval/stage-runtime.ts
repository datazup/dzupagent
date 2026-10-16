import type { MemoryRetrievalProfileV1 } from './v1-types.js'
import { logError } from '../error-log.js'
import {
  classifyDegradationReason,
  type MemoryDegradationReason,
} from '../operation-outcome.js'

const DEFAULT_STAGE_DEADLINE_MS = 5_000

export interface InternalStageOutcome<T> {
  readonly status: 'completed' | 'failed' | 'timed-out'
  readonly value?: T
  /**
   * Set on `failed`: stable cause classified from the rejection's type
   * surface (name/code), never from its message text.
   */
  readonly reasonCode?: MemoryDegradationReason
  /**
   * Set on `failed`: correlation id of the one structured log line that
   * carries the full error detail. The raw message is never retained here.
   */
  readonly errorId?: string
}

export function stageDeadlineMs(profile: MemoryRetrievalProfileV1): number {
  return profile.stageDeadlineMs ?? DEFAULT_STAGE_DEADLINE_MS
}

/** Execute one untrusted async stage with cooperative cancellation and a hard bound. */
export function invokeBoundedStage<T>(
  deadlineMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<InternalStageOutcome<T>> {
  const controller = new AbortController()
  return new Promise(resolve => {
    let settled = false
    const finish = (outcome: InternalStageOutcome<T>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      controller.abort('memory-stage-deadline')
      finish({ status: 'timed-out' })
    }, deadlineMs)
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(value => finish({ status: 'completed', value }))
      .catch((error: unknown) => {
        // A late rejection after the deadline already settled the outcome
        // is not a stage failure; do not log it as one.
        if (settled) return
        const reasonCode = classifyDegradationReason(error)
        const errorId = logError({
          component: 'memory-stage',
          operation: `stage:failed:${reasonCode}`,
          error,
        })
        finish({ status: 'failed', reasonCode, errorId })
      })
  })
}
