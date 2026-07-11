/**
 * Dependency-neutral contracts between flow compilation and host execution.
 *
 * These shapes describe an invocation; they do not select a provider, execute
 * a tool, or authorize an effect. Hosts must materialize route candidates and
 * validate the resulting decision before execution.
 */

export type ExecutionLeafKind =
  | "prompt"
  | "agent"
  | "adapter.run"
  | "worker.dispatch";

export interface ExecutionSourceRef {
  readonly flowId?: string;
  readonly nodeId: string;
  readonly nodePath: string;
  readonly profileRef?: string;
  readonly capability?: string;
}

export type ExecutionPromptLayerKind =
  | "system"
  | "persona"
  | "instructions"
  | "task";

export interface ExecutionPromptLayer {
  readonly kind: ExecutionPromptLayerKind;
  readonly content?: string;
  readonly ref?: string;
}

export interface ExecutionPrompt {
  readonly layers: readonly ExecutionPromptLayer[];
  readonly bindings: Readonly<Record<string, unknown>>;
}

export interface ExecutionToolGrant {
  readonly toolRef: string;
  readonly operations?: readonly string[];
}

export interface ExecutionToolPolicy {
  readonly mode: "none" | "host-default" | "explicit";
  readonly grants: readonly ExecutionToolGrant[];
}

export interface ExecutionOutputContract {
  readonly key: string;
  readonly format: "text" | "json" | "unknown";
  readonly schemaRef?: string;
  readonly schema?: Readonly<Record<string, unknown>>;
}

export interface ExecutionPolicy {
  readonly timeoutMs?: number;
  readonly budgetCents?: number;
  readonly maxIterations?: number;
  readonly maxToolCalls?: number;
  readonly workingDirectory?: string;
  readonly approvalRequiredFor?: readonly string[];
  readonly commandSurface?: "none" | "code";
  readonly validationCommands?: readonly string[];
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface ExecutionEffectPolicy {
  readonly effectClass?: string;
  readonly idempotency?: "idempotent" | "at-least-once" | "exactly-once-required";
}

/** A reference that can only identify sanitized/redacted evidence. */
export interface SanitizedEvidenceRef {
  readonly uri: string;
  readonly digest: string;
  readonly digestOf: "sanitized";
  readonly redactionStatus: string;
  readonly contentClass: string;
}

/** Artifact identity is separate from evidence provenance/redaction. */
export interface ExecutionArtifactRef {
  readonly uri: string;
  readonly digest: string;
  readonly contentClass: string;
  readonly mediaType?: string;
}

export interface ExecutionEvidenceRequirement {
  readonly kind: "sanitized-evidence" | "artifact" | "declared";
  readonly ref?: string;
  readonly declaration?: unknown;
}

export interface ExecutionRouteCandidate {
  readonly id: string;
  readonly provider?: string;
  readonly model?: string;
  readonly tags?: readonly string[];
}

export interface ExecutionRouteConstraint {
  readonly kind: "provider" | "tags" | "capability" | "policy";
  readonly values: readonly string[];
}

export interface ExecutionRoutePolicy {
  readonly id: string;
  readonly requestId: string;
  readonly strategy: "fixed" | "rule" | "weighted" | "hash" | "round-robin" | "llm-rank";
  /** Fully materialized host-supplied candidate set. */
  readonly candidates: readonly ExecutionRouteCandidate[];
  readonly hardConstraints: readonly ExecutionRouteConstraint[];
  readonly preferenceOrder: readonly string[];
  readonly fallback: "none" | "ordered-compatible";
  readonly maxSelectionLatencyMs: number;
}

export interface ExecutionRouteRejection {
  readonly candidateId: string;
  readonly reasons: readonly string[];
}

/** Immutable audit result. Hard constraints, not reasoning text, are authority. */
export interface ExecutionRouteDecision {
  readonly id: string;
  readonly policyId: string;
  readonly requestId: string;
  readonly eligibleCandidateIds: readonly string[];
  readonly rejected: readonly ExecutionRouteRejection[];
  readonly selectedCandidateId: string | null;
  readonly fallbackCandidateIds: readonly string[];
  readonly strategy: ExecutionRoutePolicy["strategy"];
  readonly reasoningSummary?: string;
  readonly decidedAt: string;
}

export type ExecutionRouteDecisionDiagnosticCode =
  | "ROUTE_POLICY_MISMATCH"
  | "ROUTE_REQUEST_MISMATCH"
  | "DUPLICATE_ROUTE_CANDIDATE"
  | "UNKNOWN_ROUTE_CANDIDATE"
  | "SELECTED_CANDIDATE_NOT_ELIGIBLE";

export interface ExecutionRouteDecisionDiagnostic {
  readonly code: ExecutionRouteDecisionDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface ExecutionRouteDecisionValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly ExecutionRouteDecisionDiagnostic[];
}

export interface ExecutionRequestBase {
  readonly schema: "dzupagent.executionRequest/v1";
  readonly kind: ExecutionLeafKind;
  readonly requestId: string;
  readonly correlationId: string;
  readonly attempt: number;
  readonly source: ExecutionSourceRef;
  readonly prompt: ExecutionPrompt;
  readonly tools: ExecutionToolPolicy;
  readonly output: ExecutionOutputContract;
  readonly route: ExecutionRoutePolicy;
  readonly policy: ExecutionPolicy;
  readonly effects: ExecutionEffectPolicy;
  readonly evidenceRequirements: readonly ExecutionEvidenceRequirement[];
}

export interface PromptExecutionRequest extends ExecutionRequestBase {
  readonly kind: "prompt";
}

export interface AgentExecutionRequest extends ExecutionRequestBase {
  readonly kind: "agent";
  readonly identity: {
    readonly agentId: string;
    readonly templateRef?: string;
  };
}

export interface AdapterRunExecutionRequest extends ExecutionRequestBase {
  readonly kind: "adapter.run";
  readonly adapter: {
    readonly personaRef?: string;
    readonly reasoning?: "low" | "medium" | "high";
    readonly promptPreparation: "auto" | "raw";
  };
}

export interface WorkerDispatchExecutionRequest extends ExecutionRequestBase {
  readonly kind: "worker.dispatch";
  readonly worker: {
    readonly dispatchId: string;
  };
}

export type ExecutionRequest =
  | PromptExecutionRequest
  | AgentExecutionRequest
  | AdapterRunExecutionRequest
  | WorkerDispatchExecutionRequest;

export interface ExecutionUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costCents?: number;
}

interface ExecutionResultBase {
  readonly schema: "dzupagent.executionResult/v1";
  readonly requestId: string;
  readonly correlationId: string;
  readonly routeDecision: ExecutionRouteDecision;
  readonly evidence: readonly SanitizedEvidenceRef[];
  readonly artifacts: readonly ExecutionArtifactRef[];
  readonly usage?: ExecutionUsage;
}

export type ExecutionResult =
  | (ExecutionResultBase & { readonly status: "succeeded"; readonly output: unknown })
  | (ExecutionResultBase & {
      readonly status: "failed" | "cancelled" | "timed_out";
      readonly errorCode: string;
      readonly errorMessage: string;
    });

export function validateExecutionRouteDecision(
  policy: ExecutionRoutePolicy,
  decision: ExecutionRouteDecision,
): ExecutionRouteDecisionValidation {
  const diagnostics: ExecutionRouteDecisionDiagnostic[] = [];
  if (decision.policyId !== policy.id) {
    diagnostics.push(diag("ROUTE_POLICY_MISMATCH", "policyId", "Decision policyId does not match the route policy."));
  }
  if (decision.requestId !== policy.requestId) {
    diagnostics.push(diag("ROUTE_REQUEST_MISMATCH", "requestId", "Decision requestId does not match the route policy."));
  }

  const known = new Set<string>();
  policy.candidates.forEach((candidate, index) => {
    if (known.has(candidate.id)) {
      diagnostics.push(diag("DUPLICATE_ROUTE_CANDIDATE", `candidates[${index}].id`, `Duplicate route candidate: ${candidate.id}`));
    }
    known.add(candidate.id);
  });

  const inspect = (candidateId: string, path: string): void => {
    if (!known.has(candidateId)) {
      diagnostics.push(diag("UNKNOWN_ROUTE_CANDIDATE", path, `Candidate is outside the materialized policy set: ${candidateId}`));
    }
  };
  decision.eligibleCandidateIds.forEach((id, index) => inspect(id, `eligibleCandidateIds[${index}]`));
  decision.rejected.forEach((item, index) => inspect(item.candidateId, `rejected[${index}].candidateId`));
  decision.fallbackCandidateIds.forEach((id, index) => inspect(id, `fallbackCandidateIds[${index}]`));
  if (decision.selectedCandidateId !== null) {
    inspect(decision.selectedCandidateId, "selectedCandidateId");
    if (!decision.eligibleCandidateIds.includes(decision.selectedCandidateId)) {
      diagnostics.push(diag("SELECTED_CANDIDATE_NOT_ELIGIBLE", "selectedCandidateId", "Selected candidate must be in the eligible set."));
    }
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

function diag(
  code: ExecutionRouteDecisionDiagnosticCode,
  path: string,
  message: string,
): ExecutionRouteDecisionDiagnostic {
  return { code, path, message };
}
