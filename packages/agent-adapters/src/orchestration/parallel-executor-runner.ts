/**
 * Single-provider runner for ParallelExecutor.
 *
 * Pulled out of the executor class to keep the orchestrator thin. This module
 * owns the per-provider event consumption loop: it streams events from one
 * adapter, watches for cancellation, and collapses the stream into a single
 * `ProviderResult`. It also forwards lifecycle events on the supplied event
 * bus so observers see consistent `pipeline:*` events whether the executor
 * succeeds, fails, or is aborted.
 */

import type { DzupEventBus } from '@dzupagent/core/events'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentInput,
  TokenUsage,
} from '../types.js'

import { getAbortReason, getCancellationMessage, isUserCancellationReason } from './parallel-executor-abort.js'
import { buildCancelledResult, buildFailureResult } from './parallel-executor-results.js'
import type { ProviderResult } from './parallel-executor-types.js'

// ---------------------------------------------------------------------------
// Pipeline event payloads (mirror ParallelExecutor.emit)
// ---------------------------------------------------------------------------

type PipelineNodeEvent =
  | { type: 'pipeline:node_started'; pipelineId: string; runId: string; nodeId: string; nodeType: string }
  | { type: 'pipeline:node_completed'; pipelineId: string; runId: string; nodeId: string; durationMs: number }
  | { type: 'pipeline:node_failed'; pipelineId: string; runId: string; nodeId: string; error: string }

export interface SingleProviderRunDeps {
  registry: ProviderAdapterRegistry
  eventBus: DzupEventBus | undefined
  emit: (event: PipelineNodeEvent) => void
  recordSuccess: (providerId: AdapterProviderId) => void
  recordFailure: (providerId: AdapterProviderId, error: Error) => void
}

/**
 * Run a single provider, collecting all events and producing a `ProviderResult`.
 * Errors are caught and returned as failure results — this function never throws.
 */
export async function runSingleProvider(
  input: AgentInput,
  providerId: AdapterProviderId,
  signal: AbortSignal,
  deps: SingleProviderRunDeps,
): Promise<ProviderResult> {
  const adapter = deps.registry.getHealthy(providerId)
  if (!adapter) {
    return buildFailureResult(providerId, `Adapter "${providerId}" is not healthy or not registered`)
  }

  const events: AgentEvent[] = []
  const startMs = Date.now()
  let usage: TokenUsage | undefined

  deps.emit({
    type: 'pipeline:node_started',
    pipelineId: 'parallel-executor',
    runId: `parallel-${startMs}`,
    nodeId: providerId,
    nodeType: 'adapter',
  })

  try {
    // Merge the external signal into the adapter input.
    const mergedInput: AgentInput = { ...input, signal }
    const gen = adapter.execute(mergedInput)
    let finalResult = ''
    let failedEvent: Extract<AgentEvent, { type: 'adapter:failed' }> | undefined

    for await (const event of gen) {
      // If we have been aborted (e.g. first-wins resolved), stop consuming.
      if (signal.aborted) {
        return buildCancelledResult(
          providerId,
          Date.now() - startMs,
          getCancellationMessage(signal),
          events,
          usage,
        )
      }

      events.push(event)

      if (event.type === 'adapter:failed') {
        failedEvent = event
      }

      // Extract the final result and usage from the completed event.
      if (event.type === 'adapter:completed') {
        const completed = event as AgentCompletedEvent
        finalResult = completed.result
        usage = completed.usage

        const durationMs = Date.now() - startMs
        if (signal.aborted) {
          return buildCancelledResult(
            providerId,
            durationMs,
            getCancellationMessage(signal),
            events,
            usage,
          )
        }

        deps.recordSuccess(providerId)
        deps.emit({
          type: 'pipeline:node_completed',
          pipelineId: 'parallel-executor',
          runId: `parallel-${startMs}`,
          nodeId: providerId,
          durationMs,
        })

        return {
          providerId,
          sessionId: completed.sessionId,
          result: finalResult,
          success: true,
          durationMs,
          ...(usage !== undefined ? { usage } : {}),
          events,
        }
      }
    }

    const durationMs = Date.now() - startMs

    if (signal.aborted) {
      return buildCancelledResult(
        providerId,
        durationMs,
        getCancellationMessage(signal),
        events,
        usage,
      )
    }

    const failureMessage = failedEvent?.error
      ?? 'Adapter stream ended without terminal adapter:completed event'
    const failureCode = failedEvent?.code ?? 'MISSING_TERMINAL_COMPLETION'
    deps.recordFailure(providerId, new Error(failureMessage))

    deps.emit({
      type: 'pipeline:node_failed',
      pipelineId: 'parallel-executor',
      runId: `parallel-${startMs}`,
      nodeId: providerId,
      error: failureMessage,
    })

    return {
      providerId,
      sessionId: failedEvent?.sessionId,
      result: '',
      success: false,
      durationMs,
      error: failureCode === 'MISSING_TERMINAL_COMPLETION'
        ? failureMessage
        : `${failureCode}: ${failureMessage}`,
      events,
    }
  } catch (err) {
    const durationMs = Date.now() - startMs
    const message = err instanceof Error ? err.message : String(err)
    const abortReason = getAbortReason(signal)

    if (signal.aborted || isUserCancellationReason(abortReason)) {
      return buildCancelledResult(
        providerId,
        durationMs,
        getCancellationMessage(signal, message),
        events,
        usage,
      )
    }

    // Do not emit node_failed for aborted providers — that is expected.
    if (!signal.aborted) {
      deps.emit({
        type: 'pipeline:node_failed',
        pipelineId: 'parallel-executor',
        runId: `parallel-${startMs}`,
        nodeId: providerId,
        error: message,
      })
    }

    deps.recordFailure(providerId, err instanceof Error ? err : new Error(message))

    return {
      providerId,
      result: '',
      success: false,
      durationMs,
      error: message,
      events,
    }
  }
}
