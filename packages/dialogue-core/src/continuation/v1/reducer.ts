import { createContinuationTaskKeyV1 } from "./task-key.js";
import {
  CONTINUATION_EVIDENCE_SCHEMA_V1,
  CONTINUATION_POLICY_SCHEMA_V1,
  CONTINUATION_TRANSITION_SCHEMA_V1,
  type ContinuationDiagnosticCodeV1,
  type ContinuationEvidenceV1,
  type ContinuationPolicyV1,
  type ContinuationTransitionV1,
  type EvaluateContinuationTransitionInputV1,
  type HostControlV1,
} from "./types.js";

const TASK_KEY_PATTERN = /^task-key\/v1:sha256:[a-f0-9]{64}$/u;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const VALIDATION_STATUSES = new Set([
  "not_required",
  "not_run",
  "passed",
  "failed",
  "unavailable",
]);
const HOST_STOP_REASONS = new Set([
  "cancelled",
  "authority_denied",
  "budget_exceeded",
  "timeout",
  "iteration_limit",
  "host_failure",
]);

export function evaluateContinuationTransitionV1(
  input: EvaluateContinuationTransitionInputV1
): ContinuationTransitionV1 {
  if (!isHostControlV1(input.hostControl)) {
    return reject("invalid_host_control", [
      "host_control.invalid",
      "transition.rejected_invalid_host_control",
    ]);
  }

  if (input.hostControl.action === "stop") {
    return {
      schema: CONTINUATION_TRANSITION_SCHEMA_V1,
      action: "stop",
      reason: input.hostControl.reason,
      diagnostics: ["transition.host_stop"],
    };
  }

  if (input.hostControl.action === "suspend") {
    return {
      schema: CONTINUATION_TRANSITION_SCHEMA_V1,
      action: "suspend",
      reason: input.hostControl.reason,
      diagnostics: ["transition.host_suspend"],
    };
  }

  if (input.proposal.status !== "valid") {
    return reject("invalid_proposal", [
      ...input.proposal.diagnostics,
      "transition.rejected_invalid_proposal",
    ]);
  }

  if (!isContinuationEvidenceV1(input.evidence)) {
    return reject("invalid_evidence", [
      "evidence.invalid",
      "transition.rejected_invalid_evidence",
    ]);
  }

  if (!isContinuationPolicyV1(input.policy)) {
    return reject("invalid_policy", [
      "policy.invalid",
      "transition.rejected_invalid_policy",
    ]);
  }

  const proposal = input.proposal.proposal;
  if (proposal.verdict === "blocked") {
    return evaluateBlockedTransition(
      proposal.evidenceRefs,
      input.evidence,
      input.policy
    );
  }

  if (proposal.verdict === "complete") {
    return evaluateCompleteTransition(input.evidence, input.policy);
  }

  const taskKey = createContinuationTaskKeyV1(proposal.nextTask);
  const priorOccurrences = input.evidence.progress.priorTaskKeys.filter(
    (priorTaskKey) => priorTaskKey === taskKey
  ).length;

  if (
    priorOccurrences >= input.policy.repeatedTask.maxPriorOccurrences
  ) {
    if (input.policy.repeatedTask.onLimit === "stop_stuck") {
      return {
        schema: CONTINUATION_TRANSITION_SCHEMA_V1,
        action: "stop",
        reason: "stuck",
        diagnostics: ["transition.repeated_task"],
      };
    }

    return {
      schema: CONTINUATION_TRANSITION_SCHEMA_V1,
      action: "review_again",
      reason: "repeated_task",
      diagnostics: ["transition.repeated_task"],
    };
  }

  return {
    schema: CONTINUATION_TRANSITION_SCHEMA_V1,
    action: "continue",
    nextTask: proposal.nextTask,
    taskKey,
    diagnostics: ["transition.continue"],
  };
}

function evaluateBlockedTransition(
  proposalEvidenceRefs: readonly string[],
  evidence: ContinuationEvidenceV1,
  policy: ContinuationPolicyV1
): ContinuationTransitionV1 {
  if (policy.terminalBlocked !== "allow") {
    return {
      schema: CONTINUATION_TRANSITION_SCHEMA_V1,
      action: "review_again",
      reason: "blocked_not_permitted",
      diagnostics: ["transition.blocked_not_permitted"],
    };
  }

  const verifiedBlockers = evidence.blockers.filter(
    (blocker) =>
      blocker.verified &&
      proposalEvidenceRefs.includes(blocker.evidenceRef)
  );
  if (verifiedBlockers.length === 0) {
    return {
      schema: CONTINUATION_TRANSITION_SCHEMA_V1,
      action: "review_again",
      reason: "blocker_evidence_unverified",
      diagnostics: ["transition.blocker_evidence_unverified"],
    };
  }

  return {
    schema: CONTINUATION_TRANSITION_SCHEMA_V1,
    action: "stop",
    reason: "blocked",
    blockerCodes: uniqueSorted(
      verifiedBlockers.map((blocker) => blocker.code)
    ),
    diagnostics: ["transition.blocked"],
  };
}

function evaluateCompleteTransition(
  evidence: ContinuationEvidenceV1,
  policy: ContinuationPolicyV1
): ContinuationTransitionV1 {
  const verifiedBlockerCodes = uniqueSorted(
    evidence.blockers
      .filter((blocker) => blocker.verified)
      .map((blocker) => blocker.code)
  );
  if (verifiedBlockerCodes.length > 0) {
    return {
      schema: CONTINUATION_TRANSITION_SCHEMA_V1,
      action: "review_again",
      reason: "completion_blocked",
      blockerCodes: verifiedBlockerCodes,
      diagnostics: ["transition.completion_blocked"],
    };
  }

  const validationSatisfiesPolicy =
    evidence.validation.status === "passed" ||
    (policy.completionValidation === "passed_or_not_required" &&
      evidence.validation.status === "not_required");
  if (!validationSatisfiesPolicy) {
    return {
      schema: CONTINUATION_TRANSITION_SCHEMA_V1,
      action: "review_again",
      reason: "completion_validation_insufficient",
      diagnostics: ["transition.completion_validation_insufficient"],
    };
  }

  return {
    schema: CONTINUATION_TRANSITION_SCHEMA_V1,
    action: "stop",
    reason: "complete",
    diagnostics: ["transition.complete"],
  };
}

function reject(
  reason: Extract<
    ContinuationTransitionV1,
    { readonly action: "reject" }
  >["reason"],
  diagnostics: readonly ContinuationDiagnosticCodeV1[]
): ContinuationTransitionV1 {
  return {
    schema: CONTINUATION_TRANSITION_SCHEMA_V1,
    action: "reject",
    reason,
    diagnostics: [...new Set(diagnostics)],
  };
}

function isContinuationEvidenceV1(
  evidence: ContinuationEvidenceV1
): boolean {
  if (
    !isRecord(evidence) ||
    evidence.schema !== CONTINUATION_EVIDENCE_SCHEMA_V1 ||
    !isRecord(evidence.runIdentity) ||
    !isNonEmptyString(evidence.runIdentity["runId"]) ||
    !isHash(evidence.runIdentity["planDigest"]) ||
    !isHash(evidence.runIdentity["policyDigest"]) ||
    !isRecord(evidence.progress) ||
    !isNonNegativeInteger(evidence.progress["iteration"]) ||
    !isStringArray(evidence.progress["priorTaskKeys"]) ||
    !evidence.progress["priorTaskKeys"].every((key) =>
      TASK_KEY_PATTERN.test(key)
    ) ||
    !isNonNegativeInteger(evidence.progress["requestedToolCalls"]) ||
    !isNonNegativeInteger(evidence.progress["successfulToolCalls"]) ||
    !isNonNegativeInteger(evidence.progress["failedToolCalls"]) ||
    evidence.progress["successfulToolCalls"] +
      evidence.progress["failedToolCalls"] >
      evidence.progress["requestedToolCalls"] ||
    !isRecord(evidence.validation) ||
    !VALIDATION_STATUSES.has(evidence.validation["status"]) ||
    !isNonEmptyUniqueStringArray(evidence.validation["verifiedRefs"]) ||
    !Array.isArray(evidence.blockers)
  ) {
    return false;
  }

  return evidence.blockers.every(
    (blocker) =>
      isRecord(blocker) &&
      isNonEmptyString(blocker["code"]) &&
      typeof blocker["verified"] === "boolean" &&
      isNonEmptyString(blocker["evidenceRef"])
  );
}

function isContinuationPolicyV1(policy: ContinuationPolicyV1): boolean {
  return (
    isRecord(policy) &&
    policy.schema === CONTINUATION_POLICY_SCHEMA_V1 &&
    (policy.terminalBlocked === "allow" ||
      policy.terminalBlocked === "review_again") &&
    (policy.completionValidation === "passed" ||
      policy.completionValidation === "passed_or_not_required") &&
    isRecord(policy.repeatedTask) &&
    isNonNegativeInteger(policy.repeatedTask["maxPriorOccurrences"]) &&
    policy.repeatedTask["maxPriorOccurrences"] > 0 &&
    (policy.repeatedTask["onLimit"] === "review_again" ||
      policy.repeatedTask["onLimit"] === "stop_stuck")
  );
}

function isHostControlV1(control: HostControlV1): boolean {
  if (!isRecord(control)) {
    return false;
  }

  switch (control.action) {
    case "run":
      return Object.keys(control).length === 1;
    case "suspend":
      return (
        Object.keys(control).length === 2 &&
        (control.reason === "paused" ||
          control.reason === "approval_required")
      );
    case "stop":
      return (
        Object.keys(control).length === 2 &&
        HOST_STOP_REASONS.has(control.reason)
      );
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string")
  );
}

function isNonEmptyUniqueStringArray(value: unknown): value is string[] {
  return (
    isStringArray(value) &&
    value.every((item) => item.trim().length > 0) &&
    new Set(value).size === value.length
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
