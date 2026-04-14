import type { DzupEventBus } from './event-bus.js'

/**
 * Emit a `system:degraded` event when an optional subsystem is unavailable.
 *
 * Use this to signal that the agent is running in a reduced-capability mode
 * (e.g. memory-ipc not installed, MCP server unreachable).
 */
export function emitDegradedOperation(
  eventBus: DzupEventBus,
  subsystem: string,
  reason: string,
  recoverable: boolean = true,
): void {
  eventBus.emit({
    type: 'system:degraded',
    subsystem,
    reason,
    timestamp: Date.now(),
    recoverable,
  })
}
