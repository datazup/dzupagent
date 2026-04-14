/**
 * Escalation chains with async human-in-the-loop support.
 *
 * When all automated recovery strategies are exhausted, the escalation handler
 * provides a bridge for external systems (UIs, webhooks) to participate in
 * resolution decisions before the framework aborts.
 *
 * @module recovery/escalation-handler
 */

import { ForgeError } from '@dzupagent/core'
import type { DzupEventBus, DzupEvent } from '@dzupagent/core'

import type { AdapterProviderId, AgentInput } from '../types.js'
import type { RecoveryStrategy } from './adapter-recovery.js'
import { validateWebhookUrl } from '../utils/url-validator.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context provided when an escalation is triggered */
export interface EscalationContext {
  requestId: string
  failedProviderId: AdapterProviderId
  error: string
  traceId?: string | undefined
  /** Previous recovery attempts */
  attempts: RecoveryAttemptSummary[]
  /** Suggested actions */
  suggestions: string[]
}

/** Summary of a single recovery attempt */
export interface RecoveryAttemptSummary {
  strategy: RecoveryStrategy
  providerId: AdapterProviderId
  success: boolean
  error?: string | undefined
  durationMs: number
}

/** Human/system resolution of an escalation */
export interface EscalationResolution {
  action: 'retry' | 'retry-different' | 'abort' | 'override'
  /** Provider to use for override */
  providerId?: AdapterProviderId | undefined
  /** Modified input for override */
  inputOverrides?: Partial<AgentInput> | undefined
  /** Human-provided reason */
  reason?: string | undefined
}

/** Interface for handling escalations */
export interface EscalationHandler {
  /** Notify about the escalation */
  notify(context: EscalationContext): Promise<void>
  /** Wait for resolution with timeout */
  waitForResolution(requestId: string, timeoutMs: number): Promise<EscalationResolution>
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PendingResolver {
  resolve: (resolution: EscalationResolution) => void
}

// ---------------------------------------------------------------------------
// EventBusEscalationHandler
// ---------------------------------------------------------------------------

/**
 * Escalation handler that uses the DzupEventBus for notifications
 * and provides a programmatic API for resolution.
 * Designed for UI-driven approval workflows.
 */
export class EventBusEscalationHandler implements EscalationHandler {
  private readonly pendingResolutions = new Map<string, PendingResolver>()

  constructor(private readonly eventBus?: DzupEventBus) {}

  async notify(context: EscalationContext): Promise<void> {
    if (this.eventBus) {
      this.eventBus.emit({
        type: 'recovery:escalation_requested',
        requestId: context.requestId,
        failedProviderId: context.failedProviderId,
        error: context.error,
        attempts: context.attempts,
        suggestions: context.suggestions,
        timestamp: Date.now(),
      } as unknown as DzupEvent)
    }
  }

  async waitForResolution(requestId: string, timeoutMs: number): Promise<EscalationResolution> {
    return new Promise<EscalationResolution>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResolutions.delete(requestId)
        reject(
          new ForgeError({
            code: 'APPROVAL_TIMEOUT',
            message: `Escalation ${requestId} timed out after ${timeoutMs}ms`,
            recoverable: false,
          }),
        )
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()

      this.pendingResolutions.set(requestId, {
        resolve: (resolution: EscalationResolution) => {
          clearTimeout(timer)
          this.pendingResolutions.delete(requestId)
          resolve(resolution)
        },
      })
    })
  }

  /** Called by external system (UI, webhook handler) to resolve an escalation */
  resolveEscalation(requestId: string, resolution: EscalationResolution): boolean {
    const pending = this.pendingResolutions.get(requestId)
    if (!pending) return false
    pending.resolve(resolution)
    return true
  }

  /** List pending escalation IDs */
  listPending(): string[] {
    return [...this.pendingResolutions.keys()]
  }
}

// ---------------------------------------------------------------------------
// WebhookEscalationHandler
// ---------------------------------------------------------------------------

/**
 * Escalation handler that notifies via webhook.
 * Resolution must come through a separate API call (e.g., HTTP handler).
 */
export class WebhookEscalationHandler implements EscalationHandler {
  private readonly pendingResolutions = new Map<string, PendingResolver>()

  constructor(
    private readonly webhookUrl: string,
    private readonly options?: { allowHttp?: boolean },
  ) {
    // Validate URL at construction time
    validateWebhookUrl(webhookUrl, { allowHttp: options?.allowHttp })
  }

  async notify(context: EscalationContext): Promise<void> {
    validateWebhookUrl(this.webhookUrl, { allowHttp: this.options?.allowHttp })
    await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'escalation',
        ...context,
        timestamp: Date.now(),
      }),
    })
  }

  async waitForResolution(requestId: string, timeoutMs: number): Promise<EscalationResolution> {
    return new Promise<EscalationResolution>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResolutions.delete(requestId)
        reject(
          new ForgeError({
            code: 'APPROVAL_TIMEOUT',
            message: `Escalation ${requestId} timed out after ${timeoutMs}ms`,
            recoverable: false,
          }),
        )
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()

      this.pendingResolutions.set(requestId, {
        resolve: (resolution: EscalationResolution) => {
          clearTimeout(timer)
          this.pendingResolutions.delete(requestId)
          resolve(resolution)
        },
      })
    })
  }

  /** Called by external system to resolve */
  resolveEscalation(requestId: string, resolution: EscalationResolution): boolean {
    const pending = this.pendingResolutions.get(requestId)
    if (!pending) return false
    pending.resolve(resolution)
    return true
  }
}
