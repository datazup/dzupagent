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
 * Events emitted (all defined in @dzupagent/core DzupEvent):
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

import { defaultLogger } from "@dzupagent/core/utils";
import type { DzupEvent } from "@dzupagent/core/events";
import { ForgeError } from "@dzupagent/core/events";

import type { AgentEvent, AgentStreamEvent } from "../types.js";
import { validateWebhookUrl } from "../utils/url-validator.js";
import { notifyApprovalWebhook } from "./approval-webhook.js";
import { InMemoryApprovalAuditStore } from "./approval-audit.js";
import type {
  ApprovalAuditEntry,
  ApprovalAuditStore,
} from "./approval-audit.js";
import type {
  AdapterApprovalConfig,
  ApprovalContext,
  ApprovalRequest,
  ApprovalResult,
} from "./approval-types.js";
export type {
  AdapterApprovalConfig,
  ApprovalContext,
  ApprovalMode,
  ApprovalRequest,
  ApprovalResult,
} from "./approval-types.js";

function isProviderRawStreamEvent(
  event: AgentStreamEvent
): event is Extract<AgentStreamEvent, { type: "adapter:provider_raw" }> {
  return event.type === "adapter:provider_raw";
}

// ---------------------------------------------------------------------------
// Internal types for the resolve/reject callback pair
// ---------------------------------------------------------------------------

interface PendingResolvers {
  resolve: (result: ApprovalResult) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  removeAbortListener?: () => void;
}

// ---------------------------------------------------------------------------
// AdapterApprovalGate
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export class AdapterApprovalGate {
  private readonly config: AdapterApprovalConfig;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, ApprovalRequest>();
  private readonly resolvers = new Map<string, PendingResolvers>();
  private readonly auditStore: ApprovalAuditStore;

  constructor(config: AdapterApprovalConfig) {
    this.config = config;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.auditStore = config.auditStore ?? new InMemoryApprovalAuditStore();

    // Validate webhook URL at construction time (fail fast)
    if (config.webhookUrl) {
      validateWebhookUrl(config.webhookUrl, config.webhookUrlValidation);
    }
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
  async requestApproval(context: ApprovalContext, signal?: AbortSignal): Promise<ApprovalResult> {
    this.throwIfAborted(signal);
    // 1. Auto mode -- always approve
    if (this.config.mode === "auto") {
      this.recordAudit({
        requestId: crypto.randomUUID(),
        providerId: context.providerId,
        action: "auto_approved",
        timestamp: Date.now(),
        actor: "auto-policy",
        reason: "Auto-approved by policy (auto mode)",
        estimatedCostCents: context.estimatedCostCents,
        mode: this.config.mode,
      });
      return "approved";
    }

    // 2. Cost-based auto-approval
    if (
      this.config.autoApproveBelowCostCents !== undefined &&
      context.estimatedCostCents !== undefined &&
      context.estimatedCostCents < this.config.autoApproveBelowCostCents
    ) {
      this.recordAudit({
        requestId: crypto.randomUUID(),
        providerId: context.providerId,
        action: "auto_approved",
        timestamp: Date.now(),
        actor: "auto-policy",
        reason: "Auto-approved by cost threshold",
        estimatedCostCents: context.estimatedCostCents,
        mode: this.config.mode,
      });
      return "approved";
    }

    // 3. Conditional mode -- evaluate predicate
    if (this.config.mode === "conditional" && this.config.condition) {
      const needsApproval = await this.config.condition(context);
      this.throwIfAborted(signal);
      if (!needsApproval) {
        this.recordAudit({
          requestId: crypto.randomUUID(),
          providerId: context.providerId,
          action: "auto_approved",
          timestamp: Date.now(),
          actor: "auto-policy",
          reason: "Auto-approved by conditional predicate",
          estimatedCostCents: context.estimatedCostCents,
          mode: this.config.mode,
        });
        return "approved";
      }
    }

    // 4. Create tracked request
    const requestId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.timeoutMs);

    const request: ApprovalRequest = {
      requestId,
      runId: context.runId,
      context,
      requestedAt: now,
      expiresAt,
      status: "pending",
    };

    this.pending.set(requestId, request);

    this.recordAudit({
      requestId,
      providerId: context.providerId,
      action: "requested",
      timestamp: Date.now(),
      actor: "system",
      estimatedCostCents: context.estimatedCostCents,
      mode: this.config.mode,
    });

    // Install exact-request resolution and cancellation before notifying listeners.
    const approval = new Promise<ApprovalResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const req = this.pending.get(requestId);
        if (req && req.status === "pending") {
          req.status = "expired";
          this.cleanup(requestId, resolvers);
          this.recordAudit({
            requestId,
            providerId: context.providerId,
            action: "timed_out",
            timestamp: Date.now(),
            actor: "system",
            reason: `Timed out after ${String(this.timeoutMs)}ms`,
            mode: this.config.mode,
          });
          // NOTE: a timeout reports as `approval:rejected`, not
          // `approval:timed_out`. That conflation predates this change;
          // switching the type would alter what consumers observe.
          this.emitEvent({
            type: "approval:rejected",
            runId: context.runId,
            contactId: requestId,
            reason: `Approval timed out after ${String(this.timeoutMs)}ms`,
          });
          resolve("timeout");
        }
      }, this.timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }

      const resolvers: PendingResolvers = { resolve, timer };
      this.resolvers.set(requestId, resolvers);
      if (signal) {
        const onAbort = (): void => {
          const req = this.pending.get(requestId);
          if (!req || req.status !== "pending") return;
          req.status = "rejected";
          this.cleanup(requestId, resolvers);
          this.recordAudit({
            requestId, providerId: context.providerId, action: "rejected",
            timestamp: Date.now(), actor: "system", reason: "Approval cancelled",
            mode: this.config.mode,
          });
          this.emitEvent({
            type: "approval:rejected", runId: context.runId,
            contactId: requestId, reason: "Approval cancelled",
          });
          reject(this.abortError());
        };
        resolvers.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
    });

    if (signal?.aborted) return approval;
    this.emitEvent({
      type: "approval:requested", runId: context.runId,
      contactId: requestId, plan: context,
    });

    // A notification listener may synchronously abort, reject or grant the request.
    if (this.config.webhookUrl && this.pending.has(requestId)) {
      notifyApprovalWebhook(this.config, requestId, context).catch((err: unknown) => {
        defaultLogger.warn("[AdapterApprovalGate] approval webhook notification failed", {
          operation: "approval.webhook", requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    return approval;
  }

  /**
   * Programmatically grant approval for a pending request.
   * Used by external systems (HTTP endpoints, webhooks).
   *
   * @returns `true` if the request was found and granted, `false` otherwise.
   */
  grant(requestId: string, approvedBy?: string): boolean {
    const request = this.pending.get(requestId);
    const resolvers = this.resolvers.get(requestId);

    if (!request || request.status !== "pending" || !resolvers) {
      return false;
    }

    request.status = "approved";
    this.cleanup(requestId, resolvers);

    this.recordAudit({
      requestId,
      providerId: request.context.providerId,
      action: "granted",
      timestamp: Date.now(),
      actor: approvedBy ?? "unknown",
      mode: this.config.mode,
    });

    this.emitEvent({
      type: "approval:granted",
      runId: request.runId,
      contactId: requestId,
      approvedBy,
    });

    resolvers.resolve("approved");
    return true;
  }

  /**
   * Programmatically reject a pending request.
   *
   * @returns `true` if the request was found and rejected, `false` otherwise.
   */
  reject(requestId: string, reason?: string): boolean {
    const request = this.pending.get(requestId);
    const resolvers = this.resolvers.get(requestId);

    if (!request || request.status !== "pending" || !resolvers) {
      return false;
    }

    request.status = "rejected";
    this.cleanup(requestId, resolvers);

    this.recordAudit({
      requestId,
      providerId: request.context.providerId,
      action: "rejected",
      timestamp: Date.now(),
      actor: "user",
      reason,
      mode: this.config.mode,
    });

    this.emitEvent({
      type: "approval:rejected",
      runId: request.runId,
      contactId: requestId,
      reason,
    });

    resolvers.resolve("rejected");
    return true;
  }

  /**
   * Get a pending approval request by ID.
   */
  getRequest(requestId: string): ApprovalRequest | undefined {
    return this.pending.get(requestId);
  }

  /**
   * List all pending approval requests.
   */
  listPending(): ApprovalRequest[] {
    return [...this.pending.values()].filter((r) => r.status === "pending");
  }

  /**
   * Clear all pending requests, cancelling any outstanding timers.
   */
  clear(): void {
    for (const [requestId, resolvers] of this.resolvers) {
      this.cleanup(requestId, resolvers);
    }
    this.pending.clear();
  }

  /**
   * Dispose the gate, clearing all pending requests and timers.
   */
  dispose(): void {
    this.clear();
  }

  /**
   * Get the audit store for querying approval history.
   */
  getAuditStore(): ApprovalAuditStore {
    return this.auditStore;
  }

  /**
   * Convenience: wrap an async generator, inserting an approval gate
   * before execution begins. If rejected or timed out, yields an
   * `adapter:failed` event and returns.
   */
  guard(
    context: ApprovalContext,
    source: AsyncGenerator<AgentEvent>,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent>;
  guard(
    context: ApprovalContext,
    source: AsyncGenerator<AgentStreamEvent>,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent>;
  async *guard(
    context: ApprovalContext,
    source: AsyncGenerator<AgentStreamEvent>,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent> {
    let result: ApprovalResult;
    try {
      result = await this.requestApproval(context, signal);
      this.throwIfAborted(signal);
    } catch (error) {
      await source.return(undefined);
      throw error;
    }

    if (result === "approved") {
      for await (const event of source) {
        if (isProviderRawStreamEvent(event)) {
          yield event;
          continue;
        }
        yield event;
      }
      return;
    }

    // Rejected or timed out -- yield failure event and drain source
    const message =
      result === "rejected" ? "Approval rejected" : "Approval timeout";

    const failedEvent: AgentEvent = {
      type: "adapter:failed",
      providerId: context.providerId,
      error: message,
      timestamp: Date.now(),
    };

    yield failedEvent;

    // Ensure the source generator is properly closed
    await source.return(undefined);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private recordAudit(entry: ApprovalAuditEntry): void {
    try {
      this.auditStore.record(entry);
    } catch (err) {
      // ERR-H-09: the audit store IS the governance record of who
      // approved/rejected a gated action. A silent swallow means an
      // audit-store outage is invisible exactly when it matters. Recording
      // must remain non-fatal (never throw), but the failure must be
      // observable so an outage alerts.
      defaultLogger.error("[AdapterApprovalGate] approval audit write failed", {
        operation: "approval.audit.record",
        requestId: entry.requestId,
        action: entry.action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private cleanup(requestId: string, resolvers: PendingResolvers): void {
    if (resolvers.timer !== undefined) {
      clearTimeout(resolvers.timer);
    }
    resolvers.removeAbortListener?.();
    this.pending.delete(requestId);
    this.resolvers.delete(requestId);
  }

  private abortError(): ForgeError {
    return new ForgeError({ code: "AGENT_ABORTED", message: "Approval cancelled", recoverable: false });
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw this.abortError();
  }

  /**
   * Every event here answers exactly one `requestId`, so all carry it as
   * `contactId` -- how consumers tell whether a decision is about the approval
   * they await. Unqualified, a decision satisfies every pending approval on the
   * run (DZUPAGENT-AGENT-H-14 for grants; its mirror for rejections).
   */
  private emitEvent(
    event:
      | {
          type: "approval:requested";
          runId: string;
          contactId: string;
          plan: unknown;
        }
      | {
          type: "approval:granted";
          runId: string;
          contactId: string;
          approvedBy?: string | undefined;
        }
      | {
          type: "approval:rejected";
          runId: string;
          contactId: string;
          reason?: string | undefined;
        }
  ): void {
    if (this.config.eventBus) {
      this.config.eventBus.emit(event as DzupEvent);
    }
  }
}
