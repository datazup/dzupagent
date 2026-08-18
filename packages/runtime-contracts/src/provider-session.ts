import type { ProviderExecutionBackend } from "./canonical-execution.js";
import type {
  PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
  PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
  PROVIDER_SESSION_OPERATION_SCHEMA,
  PROVIDER_SESSION_REFERENCE_SCHEMA,
  ProviderSessionCapability,
  ProviderSessionEffect,
} from "./provider-session-schema.js";

// PUBLIC API, not a convenience: `./provider-session` is a documented subpath
// export, so every symbol extracted out of this module stays re-exported here.
export * from "./provider-session-schema.js";
export {
  validateProviderSessionAttemptBinding,
  type ProviderSessionAdmissionDiagnostic,
  type ProviderSessionAdmissionDiagnosticCode,
  type ProviderSessionAdmissionResult,
} from "./provider-session-validate.js";

/** App Server is a provider-session backend, not a repository supervisor. */
export type ProviderSessionBackendKind =
  | ProviderExecutionBackend
  | "app-server";

/**
 * Capabilities are native or unavailable. `emulation: forbidden` prevents a
 * host from treating a fresh prompt as fork, or interrupt-and-retry as steer.
 */
export interface ProviderSessionCapabilitySupport {
  readonly status: "native" | "unsupported";
  readonly emulation: "forbidden";
  readonly reason?: string;
}

export type ProviderSessionCapabilityMap = Readonly<
  Record<ProviderSessionCapability, ProviderSessionCapabilitySupport>
>;

export interface ProviderSessionBackendIdentity {
  readonly id: string;
  readonly kind: ProviderSessionBackendKind;
  readonly version?: string;
  /** Sanitized digest of the observed executable artifact; never a host path. */
  readonly artifactDigest?: string;
  /** Reference/digest only. Generated provider protocol objects stay runtime-local. */
  readonly protocolSchemaRef?: string;
  readonly protocolSchemaDigest?: string;
}

export interface ProviderSessionCapabilityDescriptor {
  readonly schema: typeof PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA;
  readonly descriptorId: string;
  readonly providerId: string;
  readonly backend: ProviderSessionBackendIdentity;
  readonly capabilities: ProviderSessionCapabilityMap;
  readonly observedAt: string;
  /** Sanitized host evidence reference; never provider-authored prose. */
  readonly evidenceRef?: string;
}

export interface ProviderSessionEffectAuthority {
  readonly effect: ProviderSessionEffect;
  readonly retryAuthorityId: string;
  readonly fallbackAuthorityId: string;
  readonly maxRetries: 0 | 1;
  readonly fallback: "none" | "ordered-compatible";
}

export type ProviderSessionEffectAuthorityMap = Readonly<
  Record<ProviderSessionEffect, ProviderSessionEffectAuthority>
>;

/** Immutable provider-session identities bound to one execution attempt. */
export interface ProviderSessionAttemptBinding {
  readonly schema: typeof PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA;
  readonly bindingId: string;
  readonly executionAttemptId: string;
  readonly authSourceRef: string;
  readonly descriptor: ProviderSessionCapabilityDescriptor;
  readonly effectAuthorities: ProviderSessionEffectAuthorityMap;
  readonly boundAt: string;
}

export type ProviderSessionReferenceKind =
  | "session"
  | "thread"
  | "turn"
  | "review"
  | "interaction";

/** Serializable provider IDs remain opaque and are interpreted only by the adapter. */
export interface ProviderSessionReference<
  Kind extends ProviderSessionReferenceKind = ProviderSessionReferenceKind,
> {
  readonly schema: typeof PROVIDER_SESSION_REFERENCE_SCHEMA;
  readonly kind: Kind;
  readonly opaqueId: string;
}

export type ProviderSessionRef = ProviderSessionReference<"session">;
export type ProviderThreadRef = ProviderSessionReference<"thread">;
export type ProviderTurnRef = ProviderSessionReference<"turn">;
export type ProviderReviewRef = ProviderSessionReference<"review">;
export type ProviderInteractionRef = ProviderSessionReference<"interaction">;

interface ProviderSessionOperationBase {
  readonly schema: typeof PROVIDER_SESSION_OPERATION_SCHEMA;
  readonly operationId: string;
  readonly attemptBindingId: string;
}

export interface ProviderSessionSteerRequest
  extends ProviderSessionOperationBase {
  readonly kind: "steer";
  readonly session: ProviderSessionRef;
  readonly turn?: ProviderTurnRef;
  readonly instruction: string;
}

export interface ProviderSessionInterruptTurnRequest
  extends ProviderSessionOperationBase {
  readonly kind: "interrupt-turn";
  readonly session: ProviderSessionRef;
  readonly turn: ProviderTurnRef;
  readonly reason?: string;
}

export interface ProviderSessionForkRequest
  extends ProviderSessionOperationBase {
  readonly kind: "fork-session";
  readonly session: ProviderSessionRef;
  readonly fromTurn?: ProviderTurnRef;
}

export interface ProviderSessionStartReviewRequest
  extends ProviderSessionOperationBase {
  readonly kind: "start-review";
  readonly session?: ProviderSessionRef;
  readonly candidateDigest: string;
  readonly instructions?: string;
}

export interface ProviderSessionHistoryReadRequest
  extends ProviderSessionOperationBase {
  readonly kind: "history-read";
  readonly session: ProviderSessionRef;
  readonly afterTurn?: ProviderTurnRef;
  readonly limit?: number;
}

export interface ProviderSessionCompactRequest
  extends ProviderSessionOperationBase {
  readonly kind: "compact";
  readonly session: ProviderSessionRef;
  readonly throughTurn?: ProviderTurnRef;
}

export const PROVIDER_SESSION_GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "usage-limited",
  "budget-limited",
  "complete",
] as const;

export type ProviderSessionGoalStatus =
  (typeof PROVIDER_SESSION_GOAL_STATUSES)[number];

export interface ProviderSessionGoalGetRequest
  extends ProviderSessionOperationBase {
  readonly kind: "goal-get";
  readonly thread: ProviderThreadRef;
}

export interface ProviderSessionGoalSetRequest
  extends ProviderSessionOperationBase {
  readonly kind: "goal-set";
  readonly thread: ProviderThreadRef;
  /** Ephemeral provider input. Adapters must not copy it into durable results. */
  readonly objective?: string;
  readonly status?: ProviderSessionGoalStatus;
  readonly tokenBudget?: number | null;
}

export interface ProviderSessionGoalClearRequest
  extends ProviderSessionOperationBase {
  readonly kind: "goal-clear";
  readonly thread: ProviderThreadRef;
}

/** Sanitized thread-goal state; the raw objective remains provider-local. */
export interface ProviderSessionGoalSnapshot {
  readonly thread: ProviderThreadRef;
  readonly objectiveDigest: string;
  readonly status: ProviderSessionGoalStatus;
  readonly tokenBudget: number | null;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
}

export type ProviderSessionOperationRequest =
  | ProviderSessionSteerRequest
  | ProviderSessionInterruptTurnRequest
  | ProviderSessionForkRequest
  | ProviderSessionStartReviewRequest
  | ProviderSessionHistoryReadRequest
  | ProviderSessionCompactRequest
  | ProviderSessionGoalGetRequest
  | ProviderSessionGoalSetRequest
  | ProviderSessionGoalClearRequest;

export interface ProviderSessionHistoryItem {
  readonly turn: ProviderTurnRef;
  readonly role: "system" | "user" | "assistant" | "tool" | "unknown";
  readonly content: string;
  readonly emittedAt?: string;
}

export type ProviderSessionOperationResult =
  | {
      readonly kind: "steer" | "interrupt-turn";
      readonly accepted: true;
      readonly interaction?: ProviderInteractionRef;
    }
  | {
      readonly kind: "fork-session";
      readonly session: ProviderSessionRef;
      readonly thread?: ProviderThreadRef;
    }
  | {
      readonly kind: "start-review";
      readonly review: ProviderReviewRef;
      readonly session?: ProviderSessionRef;
    }
  | {
      readonly kind: "history-read";
      readonly items: readonly ProviderSessionHistoryItem[];
      readonly hasMore: boolean;
    }
  | {
      readonly kind: "compact";
      readonly session: ProviderSessionRef;
      readonly throughTurn?: ProviderTurnRef;
    }
  | {
      readonly kind: "goal-get";
      readonly goal: ProviderSessionGoalSnapshot | null;
    }
  | {
      readonly kind: "goal-set";
      readonly goal: ProviderSessionGoalSnapshot;
    }
  | {
      readonly kind: "goal-clear";
      readonly cleared: boolean;
    };
