import type {
  ExecutionCapabilityRequirement,
  ExecutionEffectPolicy,
  ExecutionEvidenceRequirement,
  ExecutionPolicy,
  ExecutionSourceRef,
} from "./canonical-execution.js";

/**
 * Neutral invocation boundary between a compiled flow primitive and a host.
 *
 * The contract identifies requested semantics. It does not select an executor,
 * authorize an effect, or imply that the host is ready.
 */
export interface PrimitiveInvocation {
  readonly schema: "dzupagent.primitiveInvocation/v1";
  readonly invocationId: string;
  readonly correlationId: string;
  readonly attemptId: string;
  readonly primitive: {
    readonly kind: string;
    readonly version: string;
  };
  readonly source: ExecutionSourceRef;
  readonly input: Readonly<Record<string, unknown>>;
  readonly policy: ExecutionPolicy;
  readonly effects: ExecutionEffectPolicy;
  readonly capabilityRequirements: readonly ExecutionCapabilityRequirement[];
  readonly evidenceRequirements: readonly ExecutionEvidenceRequirement[];
}

export type PrimitiveInvocationDiagnosticCode =
  | "INVALID_INVOCATION_ID"
  | "INVALID_CORRELATION_ID"
  | "INVALID_ATTEMPT_ID"
  | "INVALID_PRIMITIVE_KIND"
  | "INVALID_PRIMITIVE_VERSION"
  | "INVALID_SOURCE_NODE";

export interface PrimitiveInvocationDiagnostic {
  readonly code: PrimitiveInvocationDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface PrimitiveInvocationValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly PrimitiveInvocationDiagnostic[];
}

export function validatePrimitiveInvocation(
  invocation: PrimitiveInvocation,
): PrimitiveInvocationValidation {
  const diagnostics: PrimitiveInvocationDiagnostic[] = [];
  requireNonEmpty(
    invocation.invocationId,
    "INVALID_INVOCATION_ID",
    "invocationId",
    diagnostics,
  );
  requireNonEmpty(
    invocation.correlationId,
    "INVALID_CORRELATION_ID",
    "correlationId",
    diagnostics,
  );
  requireNonEmpty(
    invocation.attemptId,
    "INVALID_ATTEMPT_ID",
    "attemptId",
    diagnostics,
  );
  requireNonEmpty(
    invocation.primitive.kind,
    "INVALID_PRIMITIVE_KIND",
    "primitive.kind",
    diagnostics,
  );
  requireNonEmpty(
    invocation.primitive.version,
    "INVALID_PRIMITIVE_VERSION",
    "primitive.version",
    diagnostics,
  );
  requireNonEmpty(
    invocation.source.nodeId,
    "INVALID_SOURCE_NODE",
    "source.nodeId",
    diagnostics,
  );

  return {
    valid: diagnostics.length === 0,
    diagnostics,
  };
}

function requireNonEmpty(
  value: string,
  code: PrimitiveInvocationDiagnosticCode,
  path: string,
  diagnostics: PrimitiveInvocationDiagnostic[],
): void {
  if (value.trim().length > 0) return;
  diagnostics.push({
    code,
    path,
    message: `${path} must be a non-empty string.`,
  });
}
