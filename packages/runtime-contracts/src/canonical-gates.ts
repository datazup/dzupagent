import type {
  ExecutionArtifactRef,
  ExecutionEvidenceRequirement,
  ExecutionSourceRef,
  SanitizedEvidenceRef,
} from "./canonical-execution.js";

export type GateKind =
  | "human-approval"
  | "input-request"
  | "schema-validation"
  | "command-validation"
  | "policy-validation";

export interface GateActorRequirement {
  readonly actorId?: string;
  readonly role?: string;
}

export interface GateActor {
  readonly actorId: string;
  readonly role?: string;
}

export type GateSubject =
  | {
      readonly kind: "execution-output";
      readonly requestId: string;
      readonly outputKey: string;
    }
  | {
      readonly kind: "artifact";
      readonly artifact: ExecutionArtifactRef;
    }
  | {
      readonly kind: "declared";
      readonly ref: string;
    };

export type GateCheck =
  | {
      readonly kind: "schema";
      readonly schemaRef?: string;
      readonly schema?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "command";
      readonly id?: string;
      readonly command: string;
    }
  | {
      readonly kind: "declaration";
      readonly ref: string;
    }
  | {
      readonly kind: "policy";
      readonly ref: string;
    };

export interface GateRepairPolicy {
  readonly maxAttempts: number;
  readonly onFailure: "retry-subject" | "stop" | "continue";
  readonly repairPrompt?: boolean;
}

interface GateRequestBase {
  readonly schema: "dzupagent.gateRequest/v1";
  readonly gateId: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly kind: GateKind;
  readonly source: ExecutionSourceRef;
  readonly subject?: GateSubject;
  readonly policyRef?: string;
  readonly requiredActor?: GateActorRequirement;
  readonly deadlineAt?: string;
  readonly evidenceRequirements: readonly ExecutionEvidenceRequirement[];
}

export interface HumanApprovalGateRequest extends GateRequestBase {
  readonly kind: "human-approval";
  readonly question: string;
  readonly options: readonly string[];
  readonly approveNodeIds: readonly string[];
  readonly rejectNodeIds: readonly string[];
}

export interface InputGateRequest extends GateRequestBase {
  readonly kind: "input-request";
  readonly question: string;
  readonly response: {
    readonly format: "text" | "choice";
    readonly choices: readonly string[];
  };
}

export interface ValidationGateRequest extends GateRequestBase {
  readonly kind: "schema-validation" | "command-validation" | "policy-validation";
  readonly checks: readonly GateCheck[];
  readonly repair?: GateRepairPolicy;
}

export type GateRequest =
  | HumanApprovalGateRequest
  | InputGateRequest
  | ValidationGateRequest;

export interface GateResultDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

interface GateResultBase {
  readonly schema: "dzupagent.gateResult/v1";
  readonly gateId: string;
  readonly requestId: string;
  readonly correlationId: string;
  readonly kind: GateKind;
  readonly evidence: readonly SanitizedEvidenceRef[];
  readonly artifacts: readonly ExecutionArtifactRef[];
}

export type GateResult =
  | (GateResultBase & { readonly status: "pending" })
  | (GateResultBase & {
      readonly status: "input_required";
      readonly requestedAt: string;
      readonly expiresAt?: string;
    })
  | (GateResultBase & {
      readonly status: "passed";
      readonly decidedAt: string;
      readonly actor?: GateActor;
    })
  | (GateResultBase & {
      readonly status: "rejected";
      readonly decidedAt: string;
      readonly actor: GateActor;
      readonly reason?: string;
    })
  | (GateResultBase & {
      readonly status: "failed";
      readonly completedAt: string;
      readonly diagnostics: readonly GateResultDiagnostic[];
    })
  | (GateResultBase & {
      readonly status: "timed_out" | "cancelled";
      readonly completedAt: string;
      readonly reason?: string;
    });

export type GateResultValidationDiagnosticCode =
  | "GATE_ID_MISMATCH"
  | "GATE_REQUEST_MISMATCH"
  | "GATE_CORRELATION_MISMATCH"
  | "GATE_KIND_MISMATCH"
  | "INVALID_GATE_STATUS"
  | "MISSING_GATE_ACTOR"
  | "GATE_ACTOR_MISMATCH"
  | "MISSING_FAILURE_DIAGNOSTIC"
  | "INVALID_SANITIZED_EVIDENCE"
  | "INVALID_GATE_ARTIFACT";

export interface GateResultValidationDiagnostic {
  readonly code: GateResultValidationDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface GateResultValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly GateResultValidationDiagnostic[];
}

export function validateGateResult(
  request: GateRequest,
  result: GateResult,
): GateResultValidation {
  const diagnostics: GateResultValidationDiagnostic[] = [];
  if (result.gateId !== request.gateId) {
    diagnostics.push(diag("GATE_ID_MISMATCH", "gateId", "Result gateId does not match the gate request."));
  }
  if (result.requestId !== request.requestId) {
    diagnostics.push(diag("GATE_REQUEST_MISMATCH", "requestId", "Result requestId does not match the gate request."));
  }
  if (result.correlationId !== request.correlationId) {
    diagnostics.push(diag("GATE_CORRELATION_MISMATCH", "correlationId", "Result correlationId does not match the gate request."));
  }
  if (result.kind !== request.kind) {
    diagnostics.push(diag("GATE_KIND_MISMATCH", "kind", "Result kind does not match the gate request."));
  }
  if (
    result.status === "input_required" &&
    request.kind !== "human-approval" &&
    request.kind !== "input-request"
  ) {
    diagnostics.push(diag("INVALID_GATE_STATUS", "status", "Only human and input gates may require input."));
  }
  if (result.status === "rejected" && request.kind !== "human-approval" && request.kind !== "policy-validation") {
    diagnostics.push(diag("INVALID_GATE_STATUS", "status", "Only approval and policy gates may be rejected."));
  }
  if (
    request.requiredActor &&
    (result.status === "passed" || result.status === "rejected") &&
    !result.actor
  ) {
    diagnostics.push(diag("MISSING_GATE_ACTOR", "actor", "This gate requires an actor for its final decision."));
  }
  if (
    request.requiredActor &&
    (result.status === "passed" || result.status === "rejected") &&
    result.actor &&
    ((request.requiredActor.actorId && result.actor.actorId !== request.requiredActor.actorId) ||
      (request.requiredActor.role && result.actor.role !== request.requiredActor.role))
  ) {
    diagnostics.push(diag("GATE_ACTOR_MISMATCH", "actor", "Gate actor does not satisfy the required actor identity or role."));
  }
  if (result.status === "failed" && result.diagnostics.length === 0) {
    diagnostics.push(diag("MISSING_FAILURE_DIAGNOSTIC", "diagnostics", "A failed gate requires at least one diagnostic."));
  }
  result.evidence.forEach((evidence, index) => {
    if (
      evidence.digestOf !== "sanitized" ||
      !evidence.uri ||
      !evidence.digest ||
      !evidence.redactionStatus ||
      !evidence.contentClass
    ) {
      diagnostics.push(diag("INVALID_SANITIZED_EVIDENCE", `evidence[${index}]`, "Gate evidence must be a complete sanitized reference."));
    }
  });
  result.artifacts.forEach((artifact, index) => {
    if (!artifact.uri || !artifact.digest || !artifact.contentClass) {
      diagnostics.push(diag("INVALID_GATE_ARTIFACT", `artifacts[${index}]`, "Gate artifact refs require uri, digest, and contentClass."));
    }
  });
  return { valid: diagnostics.length === 0, diagnostics };
}

function diag(
  code: GateResultValidationDiagnosticCode,
  path: string,
  message: string,
): GateResultValidationDiagnostic {
  return { code, path, message };
}
