import type { AgentRunEventEnvelope, AgentRunStateV2 } from '@dzupagent/agent-types/run'

import type { AgentRunnerSafePoint, RunControl } from './run-control.js'
import type { AgentRunnerTransitionCommitter } from './runner-transition-committer.js'

/** @internal */
export interface AgentRunnerCheckpointResult {
  readonly state: AgentRunStateV2
  readonly cancelled: boolean
}

/** @internal */
export interface AgentRunnerTerminalResult {
  readonly state: AgentRunStateV2
  readonly events: readonly AgentRunEventEnvelope[]
}

/** @internal */
export async function* checkpointRun(
  state: AgentRunStateV2,
  control: RunControl,
  safePoint: AgentRunnerSafePoint,
  events: AgentRunEventEnvelope[],
  transitions: AgentRunnerTransitionCommitter,
): AsyncGenerator<AgentRunEventEnvelope, AgentRunnerCheckpointResult> {
  let decision = control.observeAtSafePoint(safePoint)
  if (decision.action === 'continue') return { state, cancelled: false }

  if (decision.action === 'cancel') {
    const cancelled = await transitions.commit(
      state,
      'run.cancelled',
      { requestId: decision.requestId, observedAt: safePoint },
      (current) => ({ ...current, status: 'cancelled' }),
    )
    events.push(cancelled.event)
    yield cancelled.event
    control.markTerminal()
    return { state: cancelled.state, cancelled: true }
  }

  const suspended = await transitions.commit(
    state,
    'run.suspended',
    { requestId: decision.requestId, observedAt: safePoint },
    (current) => ({ ...current, status: 'suspended' }),
  )
  state = suspended.state
  events.push(suspended.event)
  yield suspended.event

  const released = await control.waitUntilReleased()
  if (released === 'cancel') {
    decision = control.observeAtSafePoint(safePoint)
    if (decision.action !== 'cancel') {
      throw new Error('RunControl released a pause without a cancellation request')
    }
    const cancelled = await transitions.commit(
      state,
      'run.cancelled',
      { requestId: decision.requestId, observedAt: safePoint },
      (current) => ({ ...current, status: 'cancelled' }),
    )
    events.push(cancelled.event)
    yield cancelled.event
    control.markTerminal()
    return { state: cancelled.state, cancelled: true }
  }

  const resumed = await transitions.commit(
    state,
    'run.resumed',
    { resumedAt: safePoint },
    (current) => ({ ...current, status: 'running' }),
  )
  events.push(resumed.event)
  yield resumed.event
  return { state: resumed.state, cancelled: false }
}

/** @internal */
export async function* failRun(
  state: AgentRunStateV2,
  control: RunControl,
  events: AgentRunEventEnvelope[],
  code: string,
  transitions: AgentRunnerTransitionCommitter,
): AsyncGenerator<AgentRunEventEnvelope, AgentRunnerTerminalResult> {
  const failed = await transitions.commit(
    state,
    'run.failed',
    { code },
    (current) => ({ ...current, status: 'failed' }),
  )
  events.push(failed.event)
  yield failed.event
  control.markTerminal()
  return { state: failed.state, events }
}
