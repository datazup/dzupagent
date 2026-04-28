/**
 * Approval gate -- pauses agent execution until human approval.
 *
 * Used in production pipelines where actions have real-world consequences
 * (deployments, database migrations, API calls). The gate emits an
 * `approval:requested` event and waits for an `approval:granted` or
 * `approval:rejected` event before proceeding.
 *
 * Internally delegates to `HumanContactTool` types for the approval request,
 * ensuring shared type definitions between the approval gate and the
 * general-purpose human-contact tool.
 *
 * @example
 * ```ts
 * const gate = new ApprovalGate(
 *   { mode: 'required' },
 *   eventBus,
 * )
 * const result = await gate.waitForApproval(runId, plan)
 * if (result === 'rejected') throw new Error('Run rejected')
 * ```
 */
import { randomUUID } from 'node:crypto'
import type { DzupEventBus, HookContext, ApprovalRequest, ContactChannel } from '@dzupagent/core'
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type ApprovalConfig,
  type ApprovalResult,
  type ApprovalWaitOptions,
} from './approval-types.js'

export class ApprovalGate {
  constructor(
    private config: ApprovalConfig,
    private eventBus: DzupEventBus,
  ) {}

  /**
   * Check if approval is needed and wait for it.
   * Returns immediately for 'auto' mode.
   */
  async waitForApproval(
    runId: string,
    plan: unknown,
    ctx?: HookContext,
    options: ApprovalWaitOptions = {},
  ): Promise<ApprovalResult> {
    if (this.config.mode === 'auto') return 'approved'

    // Check condition for 'conditional' mode
    if (this.config.mode === 'conditional' && this.config.condition && ctx) {
      const needsApproval = await this.config.condition(plan, ctx)
      if (!needsApproval) return 'approved'
    }

    // Build a HumanContactRequest (approval mode) for structured tracing
    const contactId = randomUUID()
    const channel: ContactChannel = this.config.channel ?? 'in-app'
    const timeoutMs = this.getEffectiveTimeoutMs()
    const approvalRequest: ApprovalRequest = {
      contactId,
      runId,
      type: 'approval',
      channel,
      timeoutAt: timeoutMs !== undefined
        ? new Date(Date.now() + timeoutMs).toISOString()
        : undefined,
      data: {
        question: typeof plan === 'string' ? plan : 'Approve this action?',
        context: typeof plan === 'object' && plan !== null
          ? JSON.stringify(plan)
          : undefined,
      },
    }

    if (options.signal?.aborted) {
      this.eventBus.emit({
        type: 'approval:cancelled',
        runId,
        contactId,
        reason: this.abortReason(options.signal),
      } as never)
      return 'cancelled'
    }

    // Emit approval request (includes the structured request for tracing)
    this.eventBus.emit({
      type: 'approval:requested',
      runId,
      plan,
      contactId,
      channel,
      request: approvalRequest,
    })

    // Notify webhook if configured
    if (this.config.webhookUrl) {
      this.notifyWebhook(runId, plan, approvalRequest).catch(() => {
        // Non-critical -- webhook failure should not block approval
      })
    }

    // Wait for approval/rejection event
    return new Promise<ApprovalResult>((resolve) => {
      let resolved = false
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined

      const cleanup = () => {
        resolved = true
        if (timeoutHandle) clearTimeout(timeoutHandle)
        options.signal?.removeEventListener('abort', onAbort)
        unsubGrant()
        unsubReject()
      }

      const unsubGrant = this.eventBus.on('approval:granted', (event) => {
        if (event.runId === runId && !resolved) {
          cleanup()
          resolve('approved')
        }
      })

      const unsubReject = this.eventBus.on('approval:rejected', (event) => {
        if (event.runId === runId && !resolved) {
          cleanup()
          resolve('rejected')
        }
      })

      const onAbort = () => {
        if (!resolved) {
          cleanup()
          this.eventBus.emit({
            type: 'approval:cancelled',
            runId,
            contactId,
            reason: this.abortReason(options.signal),
          } as never)
          resolve('cancelled')
        }
      }

      options.signal?.addEventListener('abort', onAbort, { once: true })

      // Timeout
      if (timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          if (!resolved) {
            cleanup()
            this.eventBus.emit({
              type: 'approval:timed_out',
              runId,
              contactId,
              timeoutMs,
            } as never)
            resolve('timeout')
          }
        }, timeoutMs)
      }
    })
  }

  private getEffectiveTimeoutMs(): number | undefined {
    if (this.config.timeoutMs !== undefined) return this.config.timeoutMs
    if (this.config.durableResume) return undefined
    return DEFAULT_APPROVAL_TIMEOUT_MS
  }

  private abortReason(signal?: AbortSignal): string {
    const reason = signal?.reason
    if (reason instanceof Error) return reason.message
    if (typeof reason === 'string') return reason
    return 'approval wait cancelled'
  }

  private async notifyWebhook(
    runId: string,
    plan: unknown,
    request: ApprovalRequest,
  ): Promise<void> {
    if (!this.config.webhookUrl) return
    await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'approval_requested',
        runId,
        plan,
        contactId: request.contactId,
        channel: request.channel,
      }),
    })
  }
}
