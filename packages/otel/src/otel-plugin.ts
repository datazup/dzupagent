/**
 * OTel Plugin Factory — ECO-022.
 *
 * Creates a ForgePlugin that wires enabled OTel features (tracer, bridge,
 * cost attribution, safety monitor, audit trail) to the ForgeEventBus.
 * Omitting a section disables it at zero cost.
 *
 * @example
 * ```ts
 * import { createOTelPlugin } from '@forgeagent/otel'
 *
 * const plugin = createOTelPlugin({ tracer: true, bridge: true })
 * pluginRegistry.register(plugin)
 * ```
 */

import type { ForgePlugin, PluginContext, ForgeEventBus } from '@forgeagent/core'
import { ForgeTracer } from './tracer.js'
import type { ForgeTracerConfig } from './tracer.js'
import { OTelBridge } from './otel-bridge.js'
import type { OTelBridgeConfig } from './otel-bridge.js'
import { CostAttributor } from './cost-attribution.js'
import type { CostAttributorConfig } from './cost-attribution.js'
import { SafetyMonitor } from './safety-monitor.js'
import type { SafetyMonitorConfig } from './safety-monitor.js'
import { AuditTrail } from './audit-trail.js'
import type { AuditTrailConfig } from './audit-trail.js'

// ------------------------------------------------------------------ Config

export interface OTelPluginConfig {
  /** Enable ForgeTracer. Pass `true` for defaults or a config object. */
  tracer?: boolean | ForgeTracerConfig
  /** Enable OTelBridge (event → metric mapping). Pass `true` for defaults or a config object. */
  bridge?: boolean | OTelBridgeConfig
  /** Enable cost attribution tracking. Pass `true` for defaults or a config object. */
  costAttribution?: boolean | CostAttributorConfig
  /** Enable safety monitor (prompt injection / exfiltration detection). */
  safetyMonitor?: boolean | SafetyMonitorConfig
  /** Enable tamper-evident audit trail. */
  auditTrail?: boolean | AuditTrailConfig
}

// ------------------------------------------------------------------ State

/** Runtime state of the plugin — kept in closure so each plugin instance is isolated. */
interface OTelPluginState {
  tracer?: ForgeTracer
  bridge?: OTelBridge
  costAttributor?: CostAttributor
  safetyMonitor?: SafetyMonitor
  auditTrail?: AuditTrail
}

// ------------------------------------------------------------------ Factory

/**
 * Create a ForgePlugin that wires OTel features to the event bus.
 *
 * Each section (tracer, bridge, costAttribution, safetyMonitor, auditTrail)
 * is independently togglable. When a section is `false` or `undefined`,
 * no objects are created and no event handlers are attached (zero cost).
 *
 * @param config - Which OTel features to enable. Defaults to all off.
 * @returns A ForgePlugin instance ready for registration.
 */
export function createOTelPlugin(config?: OTelPluginConfig): ForgePlugin {
  const cfg = config ?? {}
  const state: OTelPluginState = {}

  return {
    name: '@forgeagent/otel',
    version: '0.1.0',

    onRegister(ctx: PluginContext): void {
      const eventBus: ForgeEventBus = ctx.eventBus

      // --- Tracer ---
      if (cfg.tracer) {
        const tracerConfig: ForgeTracerConfig = typeof cfg.tracer === 'object' ? cfg.tracer : {}
        state.tracer = new ForgeTracer(tracerConfig)
      }

      // --- Bridge (requires tracer) ---
      if (cfg.bridge) {
        // If bridge is enabled but tracer is not, create a default tracer
        const tracer = state.tracer ?? new ForgeTracer()

        const bridgeConfig: OTelBridgeConfig = typeof cfg.bridge === 'object'
          ? { ...cfg.bridge, tracer }
          : { tracer }

        state.bridge = new OTelBridge(bridgeConfig)
        state.bridge.attach(eventBus)
      }

      // --- Cost Attribution ---
      if (cfg.costAttribution) {
        const costConfig: CostAttributorConfig = typeof cfg.costAttribution === 'object'
          ? cfg.costAttribution
          : {}

        state.costAttributor = new CostAttributor(costConfig)
        state.costAttributor.attach(eventBus)
      }

      // --- Safety Monitor ---
      if (cfg.safetyMonitor) {
        const safetyConfig: SafetyMonitorConfig = typeof cfg.safetyMonitor === 'object'
          ? cfg.safetyMonitor
          : {}

        state.safetyMonitor = new SafetyMonitor(safetyConfig)
        state.safetyMonitor.attach(eventBus)
      }

      // --- Audit Trail ---
      if (cfg.auditTrail) {
        const auditConfig: AuditTrailConfig = typeof cfg.auditTrail === 'object'
          ? cfg.auditTrail
          : {}

        state.auditTrail = new AuditTrail(auditConfig)
        state.auditTrail.attach(eventBus)
      }
    },
  }
}

/**
 * Utility to access OTel plugin internals after registration.
 * Primarily useful for testing and retrieving cost reports / safety events.
 *
 * This is not exposed via the plugin interface to keep it minimal.
 * Instead, consumers should interact through the event bus or direct
 * references to CostAttributor / SafetyMonitor / AuditTrail.
 */
