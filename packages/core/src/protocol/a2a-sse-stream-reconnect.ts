/**
 * Reconnection helpers for the A2A SSE streaming client.
 */

import { delay } from '../utils/abortable-delay.js'

/**
 * Sleep for the given duration, returning early on abort.
 */
export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return delay(ms, signal)
}
