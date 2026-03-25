/**
 * ComplianceAuditLogger — high-level audit logger that integrates
 * with the ForgeEventBus and ComplianceAuditStore.
 *
 * Automatically records security-relevant events when attached
 * to an event bus, and provides a manual `record()` method for
 * custom audit entries.
 */

import type { ForgeEventBus } from '../../events/event-bus.js'
import type { ComplianceAuditStore } from './audit-store.js'
import type { ComplianceAuditEntry, AuditResult } from './audit-types.js'

export interface AuditLoggerConfig {
  store: ComplianceAuditStore
}

/** Generate a simple unique ID (no external deps). */
function generateId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return `audit_${timestamp}_${random}`
}

/**
 * Maps ForgeEvent types to audit actions and extracts relevant details.
 */
function eventToAuditAction(eventType: string): string | undefined {
  // Only auto-record security-relevant events
  const mapping: Record<string, string> = {
    'policy:evaluated': 'policy.evaluated',
    'policy:denied': 'policy.denied',
    'policy:set_updated': 'policy.set_updated',
    'safety:violation': 'safety.violation',
    'safety:blocked': 'safety.blocked',
    'safety:kill_requested': 'safety.kill_requested',
    'memory:threat_detected': 'memory.threat_detected',
    'memory:quarantined': 'memory.quarantined',
    'agent:started': 'agent.started',
    'agent:completed': 'agent.completed',
    'agent:failed': 'agent.failed',
    'tool:called': 'tool.called',
    'tool:error': 'tool.error',
  }
  return mapping[eventType]
}

function eventToResult(eventType: string): AuditResult {
  if (eventType.includes('denied') || eventType.includes('blocked')) return 'denied'
  if (eventType.includes('failed') || eventType.includes('error') || eventType.includes('violation')) return 'failed'
  return 'success'
}

export class ComplianceAuditLogger {
  private readonly store: ComplianceAuditStore
  private unsubscribe: (() => void) | undefined

  constructor(config: AuditLoggerConfig) {
    this.store = config.store
  }

  /**
   * Attach to an event bus. Security-relevant events will be
   * automatically recorded as audit entries.
   */
  attach(eventBus: ForgeEventBus): void {
    this.detach()

    this.unsubscribe = eventBus.onAny((event) => {
      const action = eventToAuditAction(event.type)
      if (!action) return

      // Extract details from the event, excluding 'type'
      const { type: _type, ...details } = event as Record<string, unknown> & { type: string }

      // Fire-and-forget — audit failures are non-fatal
      void this.record({
        actor: { id: 'system', type: 'system' },
        action,
        result: eventToResult(event.type),
        details: details as Record<string, unknown>,
      }).catch(() => {
        // Silently ignore audit write failures per non-fatal pattern
      })
    })
  }

  /** Detach from the event bus, stopping automatic recording. */
  detach(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = undefined
    }
  }

  /**
   * Manually record an audit entry.
   * The store handles seq, previousHash, hash assignment.
   */
  async record(
    entry: Omit<ComplianceAuditEntry, 'id' | 'seq' | 'previousHash' | 'hash' | 'timestamp'>,
  ): Promise<ComplianceAuditEntry> {
    return this.store.append({
      ...entry,
      id: generateId(),
      timestamp: new Date(),
    })
  }

  /** Clean up resources. Equivalent to detach(). */
  dispose(): void {
    this.detach()
  }
}
