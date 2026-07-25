import type { ExecutionRequest, SanitizedEvidenceRef } from "./canonical-execution.js";

export const REVIEWER_INDEPENDENCE_LEVELS = [
  "same-session",
  "separate-session",
  "separate-model",
  "separate-provider",
] as const;

export type ReviewerIndependenceLevel =
  (typeof REVIEWER_INDEPENDENCE_LEVELS)[number];

export interface AgentRunIdentity {
  readonly runId: string;
  readonly nodeId: string;
  readonly logicalTurnId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly correlationId: string;
}

export interface AgentActorRef {
  readonly actorId: string;
  readonly role:
    | "implementer"
    | "reviewer"
    | "semantic-judge"
    | "next-path-approver"
    | "terminal-approver"
    | "manager"
    | "specialist";
  readonly providerId: string;
  readonly modelId?: string;
  readonly personaRef?: string;
  readonly readOnly: boolean;
  readonly sessionId?: string;
}

export interface AgentRunLimits {
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxCostCents: number;
  readonly deadline: string;
}

export interface AgentRunUsage {
  readonly turns: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costCents: number;
}

export interface AgentProgress {
  readonly beforeDigest: `sha256:${string}`;
  readonly afterDigest: `sha256:${string}`;
  readonly changed: boolean;
}

export interface AgentRunRequest {
  readonly schema: "dzupagent.agentRunRequest/v1";
  readonly identity: AgentRunIdentity;
  readonly actor: AgentActorRef;
  readonly execution: ExecutionRequest;
  readonly limits: AgentRunLimits;
  readonly requiredEvidenceKinds: readonly string[];
}

export type AgentRunStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "exhausted"
  | "stalled"
  | "unsupported";

export interface AgentRunResult {
  readonly schema: "dzupagent.agentRunResult/v1";
  readonly identity: AgentRunIdentity;
  readonly actorId: string;
  readonly status: AgentRunStatus;
  readonly output?: unknown;
  readonly usage: AgentRunUsage;
  readonly progress: AgentProgress;
  readonly evidence: readonly SanitizedEvidenceRef[];
  readonly terminalReason?: string;
}

export type ReviewDecisionKind =
  | "accept"
  | "revise"
  | "blocked_external"
  | "reject_scope"
  | "reject_correctness"
  | "unsupported";

export interface ReviewDecision {
  readonly schema: "dzupagent.reviewDecision/v1";
  readonly requestId: string;
  readonly correlationId: string;
  readonly generation: number;
  readonly candidateDigest: `sha256:${string}`;
  readonly reviewer: AgentActorRef;
  readonly independence: ReviewerIndependenceLevel;
  readonly decision: ReviewDecisionKind;
  readonly validation: "passed" | "failed" | "skipped" | "unavailable";
  readonly evidence: readonly SanitizedEvidenceRef[];
  readonly corrections: readonly string[];
  readonly blockers: readonly string[];
  readonly reason: string;
}

export interface ReviewLoopRequest {
  readonly schema: "dzupagent.reviewLoopRequest/v1";
  readonly requestId: string;
  readonly correlationId: string;
  readonly generation: number;
  readonly baselineDigest: `sha256:${string}`;
  readonly implementer: AgentActorRef;
  readonly maxRevisions: number;
  readonly requiredValidation: boolean;
  readonly minimumReviewerIndependence: ReviewerIndependenceLevel;
  readonly requireReadOnlyReviewer: boolean;
}

export type ReviewLoopTerminalStatus =
  | "accepted"
  | "exhausted"
  | "stalled"
  | "blocked_external"
  | "rejected_scope"
  | "rejected_correctness"
  | "reviewer_unavailable"
  | "invalid_decision"
  | "cancelled"
  | "failed";

export interface ReviewLoopResult {
  readonly schema: "dzupagent.reviewLoopResult/v1";
  readonly requestId: string;
  readonly correlationId: string;
  readonly generation: number;
  readonly finalCandidateDigest: `sha256:${string}`;
  readonly status: ReviewLoopTerminalStatus;
  readonly revisionsUsed: number;
  readonly lastDecision?: ReviewDecision;
  readonly progress: AgentProgress;
  readonly evidence: readonly SanitizedEvidenceRef[];
  readonly terminalReason: string;
}

export type AgentReviewDiagnosticCode =
  | "AGENT_IDENTITY_MISMATCH"
  | "AGENT_ACTOR_MISMATCH"
  | "AGENT_USAGE_INVALID"
  | "AGENT_LIMIT_EXCEEDED"
  | "AGENT_PROGRESS_INCONSISTENT"
  | "AGENT_COMPLETED_OUTPUT_MISSING"
  | "AGENT_TERMINAL_REASON_MISSING"
  | "AGENT_EVIDENCE_UNSANITIZED"
  | "AGENT_REQUIRED_EVIDENCE_MISSING"
  | "REVIEW_REQUEST_MISMATCH"
  | "REVIEW_CORRELATION_MISMATCH"
  | "REVIEW_GENERATION_MISMATCH"
  | "REVIEW_CANDIDATE_MISMATCH"
  | "REVIEWER_NOT_READ_ONLY"
  | "REVIEWER_ROLE_INVALID"
  | "REVIEWER_INDEPENDENCE_MISMATCH"
  | "REVIEWER_INDEPENDENCE_INSUFFICIENT"
  | "REVIEW_VALIDATION_NOT_PASSED"
  | "REVIEW_EVIDENCE_MISSING"
  | "REVIEW_ACCEPT_CONTRADICTORY"
  | "REVIEW_REVISION_MISSING"
  | "REVIEW_BLOCKER_MISSING"
  | "REVIEW_REASON_MISSING"
  | "REVIEW_DECISION_UNKNOWN"
  | "REVIEW_REVISION_LIMIT_EXCEEDED"
  | "REVIEW_TERMINAL_INCONSISTENT"
  | "REVIEW_TERMINAL_UNKNOWN"
  | "REVIEW_PROGRESS_INCONSISTENT";

export interface AgentReviewDiagnostic {
  readonly code: AgentReviewDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface AgentReviewValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly AgentReviewDiagnostic[];
}

export function validateAgentRunResult(
  request: AgentRunRequest,
  result: AgentRunResult,
): AgentReviewValidation {
  const diagnostics: AgentReviewDiagnostic[] = [];
  for (const key of [
    "runId",
    "nodeId",
    "logicalTurnId",
    "attemptId",
    "generation",
    "correlationId",
  ] as const) {
    if (request.identity[key] !== result.identity[key]) {
      add(
        diagnostics,
        "AGENT_IDENTITY_MISMATCH",
        `identity.${key}`,
        `Agent result ${key} does not match the admitted request.`,
      );
    }
  }
  if (request.actor.actorId !== result.actorId) {
    add(
      diagnostics,
      "AGENT_ACTOR_MISMATCH",
      "actorId",
      "Agent result actor does not match the admitted actor.",
    );
  }
  validateUsage(request.limits, result.usage, diagnostics);
  validateProgress(result.progress, "progress", diagnostics);
  validateEvidence(result.evidence, "evidence", diagnostics);
  for (const kind of request.requiredEvidenceKinds) {
    if (!result.evidence.some((item) => item.contentClass === kind)) {
      add(
        diagnostics,
        "AGENT_REQUIRED_EVIDENCE_MISSING",
        "evidence",
        `Agent result is missing required "${kind}" evidence.`,
      );
    }
  }
  if (result.status === "completed" && result.output === undefined) {
    add(
      diagnostics,
      "AGENT_COMPLETED_OUTPUT_MISSING",
      "output",
      "A completed agent result requires output.",
    );
  }
  if (result.status !== "completed" && !result.terminalReason?.trim()) {
    add(
      diagnostics,
      "AGENT_TERMINAL_REASON_MISSING",
      "terminalReason",
      "A non-completed agent result requires an explicit terminal reason.",
    );
  }
  return validation(diagnostics);
}

export function validateReviewDecision(
  request: ReviewLoopRequest,
  decision: ReviewDecision,
): AgentReviewValidation {
  const diagnostics: AgentReviewDiagnostic[] = [];
  if (
    ![
      "accept",
      "revise",
      "blocked_external",
      "reject_scope",
      "reject_correctness",
      "unsupported",
    ].includes(decision.decision)
  ) {
    add(
      diagnostics,
      "REVIEW_DECISION_UNKNOWN",
      "decision",
      "Review decision is outside the canonical vocabulary.",
    );
  }
  compare(
    request.requestId,
    decision.requestId,
    "REVIEW_REQUEST_MISMATCH",
    "requestId",
    diagnostics,
  );
  if (request.generation !== decision.generation) {
    add(
      diagnostics,
      "REVIEW_GENERATION_MISMATCH",
      "generation",
      "Review decision generation does not match the request.",
    );
  }
  if (
    !["reviewer", "semantic-judge", "next-path-approver", "terminal-approver"]
      .includes(decision.reviewer.role)
  ) {
    add(
      diagnostics,
      "REVIEWER_ROLE_INVALID",
      "reviewer.role",
      "Review decisions require a reviewer or adjudicator actor role.",
    );
  }
  compare(
    request.correlationId,
    decision.correlationId,
    "REVIEW_CORRELATION_MISMATCH",
    "correlationId",
    diagnostics,
  );
  if (request.requireReadOnlyReviewer && !decision.reviewer.readOnly) {
    add(
      diagnostics,
      "REVIEWER_NOT_READ_ONLY",
      "reviewer.readOnly",
      "This review loop requires a read-only reviewer.",
    );
  }
  const observedIndependence = deriveReviewerIndependence(
    request.implementer,
    decision.reviewer,
  );
  if (decision.independence !== observedIndependence) {
    add(
      diagnostics,
      "REVIEWER_INDEPENDENCE_MISMATCH",
      "independence",
      `Declared reviewer independence does not match observed "${observedIndependence}".`,
    );
  }
  if (
    decision.decision !== "unsupported" &&
    independenceRank(observedIndependence) <
    independenceRank(request.minimumReviewerIndependence)
  ) {
    add(
      diagnostics,
      "REVIEWER_INDEPENDENCE_INSUFFICIENT",
      "independence",
      "Reviewer independence is below the admitted minimum.",
    );
  }
  validateEvidence(decision.evidence, "evidence", diagnostics);
  if (!decision.reason.trim()) {
    add(
      diagnostics,
      "REVIEW_REASON_MISSING",
      "reason",
      "A review decision requires an explicit reason.",
    );
  }
  if (decision.decision === "accept") {
    if (request.requiredValidation && decision.validation !== "passed") {
      add(
        diagnostics,
        "REVIEW_VALIDATION_NOT_PASSED",
        "validation",
        "Acceptance requires passed host validation.",
      );
    }
    if (decision.evidence.length === 0) {
      add(
        diagnostics,
        "REVIEW_EVIDENCE_MISSING",
        "evidence",
        "Acceptance requires retained sanitized evidence.",
      );
    }
    if (decision.corrections.length > 0 || decision.blockers.length > 0) {
      add(
        diagnostics,
        "REVIEW_ACCEPT_CONTRADICTORY",
        "decision",
        "Acceptance cannot also require corrections or report blockers.",
      );
    }
  }
  if (decision.decision === "revise" && decision.corrections.length === 0) {
    add(
      diagnostics,
      "REVIEW_REVISION_MISSING",
      "corrections",
      "A revise decision requires at least one correction.",
    );
  }
  if (
    decision.decision === "blocked_external" &&
    decision.blockers.length === 0
  ) {
    add(
      diagnostics,
      "REVIEW_BLOCKER_MISSING",
      "blockers",
      "An external blocker decision requires blocker evidence.",
    );
  }
  return validation(diagnostics);
}

export function validateReviewLoopResult(
  request: ReviewLoopRequest,
  result: ReviewLoopResult,
): AgentReviewValidation {
  const diagnostics: AgentReviewDiagnostic[] = [];
  if (
    ![
      "accepted",
      "exhausted",
      "stalled",
      "blocked_external",
      "rejected_scope",
      "rejected_correctness",
      "reviewer_unavailable",
      "invalid_decision",
      "cancelled",
      "failed",
    ].includes(result.status)
  ) {
    add(
      diagnostics,
      "REVIEW_TERMINAL_UNKNOWN",
      "status",
      "Review-loop terminal is outside the canonical vocabulary.",
    );
  }
  compare(
    request.requestId,
    result.requestId,
    "REVIEW_REQUEST_MISMATCH",
    "requestId",
    diagnostics,
  );
  compare(
    request.correlationId,
    result.correlationId,
    "REVIEW_CORRELATION_MISMATCH",
    "correlationId",
    diagnostics,
  );
  if (request.generation !== result.generation) {
    add(
      diagnostics,
      "REVIEW_GENERATION_MISMATCH",
      "generation",
      "Review-loop result generation does not match the request.",
    );
  }
  if (
    !Number.isInteger(result.revisionsUsed) ||
    result.revisionsUsed < 0 ||
    result.revisionsUsed > request.maxRevisions
  ) {
    add(
      diagnostics,
      "REVIEW_REVISION_LIMIT_EXCEEDED",
      "revisionsUsed",
      "Review-loop revisions exceed the admitted bound.",
    );
  }
  validateProgress(result.progress, "progress", diagnostics);
  if (
    result.progress.beforeDigest !== request.baselineDigest ||
    result.progress.afterDigest !== result.finalCandidateDigest
  ) {
    add(
      diagnostics,
      "REVIEW_PROGRESS_INCONSISTENT",
      "progress",
      "Review-loop progress must bind the request baseline and final candidate.",
    );
  }
  validateEvidence(result.evidence, "evidence", diagnostics);
  if (!result.terminalReason.trim()) {
    add(
      diagnostics,
      "AGENT_TERMINAL_REASON_MISSING",
      "terminalReason",
      "A review-loop terminal result requires an explicit reason.",
    );
  }
  if (result.lastDecision) {
    if (result.lastDecision.candidateDigest !== result.finalCandidateDigest) {
      add(
        diagnostics,
        "REVIEW_CANDIDATE_MISMATCH",
        "lastDecision.candidateDigest",
        "The final review decision must bind the final candidate digest.",
      );
    }
    const decisionDiagnostics = validateReviewDecision(
      request,
      result.lastDecision,
    ).diagnostics;
    if (result.status === "invalid_decision") {
      const bindingCodes = new Set<AgentReviewDiagnosticCode>([
        "REVIEW_REQUEST_MISMATCH",
        "REVIEW_CORRELATION_MISMATCH",
        "REVIEW_GENERATION_MISMATCH",
      ]);
      const bindingDiagnostics = decisionDiagnostics.filter((diagnostic) =>
        bindingCodes.has(diagnostic.code),
      );
      diagnostics.push(
        ...bindingDiagnostics.map((diagnostic) => ({
          ...diagnostic,
          path: `lastDecision.${diagnostic.path}`,
        })),
      );
      if (
        decisionDiagnostics.filter(
          (diagnostic) => !bindingCodes.has(diagnostic.code),
        ).length === 0
      ) {
        terminalInconsistent(
          result.status,
          "a decision that fails canonical admission",
          diagnostics,
        );
      }
    } else {
      diagnostics.push(
        ...decisionDiagnostics.map((diagnostic) => ({
          ...diagnostic,
          path: `lastDecision.${diagnostic.path}`,
        })),
      );
    }
  }
  validateReviewTerminal(request, result, diagnostics);
  return validation(diagnostics);
}

function validateReviewTerminal(
  request: ReviewLoopRequest,
  result: ReviewLoopResult,
  diagnostics: AgentReviewDiagnostic[],
): void {
  const decision = result.lastDecision?.decision;
  const expected: Partial<
    Record<ReviewLoopTerminalStatus, ReviewDecisionKind>
  > = {
    accepted: "accept",
    blocked_external: "blocked_external",
    rejected_scope: "reject_scope",
    rejected_correctness: "reject_correctness",
  };
  const expectedDecision = expected[result.status];
  if (expectedDecision && decision !== expectedDecision) {
    terminalInconsistent(result.status, expectedDecision, diagnostics);
  }
  if (
    result.status === "exhausted" &&
    (decision !== "revise" || result.revisionsUsed !== request.maxRevisions)
  ) {
    terminalInconsistent(
      result.status,
      "a revise decision at the exact revision limit",
      diagnostics,
    );
  }
  if (result.status === "stalled" && result.progress.changed) {
    add(
      diagnostics,
      "REVIEW_PROGRESS_INCONSISTENT",
      "progress.changed",
      "A stalled review loop cannot report changed progress.",
    );
  }
  if (
    result.status === "reviewer_unavailable" &&
    decision !== undefined &&
    decision !== "unsupported"
  ) {
    terminalInconsistent(
      result.status,
      "no decision or unsupported",
      diagnostics,
    );
  }
  if (result.status === "invalid_decision" && !result.lastDecision) {
    terminalInconsistent(
      result.status,
      "a retained invalid decision",
      diagnostics,
    );
  }
}

function validateUsage(
  limits: AgentRunLimits,
  usage: AgentRunUsage,
  diagnostics: AgentReviewDiagnostic[],
): void {
  const entries = [
    ["turns", usage.turns, limits.maxTurns],
    ["toolCalls", usage.toolCalls, limits.maxToolCalls],
    ["inputTokens", usage.inputTokens, limits.maxInputTokens],
    ["outputTokens", usage.outputTokens, limits.maxOutputTokens],
    ["costCents", usage.costCents, limits.maxCostCents],
  ] as const;
  for (const [key, observed, limit] of entries) {
    if (!Number.isFinite(observed) || observed < 0) {
      add(
        diagnostics,
        "AGENT_USAGE_INVALID",
        `usage.${key}`,
        `${key} usage must be a finite non-negative number.`,
      );
    } else if (observed > limit) {
      add(
        diagnostics,
        "AGENT_LIMIT_EXCEEDED",
        `usage.${key}`,
        `${key} usage exceeds the admitted limit.`,
      );
    }
  }
}

function validateProgress(
  progress: AgentProgress,
  path: string,
  diagnostics: AgentReviewDiagnostic[],
): void {
  if (progress.changed !== (progress.beforeDigest !== progress.afterDigest)) {
    add(
      diagnostics,
      "AGENT_PROGRESS_INCONSISTENT",
      `${path}.changed`,
      "Progress changed flag must match the before/after digests.",
    );
  }
}

function validateEvidence(
  evidence: readonly SanitizedEvidenceRef[],
  path: string,
  diagnostics: AgentReviewDiagnostic[],
): void {
  for (const [index, item] of evidence.entries()) {
    if (
      item.digestOf !== "sanitized" ||
      !item.digest.trim() ||
      !item.redactionStatus.trim()
    ) {
      add(
        diagnostics,
        "AGENT_EVIDENCE_UNSANITIZED",
        `${path}[${index}]`,
        "Agent/review evidence must identify sanitized retained content.",
      );
    }
  }
}

function independenceRank(level: ReviewerIndependenceLevel): number {
  return REVIEWER_INDEPENDENCE_LEVELS.indexOf(level);
}

export function deriveReviewerIndependence(
  implementer: AgentActorRef,
  reviewer: AgentActorRef,
): ReviewerIndependenceLevel {
  if (implementer.providerId !== reviewer.providerId) {
    return "separate-provider";
  }
  if (
    implementer.modelId &&
    reviewer.modelId &&
    implementer.modelId !== reviewer.modelId
  ) {
    return "separate-model";
  }
  if (
    implementer.actorId !== reviewer.actorId &&
    implementer.sessionId &&
    reviewer.sessionId &&
    implementer.sessionId !== reviewer.sessionId
  ) {
    return "separate-session";
  }
  return "same-session";
}

function terminalInconsistent(
  status: ReviewLoopTerminalStatus,
  expected: string,
  diagnostics: AgentReviewDiagnostic[],
): void {
  add(
    diagnostics,
    "REVIEW_TERMINAL_INCONSISTENT",
    "status",
    `Review-loop status "${status}" requires ${expected}.`,
  );
}

function compare(
  expected: string,
  actual: string,
  code: AgentReviewDiagnosticCode,
  path: string,
  diagnostics: AgentReviewDiagnostic[],
): void {
  if (expected !== actual) {
    add(
      diagnostics,
      code,
      path,
      `${path} does not match the admitted review-loop request.`,
    );
  }
}

function add(
  diagnostics: AgentReviewDiagnostic[],
  code: AgentReviewDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

function validation(
  diagnostics: AgentReviewDiagnostic[],
): AgentReviewValidation {
  return { valid: diagnostics.length === 0, diagnostics };
}
