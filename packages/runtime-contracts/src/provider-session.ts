import type { ProviderExecutionBackend } from "./canonical-execution.js";

export const PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA_V1 =
  "dzupagent.providerSessionCapabilityDescriptor/v1" as const;
export const PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA =
  "dzupagent.providerSessionCapabilityDescriptor/v2" as const;
export const PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA_V1 =
  "dzupagent.providerSessionAttemptBinding/v1" as const;
export const PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA =
  "dzupagent.providerSessionAttemptBinding/v2" as const;
export const PROVIDER_SESSION_REFERENCE_SCHEMA =
  "dzupagent.providerSessionReference/v1" as const;
export const PROVIDER_SESSION_OPERATION_SCHEMA_V1 =
  "dzupagent.providerSessionOperation/v1" as const;
export const PROVIDER_SESSION_OPERATION_SCHEMA =
  "dzupagent.providerSessionOperation/v2" as const;

export const PROVIDER_SESSION_CAPABILITIES_V1 = [
  "execute",
  "stream",
  "resume",
  "cancel",
  "interaction",
  "usage",
  "provider-request-lookup",
  "steer",
  "interrupt-turn",
  "fork-session",
  "start-review",
  "history-read",
  "compact",
] as const;

export const PROVIDER_SESSION_CAPABILITIES = [
  ...PROVIDER_SESSION_CAPABILITIES_V1,
  "goal-control",
] as const;

export type ProviderSessionCapability =
  (typeof PROVIDER_SESSION_CAPABILITIES)[number];

export const PROVIDER_SESSION_RICH_CONTROL_CAPABILITIES = [
  "steer",
  "interrupt-turn",
  "fork-session",
  "start-review",
  "history-read",
  "compact",
  "goal-control",
] as const satisfies readonly ProviderSessionCapability[];

export const PROVIDER_SESSION_EFFECTS_V1 = [
  "execute",
  "resume",
  "cancel",
  "interaction",
  "steer",
  "interrupt-turn",
  "fork-session",
  "start-review",
  "compact",
] as const;

export const PROVIDER_SESSION_EFFECTS = [
  ...PROVIDER_SESSION_EFFECTS_V1,
  "goal-set",
  "goal-clear",
] as const;

export type ProviderSessionEffect = (typeof PROVIDER_SESSION_EFFECTS)[number];

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

export type ProviderSessionAdmissionDiagnosticCode =
  | "BINDING_SCHEMA_INVALID"
  | "BINDING_IDENTITY_INVALID"
  | "DESCRIPTOR_SCHEMA_INVALID"
  | "BACKEND_IDENTITY_INVALID"
  | "CAPABILITY_DECLARATION_INVALID"
  | "CAPABILITY_REQUIRED_UNSUPPORTED"
  | "EFFECT_AUTHORITY_INVALID"
  | "SERIALIZABLE_STATE_FORBIDDEN";

export interface ProviderSessionAdmissionDiagnostic {
  readonly code: ProviderSessionAdmissionDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface ProviderSessionAdmissionResult {
  readonly valid: boolean;
  readonly diagnostics: readonly ProviderSessionAdmissionDiagnostic[];
}

const FORBIDDEN_SERIALIZABLE_KEYS = new Set([
  "apikey",
  "credential",
  "credentials",
  "password",
  "protocolobject",
  "rawevent",
  "sdkclient",
  "secret",
  "token",
]);

/** Fail-closed admission performed before any provider dispatch. */
export function validateProviderSessionAttemptBinding(
  candidate: unknown,
  requiredCapabilities: readonly ProviderSessionCapability[] = [],
): ProviderSessionAdmissionResult {
  const diagnostics: ProviderSessionAdmissionDiagnostic[] = [];
  if (!isRecord(candidate)) {
    add(diagnostics, "BINDING_SCHEMA_INVALID", "", "Attempt binding must be an object.");
    return { valid: false, diagnostics };
  }

  inspectForbiddenState(candidate, "", diagnostics, new Set());
  const legacyBinding = candidate.schema === PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA_V1;
  const currentBinding = candidate.schema === PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA;
  if (!legacyBinding && !currentBinding) {
    add(diagnostics, "BINDING_SCHEMA_INVALID", "schema", "Attempt binding schema is unsupported.");
  }
  for (const key of ["bindingId", "executionAttemptId", "authSourceRef", "boundAt"] as const) {
    if (!nonEmpty(candidate[key])) {
      add(diagnostics, "BINDING_IDENTITY_INVALID", key, `${key} must be a non-empty string.`);
    }
  }
  if (nonEmpty(candidate.boundAt) && !validTimestamp(candidate.boundAt)) {
    add(diagnostics, "BINDING_IDENTITY_INVALID", "boundAt", "boundAt must be an ISO timestamp.");
  }

  const descriptor = candidate.descriptor;
  if (!isRecord(descriptor)) {
    add(diagnostics, "DESCRIPTOR_SCHEMA_INVALID", "descriptor", "Capability descriptor must be an object.");
  } else {
    const admittedCapabilities = legacyBinding
      ? PROVIDER_SESSION_CAPABILITIES_V1
      : PROVIDER_SESSION_CAPABILITIES;
    const admittedCapabilitySet: ReadonlySet<ProviderSessionCapability> =
      new Set(admittedCapabilities);
    inspectDescriptor(
      descriptor,
      diagnostics,
      legacyBinding
        ? PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA_V1
        : PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
      admittedCapabilities,
    );
    for (const capability of [...new Set(requiredCapabilities)]) {
      const support = isRecord(descriptor.capabilities)
        ? descriptor.capabilities[capability]
        : undefined;
      if (
        !admittedCapabilitySet.has(capability)
        || !isRecord(support)
        || support.status !== "native"
      ) {
        add(
          diagnostics,
          "CAPABILITY_REQUIRED_UNSUPPORTED",
          `descriptor.capabilities.${capability}`,
          `Required provider-session capability is not native: ${capability}.`,
        );
      }
    }
  }

  inspectEffectAuthorities(
    candidate.effectAuthorities,
    diagnostics,
    legacyBinding ? PROVIDER_SESSION_EFFECTS_V1 : PROVIDER_SESSION_EFFECTS,
  );
  return { valid: diagnostics.length === 0, diagnostics };
}

function inspectDescriptor(
  descriptor: Record<string, unknown>,
  diagnostics: ProviderSessionAdmissionDiagnostic[],
  expectedSchema:
    | typeof PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA_V1
    | typeof PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
  admittedCapabilities: readonly ProviderSessionCapability[],
): void {
  if (descriptor.schema !== expectedSchema) {
    add(diagnostics, "DESCRIPTOR_SCHEMA_INVALID", "descriptor.schema", "Capability descriptor schema is unsupported.");
  }
  for (const key of ["descriptorId", "providerId", "observedAt"] as const) {
    if (!nonEmpty(descriptor[key])) {
      add(diagnostics, "DESCRIPTOR_SCHEMA_INVALID", `descriptor.${key}`, `${key} must be a non-empty string.`);
    }
  }
  if (nonEmpty(descriptor.observedAt) && !validTimestamp(descriptor.observedAt)) {
    add(diagnostics, "DESCRIPTOR_SCHEMA_INVALID", "descriptor.observedAt", "observedAt must be an ISO timestamp.");
  }

  const backend = descriptor.backend;
  if (
    !isRecord(backend)
    || !nonEmpty(backend.id)
    || !["cli", "local-model", "sdk", "api", "remote", "app-server"].includes(String(backend.kind))
  ) {
    add(diagnostics, "BACKEND_IDENTITY_INVALID", "descriptor.backend", "Backend id and kind are required.");
  }

  const capabilities = descriptor.capabilities;
  if (!isRecord(capabilities)) {
    add(diagnostics, "CAPABILITY_DECLARATION_INVALID", "descriptor.capabilities", "Capability map must be an object.");
    return;
  }
  for (const capability of admittedCapabilities) {
    const support = capabilities[capability];
    if (
      !isRecord(support)
      || !["native", "unsupported"].includes(String(support.status))
      || support.emulation !== "forbidden"
      || (support.status === "unsupported" && !nonEmpty(support.reason))
    ) {
      add(
        diagnostics,
        "CAPABILITY_DECLARATION_INVALID",
        `descriptor.capabilities.${capability}`,
        "Capability must be native or explicitly unsupported, with emulation forbidden.",
      );
    }
  }
}

function inspectEffectAuthorities(
  value: unknown,
  diagnostics: ProviderSessionAdmissionDiagnostic[],
  admittedEffects: readonly ProviderSessionEffect[],
): void {
  if (!isRecord(value)) {
    add(diagnostics, "EFFECT_AUTHORITY_INVALID", "effectAuthorities", "Effect authority map must be an object.");
    return;
  }
  for (const effect of admittedEffects) {
    const authority = value[effect];
    if (
      !isRecord(authority)
      || authority.effect !== effect
      || !nonEmpty(authority.retryAuthorityId)
      || !nonEmpty(authority.fallbackAuthorityId)
      || ![0, 1].includes(Number(authority.maxRetries))
      || !["none", "ordered-compatible"].includes(String(authority.fallback))
    ) {
      add(
        diagnostics,
        "EFFECT_AUTHORITY_INVALID",
        `effectAuthorities.${effect}`,
        "Every effect needs one named retry authority, fallback authority, and bounded retry policy.",
      );
    }
  }
}

function inspectForbiddenState(
  value: unknown,
  path: string,
  diagnostics: ProviderSessionAdmissionDiagnostic[],
  seen: Set<object>,
): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) {
    add(diagnostics, "SERIALIZABLE_STATE_FORBIDDEN", path, "Attempt binding must be JSON-serializable.");
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectForbiddenState(entry, `${path}[${index}]`, diagnostics, seen));
    seen.delete(value);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
    const entryPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_SERIALIZABLE_KEYS.has(normalized)) {
      add(diagnostics, "SERIALIZABLE_STATE_FORBIDDEN", entryPath, "Credentials and provider protocol objects are forbidden.");
    }
    if (typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
      add(diagnostics, "SERIALIZABLE_STATE_FORBIDDEN", entryPath, "Attempt binding must contain JSON values only.");
    } else {
      inspectForbiddenState(entry, entryPath, diagnostics, seen);
    }
  }
  seen.delete(value);
}

function add(
  diagnostics: ProviderSessionAdmissionDiagnostic[],
  code: ProviderSessionAdmissionDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}
