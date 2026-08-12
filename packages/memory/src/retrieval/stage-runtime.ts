import type { MemoryRetrievalProfileV1 } from './v1-types.js'

const DEFAULT_STAGE_DEADLINE_MS = 5_000

export interface InternalStageOutcome<T> {
  readonly status: 'completed' | 'failed' | 'timed-out'
  readonly value?: T
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
      .catch(() => finish({ status: 'failed' }))
  })
}
