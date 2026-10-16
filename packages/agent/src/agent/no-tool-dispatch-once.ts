/**
 * Single bridge dispatch for the experimental no-tool `generate()` subset.
 *
 * A bridge failure keeps the original error on `cause` (never in the public
 * message), and an abort during dispatch is reported as
 * `cancelled-during-dispatch` rather than an unknown outcome. Either way the
 * outcome stays unknown for replay purposes.
 *
 * @module agent/no-tool-dispatch-once
 */
import {
  AgentRunnerNoToolDelegationError,
  type AgentRunnerNoToolDelegationOutcome,
  type AgentRunnerNoToolDelegationRequest,
} from '../runner/no-tool-generate-delegation.js'

/** True when a bridge failure is the caller's abort rather than a bridge fault. */
export function isDispatchCancellation(
  signal: AbortSignal | undefined,
  cause: unknown,
): boolean {
  if (signal?.aborted === true) return true
  return cause instanceof Error && cause.name === 'AbortError'
}

export async function dispatchOnce(
  request: AgentRunnerNoToolDelegationRequest,
  dispatch: (request: AgentRunnerNoToolDelegationRequest) => Promise<AgentRunnerNoToolDelegationOutcome>,
): Promise<AgentRunnerNoToolDelegationOutcome> {
  const cancel = (): void => {
    request.control.requestCancel()
  }
  request.signal?.addEventListener('abort', cancel, { once: true })
  try {
    if (request.signal?.aborted) {
      cancel()
      throw new AgentRunnerNoToolDelegationError({
        code: 'cancelled-before-dispatch', phase: 'before-dispatch',
        replay: 'not-dispatched', admission: request.admission,
      })
    }
    try {
      return await dispatch(request)
    } catch (cause) {
      // The bridge error stays on `cause` (never in the public message); an
      // abort during dispatch is a cancellation, not an unknown outcome. The
      // outcome remains unknown for replay purposes either way.
      throw new AgentRunnerNoToolDelegationError({
        code: isDispatchCancellation(request.signal, cause)
          ? 'cancelled-during-dispatch'
          : 'bridge-threw-with-unknown-outcome',
        phase: 'outcome-unknown',
        replay: 'forbidden-unknown-outcome',
        admission: request.admission,
        cause,
      })
    }
  } finally {
    request.signal?.removeEventListener('abort', cancel)
  }
}
