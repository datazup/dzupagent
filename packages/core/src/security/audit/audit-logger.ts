/**
 * ComplianceAuditLogger — high-level audit logger that integrates
 * with the DzupEventBus and ComplianceAuditStore.
 *
 * Automatically records security-relevant events when attached
 * to an event bus, and provides a manual `record()` method for
 * custom audit entries.
 */

import type { DzupEventBus } from '../../events/event-bus.js'
import type { ComplianceAuditStore } from './audit-store.js'
import type { ComplianceAuditEntry, AuditResult } from './audit-types.js'

export interface AuditLoggerConfig {
  store: ComplianceAuditStore
  /**
   * Optional sink invoked when a fire-and-forget audit write fails. The error
   * is otherwise swallowed (audit failures are non-fatal). The most recent
   * error is also surfaced by `flush()` so graceful-shutdown paths can react.
   */
  onError?: (error: unknown) => void
}

/** Generate a simple unique ID (no external deps). */
function generateId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return `audit_${timestamp}_${random}`
}

/**
 * Maps DzupEvent types to audit actions and extracts relevant details.
 */
function eventToAuditAction(eventType: string): string | undefined {
  // Only auto-record security-relevant events
  const mapping: Record<string, string> = {
    'policy:evaluated': 'policy.evaluated',
    'policy:denied': 'policy.denied',
    'policy:set_updated': 'policy.set_updated',
    'policy:conformance_violation': 'policy.conformance_violation',
    'policy:legacy_option_deprecated': 'policy.legacy_option_deprecated',
    'safety:violation': 'safety.violation',
    'safety:blocked': 'safety.blocked',
    'safety:kill_requested': 'safety.kill_requested',
    'memory:threat_detected': 'memory.threat_detected',
    'memory:quarantined': 'memory.quarantined',
    'agent:started': 'agent.started',
    'agent:completed': 'agent.completed',
    'agent:failed': 'agent.failed',
    'tool:called': 'tool.called',
    'tool:result': 'tool.result',
    'tool:error': 'tool.error',
    'llm:invoked': 'llm.invoked',
  }
  return mapping[eventType]
}

function eventToResult(eventType: string): AuditResult {
  if (eventType.includes('denied') || eventType.includes('blocked')) return 'denied'
  if (eventType.includes('failed') || eventType.includes('error') || eventType.includes('violation')) return 'failed'
  return 'success'
}

function inputMetadataKeys(input: unknown): string[] {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return []
  return Object.keys(input as Record<string, unknown>)
}

function auditDetailsForEvent(event: Record<string, unknown> & { type: string }): Record<string, unknown> {
  const { type: _type, ...details } = event

  if (event.type === 'tool:result') {
    const sanitized = { ...details }
    if ('output' in sanitized) {
      delete sanitized.output
      sanitized.outputRedacted = true
    }
    return sanitized
  }

  if (event.type !== 'tool:called') return details

  const sanitized = { ...details }
  if ('input' in sanitized) {
    if (!Array.isArray(sanitized.inputMetadataKeys)) {
      sanitized.inputMetadataKeys = inputMetadataKeys(sanitized.input)
    }
    delete sanitized.input
    sanitized.inputRedacted = true
  }
  return sanitized
}

export class ComplianceAuditLogger {
  private readonly store: ComplianceAuditStore
  private readonly onError: ((error: unknown) => void) | undefined
  private unsubscribe: (() => void) | undefined
  /** Tracks in-flight fire-and-forget writes so `flush()` can drain them. */
  private readonly pending = new Set<Promise<void>>()
  /** Most recent sink error captured during fire-and-forget writes. */
  private lastError: unknown

  constructor(config: AuditLoggerConfig) {
    this.store = config.store
    this.onError = config.onError
  }

  /**
   * Attach to an event bus. Security-relevant events will be
   * automatically recorded as audit entries.
   */
  attach(eventBus: DzupEventBus): void {
    this.detach()

    this.unsubscribe = eventBus.onAny((event) => {
      const action = eventToAuditAction(event.type)
      if (!action) return

      const details = auditDetailsForEvent(event as Record<string, unknown> & { type: string })

      // Track the write so flush() can await drain; capture sink errors so
      // they can be surfaced after flush() instead of being silently lost.
      const writePromise = this.record({
        actor: { id: 'system', type: 'system' },
        action,
        result: eventToResult(event.type),
        details: details as Record<string, unknown>,
      }).then(
        () => undefined,
        (err: unknown) => {
          this.lastError = err
          if (this.onError) {
            try {
              this.onError(err)
            } catch {
              // Sink error handler must not itself throw out of audit path.
            }
          }
        },
      )

      this.pending.add(writePromise)
      void writePromise.finally(() => {
        this.pending.delete(writePromise)
      })
    })
  }

  /**
   * Drain any pending fire-and-forget audit writes. Resolves once all
   * in-flight promises have settled. If a sink error occurred during the
   * drained writes, it is rethrown (the most recent error wins) so callers
   * such as graceful-shutdown can surface it.
   *
   * Safe to call repeatedly; new writes that arrive after the snapshot is
   * taken are not awaited in the current call.
   */
  async flush(): Promise<void> {
    // Snapshot to avoid awaiting writes that arrive mid-drain forever.
    const inFlight = Array.from(this.pending)
    if (inFlight.length > 0) {
      await Promise.allSettled(inFlight)
    }
    const err = this.lastError
    if (err !== undefined) {
      this.lastError = undefined
      throw err
    }
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
