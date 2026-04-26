/**
 * Wires the runtime safety monitor onto the shared event bus. `createSafetyMonitor`
 * auto-attaches when called, so this helper is purely a side-effect entry-point.
 *
 * Hosts can opt out via `config.disableSafetyMonitor = true` (e.g. tests, or
 * deployments that supply their own monitor).
 */
import { createSafetyMonitor } from '@dzupagent/core'
import type { ForgeServerConfig } from './types.js'

export function attachSafetyMonitor(config: ForgeServerConfig): void {
  if (config.disableSafetyMonitor) {
    return
  }
  // `createSafetyMonitor({ eventBus })` auto-attaches; no explicit attach() call
  // is needed here. See @dzupagent/core for monitor semantics.
  createSafetyMonitor({ eventBus: config.eventBus })
}
