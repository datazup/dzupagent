/**
 * Event/registry plumbing helpers for ParallelExecutor.
 *
 * Pulled out so the orchestrator class doesn't have to spell out the pipeline
 * event union or the registry success/failure recording shape inline.
 */

import type { DzupEventBus } from '@dzupagent/core/events'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentProgressEvent,
} from '../types.js'

// ---------------------------------------------------------------------------
// Pipeline event union
// ---------------------------------------------------------------------------

export type PipelineEvent =
  | { type: 'pipeline:run_started'; pipelineId: string; runId: string }
  | { type: 'pipeline:run_completed'; pipelineId: string; runId: string; durationMs: number }
  | { type: 'pipeline:run_cancelled'; pipelineId: string; runId: string; reason?: string }
  | { type: 'pipeline:run_failed'; pipelineId: string; runId: string; error: string }
  | { type: 'pipeline:node_started'; pipelineId: string; runId: string; nodeId: string; nodeType: string }
  | { type: 'pipeline:node_completed'; pipelineId: string; runId: string; nodeId: string; durationMs: number }
  | { type: 'pipeline:node_failed'; pipelineId: string; runId: string; nodeId: string; error: string }

// ---------------------------------------------------------------------------
// Emission helpers
// ---------------------------------------------------------------------------

/** Emit a `pipeline:*` event on the supplied bus, no-op if undefined. */
export function emitPipelineEvent(
  bus: DzupEventBus | undefined,
  event: PipelineEvent,
): void {
  if (bus) bus.emit(event)
}

/** Emit an `adapter:progress` event tracking provider settle order. */
export function emitProviderProgress(
  bus: DzupEventBus | undefined,
  providerId: AdapterProviderId,
  current: number,
  total: number,
): void {
  if (!bus) return
  const percentage = total > 0 ? Math.round((current / total) * 100) : undefined
  const progressEvent: AgentProgressEvent = {
    type: 'adapter:progress',
    providerId,
    timestamp: Date.now(),
    phase: 'executing',
    current,
    total,
    percentage,
    message: `Completed provider ${String(current)}/${String(total)}`,
  }
  bus.emit(progressEvent)
}

// ---------------------------------------------------------------------------
// Registry success/failure recording (optional methods)
// ---------------------------------------------------------------------------

type RegistryWithRecording = ProviderAdapterRegistry & {
  recordSuccess?: (providerId: AdapterProviderId) => void
  recordFailure?: (providerId: AdapterProviderId, error: Error) => void
}

export function recordProviderSuccess(
  registry: ProviderAdapterRegistry,
  providerId: AdapterProviderId,
): void {
  ;(registry as RegistryWithRecording).recordSuccess?.(providerId)
}

export function recordProviderFailure(
  registry: ProviderAdapterRegistry,
  providerId: AdapterProviderId,
  error: Error,
): void {
  ;(registry as RegistryWithRecording).recordFailure?.(providerId, error)
}
