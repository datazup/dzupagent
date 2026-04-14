/**
 * Runtime Safety Monitor — watches agent activity for security violations.
 *
 * Subscribes to DzupEventBus and scans content on-demand using configurable
 * SafetyRules. Violations are recorded and emitted as safety events.
 */

import type { DzupEventBus } from '../../events/event-bus.js'
import type { SafetyCategory, SafetySeverity, SafetyAction, SafetyViolation, SafetyRule } from './built-in-rules.js'
import { getBuiltInRules } from './built-in-rules.js'

export type { SafetyCategory, SafetySeverity, SafetyAction, SafetyViolation, SafetyRule }

export interface SafetyMonitorConfig {
  /** Custom rules to use instead of (or in addition to) built-in rules */
  rules?: SafetyRule[]
  /** If true, provided rules replace built-in rules; otherwise they extend them */
  replaceBuiltInRules?: boolean
  /** Event bus to attach to */
  eventBus?: DzupEventBus
}

export interface SafetyMonitor {
  /** Attach to an event bus, subscribing to relevant events */
  attach(eventBus: DzupEventBus): void
  /** Detach from the current event bus */
  detach(): void
  /** Scan content on-demand and return all violations found */
  scanContent(content: string, context?: Record<string, unknown>): SafetyViolation[]
  /** Get all recorded violations */
  getViolations(): ReadonlyArray<SafetyViolation>
  /** Clear recorded violations and unsubscribe */
  dispose(): void
}

/**
 * Create a new SafetyMonitor instance with the given configuration.
 */
export function createSafetyMonitor(config?: SafetyMonitorConfig): SafetyMonitor {
  const builtIn = config?.replaceBuiltInRules ? [] : getBuiltInRules()
  const rules: SafetyRule[] = [...builtIn, ...(config?.rules ?? [])]
  const violations: SafetyViolation[] = []
  let unsubscribers: Array<() => void> = []
  let currentBus: DzupEventBus | undefined

  function recordViolation(violation: SafetyViolation, bus?: DzupEventBus): void {
    violations.push(violation)
    const emitBus = bus ?? currentBus
    if (!emitBus) return

    try {
      emitBus.emit({
        type: 'safety:violation',
        category: violation.category,
        severity: violation.severity,
        message: violation.message,
        ...(violation.agentId !== undefined && { agentId: violation.agentId }),
      })

      if (violation.action === 'block') {
        emitBus.emit({
          type: 'safety:blocked',
          category: violation.category,
          action: violation.action,
          ...(violation.agentId !== undefined && { agentId: violation.agentId }),
        })
      } else if (violation.action === 'kill') {
        emitBus.emit({
          type: 'safety:kill_requested',
          agentId: violation.agentId ?? 'unknown',
          reason: violation.message,
        })
      }
    } catch {
      // Non-fatal: event emission failure should not crash the monitor
    }
  }

  function scanContent(content: string, context?: Record<string, unknown>): SafetyViolation[] {
    const found: SafetyViolation[] = []
    for (const rule of rules) {
      try {
        const violation = rule.check(content, context)
        if (violation) {
          found.push(violation)
          recordViolation(violation)
        }
      } catch {
        // Non-fatal: individual rule failure should not block scanning
      }
    }
    return found
  }

  function attach(eventBus: DzupEventBus): void {
    // Detach from any previous bus first
    detach()
    currentBus = eventBus

    // Subscribe to tool:error events for tool abuse detection
    const unsubToolError = eventBus.on('tool:error', (event) => {
      // Scan the error message for potential security issues
      scanContent(event.message, { source: 'tool:error', toolName: event.toolName })
    })
    unsubscribers.push(unsubToolError)

    // Subscribe to memory:written events for memory poisoning detection
    const unsubMemoryWritten = eventBus.on('memory:written', (event) => {
      scanContent(event.key, { source: 'memory:written', namespace: event.namespace })
    })
    unsubscribers.push(unsubMemoryWritten)
  }

  function detach(): void {
    for (const unsub of unsubscribers) {
      try {
        unsub()
      } catch {
        // Non-fatal
      }
    }
    unsubscribers = []
    currentBus = undefined
  }

  function dispose(): void {
    detach()
    violations.length = 0
  }

  const monitor: SafetyMonitor = {
    attach,
    detach,
    scanContent,
    getViolations: () => [...violations],
    dispose,
  }

  // Auto-attach if an event bus was provided in config
  if (config?.eventBus) {
    attach(config.eventBus)
  }

  return monitor
}
