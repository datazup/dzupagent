/**
 * Approval gate — pauses agent execution until human approval.
 *
 * Used in production pipelines where actions have real-world consequences
 * (deployments, database migrations, API calls). The gate emits an
 * `approval:requested` event and waits for an `approval:granted` or
 * `approval:rejected` event before proceeding.
 *
 * @example
 * ```ts
 * const gate = new ApprovalGate(
 *   { mode: 'required', timeoutMs: 300_000 },
 *   eventBus,
 * )
 * const result = await gate.waitForApproval(runId, plan)
 * if (result === 'rejected') throw new Error('Run rejected')
 * ```
 */
import type { DzupEventBus } from '@dzupagent/core'
import type { HookContext } from '@dzupagent/core'
import type { ApprovalConfig, ApprovalResult } from './approval-types.js'

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
  ): Promise<ApprovalResult> {
    if (this.config.mode === 'auto') return 'approved'

    // Check condition for 'conditional' mode
    if (this.config.mode === 'conditional' && this.config.condition && ctx) {
      const needsApproval = await this.config.condition(plan, ctx)
      if (!needsApproval) return 'approved'
    }

    // Emit approval request
    this.eventBus.emit({ type: 'approval:requested', runId, plan })

    // Notify webhook if configured
    if (this.config.webhookUrl) {
      this.notifyWebhook(runId, plan).catch(() => {
        // Non-critical — webhook failure should not block approval
      })
    }

    // Wait for approval/rejection event
    return new Promise<ApprovalResult>((resolve) => {
      let resolved = false

      const cleanup = () => { resolved = true }

      const unsubGrant = this.eventBus.on('approval:granted', (event) => {
        if (event.runId === runId && !resolved) {
          cleanup()
          unsubGrant()
          unsubReject()
          resolve('approved')
        }
      })

      const unsubReject = this.eventBus.on('approval:rejected', (event) => {
        if (event.runId === runId && !resolved) {
          cleanup()
          unsubGrant()
          unsubReject()
          resolve('rejected')
        }
      })

      // Timeout
      if (this.config.timeoutMs) {
        setTimeout(() => {
          if (!resolved) {
            cleanup()
            unsubGrant()
            unsubReject()
            this.eventBus.emit({
              type: 'approval:rejected',
              runId,
              reason: `Approval timed out after ${this.config.timeoutMs}ms`,
            })
            resolve('timeout')
          }
        }, this.config.timeoutMs)
      }
    })
  }

  private async notifyWebhook(runId: string, plan: unknown): Promise<void> {
    if (!this.config.webhookUrl) return
    await fetch(this.config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'approval_requested', runId, plan }),
    })
  }
}
