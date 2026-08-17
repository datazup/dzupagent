/**
 * Error-recovery side of the workflow compiler.
 *
 * Holds the cancellation-signal bridge and the `applyErrorHandlers` routine
 * that step/parallel transforms call when a step throws. Extracted from
 * `workflow-compiler.ts` so the compiler coordinator stays under the
 * project-wide LOC budget.
 *
 * @module workflow/workflow-compiler-error-handlers
 */
import type {
  WorkflowContext,
  WorkflowEvent,
  StepCompletedEvent,
} from './workflow-types.js'
import type { WorkflowErrorHandler } from './workflow-builder-types.js'
import type { NodeExecutionContext } from '../pipeline/pipeline-runtime-types.js'
import { omitUndefined } from '../utils/exact-optional.js'

/**
 * Bridge the structural `CancellationSignal` shape exposed by
 * `@dzupagent/runtime-contracts` to the concrete `AbortSignal` type that
 * workflow-step authors expect on `WorkflowContext.signal`.
 *
 * `CancellationSignal` is intentionally a strict structural subset of
 * `AbortSignal` (it omits `reason`, `dispatchEvent`, `onabort`, and the
 * options arg on `addEventListener`) so runtime-contracts can stay free of
 * `lib.dom`/`@types/node`. The canonical pipeline runtime always feeds in
 * a real `AbortSignal` instance (see `runtime-contracts/pipeline.ts`
 * JSDoc), so a runtime cross-cast here is sound — but TypeScript correctly
 * rejects a direct `as AbortSignal` because the structural shapes are not
 * assignable.
 *
 * The `unknown` indirection makes the boundary crossing explicit while
 * preserving the load-bearing fact: workflow steps may rely on the
 * AbortSignal-only surface (`reason`, listener options) that the
 * structural contract does not advertise.
 */
export function asAbortSignal(
  signal: NodeExecutionContext['signal'],
): AbortSignal | undefined {
  if (signal === undefined) return undefined
  return signal as unknown as AbortSignal
}

/**
 * Try each registered error handler against `err`; the first matching handler
 * wins. Recovery steps are executed in sequence with `state.error` populated
 * (a serializable view of the original error) and any object outputs are
 * merged back into the workflow state. Returns `true` when a handler ran
 * successfully; otherwise the caller must re-throw.
 */
export async function applyErrorHandlers(
  err: unknown,
  state: Record<string, unknown>,
  ctx: WorkflowContext,
  emit: (event: WorkflowEvent) => void,
  errorHandlers: WorkflowErrorHandler[],
): Promise<boolean> {
  if (errorHandlers.length === 0) return false
  const errorObj = err instanceof Error ? err : new Error(String(err))
  const matching = errorHandlers.find(h => {
    try {
      return h.predicate(errorObj)
    } catch {
      return false
    }
  })
  if (!matching) return false

  const errorView = {
    name: errorObj.name,
    message: errorObj.message,
    stack: errorObj.stack,
  }
  state['error'] = errorView

  for (const recoveryStep of matching.recoverySteps) {
    const start = Date.now()
    emit({ type: 'step:started', stepId: recoveryStep.id })
    try {
      // `rawResult` is the recovery step's real return value; `result` is the
      // state-merge view of it. A recovery step's output is journalled just
      // like a normal step's — a resumed transcript must show what the
      // recovery actually produced, not a bare "[completed]".
      const rawResult: unknown = await recoveryStep.execute(state, ctx)
      const result = rawResult as Record<string, unknown> | undefined
      if (result && typeof result === 'object') {
        Object.assign(state, result)
      }
      emit(omitUndefined<StepCompletedEvent>({
        type: 'step:completed',
        stepId: recoveryStep.id,
        durationMs: Date.now() - start,
        output: rawResult,
        stepName: recoveryStep.description,
      }))
    } catch (recoveryErr) {
      const message = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr)
      emit({ type: 'step:failed', stepId: recoveryStep.id, error: message })
      throw recoveryErr
    }
  }
  return true
}
