import type { AdapterProviderId } from "../types.js";
import type { UrlValidationOptions } from "../utils/url-validator.js";
import type { DzupEventBus } from "@dzupagent/core/events";

/** Approval mode determining when human approval is required. */
export type ApprovalMode = "auto" | "required" | "conditional";

/** Outcome of an approval request. */
export type ApprovalResult = "approved" | "rejected" | "timeout";

/** Context describing what is being approved. */
export interface ApprovalContext {
  /** Unique run/workflow identifier. */
  runId: string;
  /** Human-readable description of what is being approved. */
  description: string;
  /** Which provider would execute the work. */
  providerId: AdapterProviderId;
  /** Estimated cost in cents (used for auto-approve threshold). */
  estimatedCostCents?: number | undefined;
  /** Task tags for categorisation. */
  tags?: string[] | undefined;
  /** Additional metadata forwarded to webhooks and events. */
  metadata?: Record<string, unknown>;
  /** Estimated blast radius of the action. */
  blastRadius?: "low" | "medium" | "high" | "critical";
  /** AI confidence score for the proposed action (0-1). */
  confidenceScore?: number;
}

/** A tracked approval request. */
export interface ApprovalRequest {
  requestId: string;
  runId: string;
  context: ApprovalContext;
  requestedAt: Date;
  expiresAt: Date;
  status: "pending" | "approved" | "rejected" | "expired";
}

/** Configuration for the AdapterApprovalGate. */
export interface AdapterApprovalConfig {
  /** Approval mode. Default: 'auto' (no approval needed). */
  mode: ApprovalMode;
  /** Timeout in ms for waiting for approval. Default: 300_000 (5 min). */
  timeoutMs?: number;
  /** Condition for 'conditional' mode. Returns true when approval IS needed. */
  condition?: (context: ApprovalContext) => boolean | Promise<boolean>;
  /** Webhook URL to notify when approval is requested. */
  webhookUrl?: string;
  /** Auto-approve if estimated cost is below this threshold (cents). */
  autoApproveBelowCostCents?: number;
  /** SSRF-protection options applied to webhookUrl. */
  webhookUrlValidation?: UrlValidationOptions;
  /** Event bus for approval events. */
  eventBus?: DzupEventBus;
  /** Audit store for recording approval decisions. Defaults to in-memory store. */
  auditStore?: ApprovalAuditStore;
  /**
   * Optional fetch implementation used for webhook notifications.
   * Primarily intended for testing; omit in production to use the default
   * secure-fetch implementation.
   */
  webhookFetchImpl?: typeof fetch;
}

/** Record of a single approval decision. */
export interface ApprovalAuditEntry {
  requestId: string;
  providerId: AdapterProviderId;
  action: "requested" | "granted" | "rejected" | "timed_out" | "auto_approved";
  timestamp: number;
  /** Who made the decision (user ID, 'system', 'auto-policy'). */
  actor: string;
  /** Why the decision was made. */
  reason?: string | undefined;
  /** Cost at time of decision. */
  estimatedCostCents?: number | undefined;
  /** Approval mode that was active. */
  mode: ApprovalMode;
}

/** Query filters for audit entries. */
export interface AuditQueryFilters {
  requestId?: string | undefined;
  providerId?: AdapterProviderId | undefined;
  action?: ApprovalAuditEntry["action"] | undefined;
  since?: number | undefined;
  until?: number | undefined;
  limit?: number | undefined;
}

/** Interface for audit storage backends. */
export interface ApprovalAuditStore {
  record(entry: ApprovalAuditEntry): void;
  query(filters?: AuditQueryFilters): ApprovalAuditEntry[];
  clear(): void;
}
