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
import { createHmac, randomUUID } from 'node:crypto'
import {
  fetchWithOutboundUrlPolicy,
  type DzupEventBus,
  type HookContext,
  type ApprovalRequest,
  type ContactChannel,
} from '@dzupagent/core'
import {
  APPROVAL_PENDING_KEY,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type ApprovalConfig,
  type ApprovalDecision,
  type ApprovalPendingState,
  type ApprovalRequestInput,
  type ApprovalResult,
  type ApprovalWaitOptions,
} from './approval-types.js'
import { ApprovalSuspendedError } from './approval-errors.js'
import { omitUndefined } from '../utils/exact-optional.js'

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
    const approvalRequest: ApprovalRequest = omitUndefined({
      contactId,
      runId,
      type: 'approval',
      channel,
      timeoutAt: timeoutMs !== undefined
        ? new Date(Date.now() + timeoutMs).toISOString()
        : undefined,
      data: omitUndefined({
        question: typeof plan === 'string' ? plan : 'Approve this action?',
        context: typeof plan === 'object' && plan !== null
          ? safeJsonStringify(plan)
          : undefined,
      }),
    })

    if (options.signal?.aborted) {
      this.eventBus.emit({
        type: 'approval:cancelled',
        runId,
        contactId,
        reason: this.abortReason(options.signal),
      })
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
          })
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
            })
            resolve('timeout')
          }
        }, timeoutMs).unref()
      }
    })
  }

  /**
   * Durable approval entry point.
   *
   * When configured with `durableResume: true` and a `checkpointStore`, this
   * persists pending approval state and throws {@link ApprovalSuspendedError}
   * so the outer run driver can abandon the in-process wait and reschedule
   * resumption (e.g. via {@link resume}) after process restart.
   *
   * Otherwise it falls back to the legacy in-process {@link waitForApproval}
   * flow for backwards compatibility.
   */
  async requestApproval(
    input: ApprovalRequestInput,
    ctx?: HookContext,
    options: ApprovalWaitOptions = {},
  ): Promise<ApprovalResult> {
    const store = this.config.checkpointStore
    if (this.config.durableResume === true && store !== undefined) {
      const contactId = input.contactId ?? randomUUID()
      const channel = input.channel ?? this.config.channel ?? 'in-app'
      const timeoutMs = this.config.timeoutMs
      const requestedAt = Date.now()
      const resumeToken = randomUUID()
      const state: ApprovalPendingState = {
        runId: input.runId,
        contactId,
        plan: input.plan,
        channel,
        requestedAt,
        timeoutAt: timeoutMs !== undefined ? requestedAt + timeoutMs : null,
        resumeToken,
      }
      await store.save(input.runId, APPROVAL_PENDING_KEY, state)

      // Notify listeners so external resumers (HTTP, queue worker) see the
      // pending request alongside the persisted state.
      this.eventBus.emit({
        type: 'approval:requested',
        runId: input.runId,
        plan: input.plan,
        contactId,
        channel: channel as ContactChannel,
      })

      throw new ApprovalSuspendedError(resumeToken, input.runId)
    }

    return this.waitForApproval(input.runId, input.plan, ctx, options)
  }

  /**
   * Resume a previously suspended approval.
   *
   * Loads the persisted pending state, deletes it, and emits an
   * `approval:granted` or `approval:rejected` event so any in-process
   * listeners that survived restart can react.
   *
   * @throws if no pending approval exists for `runId`.
   */
  async resume(runId: string, decision: ApprovalDecision): Promise<void> {
    const store = this.config.checkpointStore
    if (store === undefined) {
      throw new Error('ApprovalGate.resume requires a checkpointStore on the config')
    }
    const state = await store.load(runId, APPROVAL_PENDING_KEY)
    if (!state) {
      throw new Error(`No pending approval for runId: ${runId}`)
    }
    await store.delete(runId, APPROVAL_PENDING_KEY)

    if (decision.decision === 'approved') {
      this.eventBus.emit({ type: 'approval:granted', runId })
    } else {
      this.eventBus.emit(omitUndefined({
        type: 'approval:rejected' as const,
        runId,
        reason: decision.reason,
      }))
    }
  }

  /**
   * Inspect the persisted pending state for a run, if any.
   *
   * Useful for resumers that need to validate timeouts or rebuild a
   * `HumanContactRequest` before deciding whether to resume.
   */
  async loadPending(runId: string): Promise<ApprovalPendingState | null> {
    const store = this.config.checkpointStore
    if (store === undefined) return null
    return store.load(runId, APPROVAL_PENDING_KEY)
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
    const webhookUrl = this.config.webhookUrl
    const body = safeJsonStringify({
      type: 'approval_requested',
      runId,
      plan,
      contactId: request.contactId,
      channel: request.channel,
    })
    const delays = [100, 300, 900]
    let lastError: Error = new Error('unknown')
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (attempt > 0) {
        const jitter = Math.floor(Math.random() * 50)
        await new Promise<void>((r) => setTimeout(r, delays[attempt - 1]! + jitter).unref())
      }
      try {
        const headers = this.buildWebhookHeaders(body)
        const res = await fetchWithOutboundUrlPolicy(webhookUrl, {
          method: 'POST',
          headers,
          body,
        }, {
          policy: this.config.webhookOutboundUrlPolicy,
        })
        if (res.ok) return
        lastError = new Error(`webhook returned ${res.status}`)
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
      }
    }
    this.eventBus.emit({
      type: 'approval:webhook_failed',
      runId,
      webhookUrl,
      attempts: delays.length,
      error: lastError.message,
    })
    if (this.config.webhookDLQ) {
      try {
        await this.config.webhookDLQ(runId, webhookUrl, lastError)
      } catch {
        // DLQ callback errors must not surface to the caller
      }
    }
  }

  private buildWebhookHeaders(body: string): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (!this.config.webhookSigningSecret) return headers

    const timestamp = Math.floor(Date.now() / 1000).toString()
    const signature = createHmac('sha256', this.config.webhookSigningSecret)
      .update(`${timestamp}.${body}`)
      .digest('hex')
    headers['X-DzupAgent-Timestamp'] = timestamp
    headers['X-DzupAgent-Signature'] = `sha256=${signature}`
    return headers
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * JSON.stringify that degrades gracefully on circular references or
 * non-serialisable values rather than throwing. Returns a fallback string
 * when serialization fails so callers can always produce a body.
 */
function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ _serialisationError: true })
  }
}
