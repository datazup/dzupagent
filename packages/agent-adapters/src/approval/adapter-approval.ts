/**
 * AdapterApprovalGate -- Human-in-the-loop approval gates for multi-agent
 * orchestration.
 *
 * Supports three modes:
 *  - `auto`        -- no approval needed, always proceeds
 *  - `required`    -- always waits for explicit grant/reject
 *  - `conditional` -- evaluates a predicate to decide
 *
 * Additionally supports cost-based auto-approval: if `autoApproveBelowCostCents`
 * is set and the estimated cost is below the threshold, the gate auto-approves.
 *
 * Events emitted (all defined in @dzipagent/core DzipEvent):
 *   approval:requested
 *   approval:granted
 *   approval:rejected
 *
 * @example
 * ```ts
 * const gate = new AdapterApprovalGate({
 *   mode: 'required',
 *   timeoutMs: 60_000,
 *   eventBus,
 * })
 *
 * // Wrap an adapter execution with an approval gate
 * for await (const event of gate.guard(context, adapter.execute(input))) {
 *   console.log(event)
 * }
 * ```
 */

import type { DzipEventBus } from '@dzipagent/core'

import type { AdapterProviderId, AgentEvent } from '../types.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Approval mode determining when human approval is required. */
export type ApprovalMode = 'auto' | 'required' | 'conditional'

/** Outcome of an approval request. */
export type ApprovalResult = 'approved' | 'rejected' | 'timeout'

/** Context describing what is being approved. */
export interface ApprovalContext {
  /** Unique run/workflow identifier. */
  runId: string
  /** Human-readable description of what is being approved. */
  description: string
  /** Which provider would execute the work. */
  providerId: AdapterProviderId
  /** Estimated cost in cents (used for auto-approve threshold). */
  estimatedCostCents?: number
  /** Task tags for categorisation. */
  tags?: string[]
  /** Additional metadata forwarded to webhooks and events. */
  metadata?: Record<string, unknown>
}

/** A tracked approval request. */
export interface ApprovalRequest {
  requestId: string
  runId: string
  context: ApprovalContext
  requestedAt: Date
  expiresAt: Date
  status: 'pending' | 'approved' | 'rejected' | 'expired'
}

/** Configuration for the AdapterApprovalGate. */
export interface AdapterApprovalConfig {
  /** Approval mode. Default: 'auto' (no approval needed). */
  mode: ApprovalMode
  /** Timeout in ms for waiting for approval. Default: 300_000 (5 min). */
  timeoutMs?: number
  /** Condition for 'conditional' mode. Returns true when approval IS needed. */
  condition?: (context: ApprovalContext) => boolean | Promise<boolean>
  /** Webhook URL to notify when approval is requested. */
  webhookUrl?: string
  /** Auto-approve if estimated cost is below this threshold (cents). */
  autoApproveBelowCostCents?: number
  /** Event bus for approval events. */
  eventBus?: DzipEventBus
}

// ---------------------------------------------------------------------------
// Internal types for the resolve/reject callback pair
// ---------------------------------------------------------------------------

interface PendingResolvers {
  resolve: (result: ApprovalResult) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

// ---------------------------------------------------------------------------
// AdapterApprovalGate
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 300_000 // 5 minutes

export class AdapterApprovalGate {
  private readonly config: AdapterApprovalConfig
  private readonly timeoutMs: number
  private readonly pending = new Map<string, ApprovalRequest>()
  private readonly resolvers = new Map<string, PendingResolvers>()

  constructor(config: AdapterApprovalConfig) {
    this.config = config
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Request approval and wait for it.
   *
   * Returns immediately for 'auto' mode.
   * For 'conditional', evaluates the condition first.
   */
  async requestApproval(context: ApprovalContext): Promise<ApprovalResult> {
    // 1. Auto mode -- always approve
    if (this.config.mode === 'auto') {
      return 'approved'
    }

    // 2. Cost-based auto-approval
    if (
      this.config.autoApproveBelowCostCents !== undefined &&
      context.estimatedCostCents !== undefined &&
      context.estimatedCostCents < this.config.autoApproveBelowCostCents
    ) {
      return 'approved'
    }

    // 3. Conditional mode -- evaluate predicate
    if (this.config.mode === 'conditional' && this.config.condition) {
      const needsApproval = await this.config.condition(context)
      if (!needsApproval) {
        return 'approved'
      }
    }

    // 4. Create tracked request
    const requestId = crypto.randomUUID()
    const now = new Date()
    const expiresAt = new Date(now.getTime() + this.timeoutMs)

    const request: ApprovalRequest = {
      requestId,
      runId: context.runId,
      context,
      requestedAt: now,
      expiresAt,
      status: 'pending',
    }

    this.pending.set(requestId, request)

    // 5. Emit approval:requested event
    this.emitEvent({ type: 'approval:requested', runId: context.runId, plan: context })

    // 6. Fire-and-forget webhook notification
    if (this.config.webhookUrl) {
      this.notifyWebhook(requestId, context).catch(() => {
        // Non-critical -- webhook failure must not block approval flow
      })
    }

    // 7. Wait for grant/reject or timeout
    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        const req = this.pending.get(requestId)
        if (req && req.status === 'pending') {
          req.status = 'expired'
          this.pending.delete(requestId)
          this.resolvers.delete(requestId)
          this.emitEvent({
            type: 'approval:rejected',
            runId: context.runId,
            reason: `Approval timed out after ${String(this.timeoutMs)}ms`,
          })
          resolve('timeout')
        }
      }, this.timeoutMs)

      this.resolvers.set(requestId, { resolve, timer })
    })
  }

  /**
   * Programmatically grant approval for a pending request.
   * Used by external systems (HTTP endpoints, webhooks).
   *
   * @returns `true` if the request was found and granted, `false` otherwise.
   */
  grant(requestId: string, approvedBy?: string): boolean {
    const request = this.pending.get(requestId)
    const resolvers = this.resolvers.get(requestId)

    if (!request || request.status !== 'pending' || !resolvers) {
      return false
    }

    request.status = 'approved'
    this.cleanup(requestId, resolvers)

    this.emitEvent({
      type: 'approval:granted',
      runId: request.runId,
      approvedBy,
    })

    resolvers.resolve('approved')
    return true
  }

  /**
   * Programmatically reject a pending request.
   *
   * @returns `true` if the request was found and rejected, `false` otherwise.
   */
  reject(requestId: string, reason?: string): boolean {
    const request = this.pending.get(requestId)
    const resolvers = this.resolvers.get(requestId)

    if (!request || request.status !== 'pending' || !resolvers) {
      return false
    }

    request.status = 'rejected'
    this.cleanup(requestId, resolvers)

    this.emitEvent({
      type: 'approval:rejected',
      runId: request.runId,
      reason,
    })

    resolvers.resolve('rejected')
    return true
  }

  /**
   * Get a pending approval request by ID.
   */
  getRequest(requestId: string): ApprovalRequest | undefined {
    return this.pending.get(requestId)
  }

  /**
   * List all pending approval requests.
   */
  listPending(): ApprovalRequest[] {
    return [...this.pending.values()].filter((r) => r.status === 'pending')
  }

  /**
   * Clear all pending requests, cancelling any outstanding timers.
   */
  clear(): void {
    for (const [requestId, resolvers] of this.resolvers) {
      if (resolvers.timer !== undefined) {
        clearTimeout(resolvers.timer)
      }
      this.resolvers.delete(requestId)
    }
    this.pending.clear()
  }

  /**
   * Convenience: wrap an async generator, inserting an approval gate
   * before execution begins. If rejected or timed out, yields an
   * `adapter:failed` event and returns.
   */
  async *guard(
    context: ApprovalContext,
    source: AsyncGenerator<AgentEvent>,
  ): AsyncGenerator<AgentEvent> {
    const result = await this.requestApproval(context)

    if (result === 'approved') {
      yield* source
      return
    }

    // Rejected or timed out -- yield failure event and drain source
    const message = result === 'rejected'
      ? 'Approval rejected'
      : 'Approval timeout'

    const failedEvent: AgentEvent = {
      type: 'adapter:failed',
      providerId: context.providerId,
      error: message,
      timestamp: Date.now(),
    }

    yield failedEvent

    // Ensure the source generator is properly closed
    await source.return(undefined)
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private cleanup(requestId: string, resolvers: PendingResolvers): void {
    if (resolvers.timer !== undefined) {
      clearTimeout(resolvers.timer)
    }
    this.pending.delete(requestId)
    this.resolvers.delete(requestId)
  }

  private emitEvent(
    event:
      | { type: 'approval:requested'; runId: string; plan: unknown }
      | { type: 'approval:granted'; runId: string; approvedBy?: string }
      | { type: 'approval:rejected'; runId: string; reason?: string },
  ): void {
    if (this.config.eventBus) {
      this.config.eventBus.emit(event as Parameters<DzipEventBus['emit']>[0])
    }
  }

  private async notifyWebhook(requestId: string, context: ApprovalContext): Promise<void> {
    if (!this.config.webhookUrl) return

    await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'approval_requested',
        requestId,
        runId: context.runId,
        description: context.description,
        providerId: context.providerId,
        estimatedCostCents: context.estimatedCostCents,
        tags: context.tags,
        metadata: context.metadata,
      }),
    })
  }
}
