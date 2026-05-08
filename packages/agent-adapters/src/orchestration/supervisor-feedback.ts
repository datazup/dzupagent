/**
 * Supervisor event-bus feedback helpers.
 *
 * Centralises emission of `supervisor:*` lifecycle events plus the
 * `adapter:progress` updates that surface aggregated subtask completion.
 */

import type { DzupEventBus } from '@dzupagent/core/events'

import type { AdapterProviderId, AgentProgressEvent } from '../types.js'
import type { SupervisorLifecycleEvent } from './supervisor-types.js'

export function emitSupervisorEvent(
  eventBus: DzupEventBus | undefined,
  event: SupervisorLifecycleEvent,
): void {
  if (eventBus) {
    eventBus.emit(event)
  }
}

export function emitProgressEvent(
  eventBus: DzupEventBus | undefined,
  current: number,
  total: number,
  providerId?: AdapterProviderId | null,
): void {
  if (!eventBus) return

  const percentage = total > 0 ? Math.round((current / total) * 100) : undefined
  const progressEvent: Omit<AgentProgressEvent, 'providerId'> & {
    providerId?: AdapterProviderId
  } = {
    type: 'adapter:progress',
    timestamp: Date.now(),
    phase: 'executing',
    current,
    total,
    percentage,
    message: `Completed subtask ${String(current)}/${String(total)}`,
  }
  if (providerId) {
    progressEvent.providerId = providerId
  }
  eventBus.emit(progressEvent)
}
