export const CONTINUATION_PROPOSAL_SCHEMA_V1 =
  "dzupagent/continuation-proposal/v1" as const;
export const CONTINUATION_EVIDENCE_SCHEMA_V1 =
  "dzupagent/continuation-evidence/v1" as const;
export const CONTINUATION_POLICY_SCHEMA_V1 =
  "dzupagent/continuation-policy/v1" as const;
export const CONTINUATION_TRANSITION_SCHEMA_V1 =
  "dzupagent/continuation-transition/v1" as const;

export const CONTINUATION_V1_MAX_NEXT_TASK_LENGTH = 2_048;
export const CONTINUATION_V1_MAX_RATIONALE_LENGTH = 8_192;
export const CONTINUATION_V1_MAX_EVIDENCE_REFS = 64;
export const CONTINUATION_V1_MAX_EVIDENCE_REF_LENGTH = 256;

export type ContinuationVerdictV1 = "continue" | "complete" | "blocked";

interface ContinuationProposalBaseV1 {
  readonly schema: typeof CONTINUATION_PROPOSAL_SCHEMA_V1;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
}

export type ContinuationProposalV1 =
  | (ContinuationProposalBaseV1 & {
      readonly verdict: "continue";
      readonly nextTask: string;
    })
  | (ContinuationProposalBaseV1 & {
      readonly verdict: "complete" | "blocked";
      readonly nextTask: "";
    });

export const CONTINUATION_DIAGNOSTIC_CODES_V1 = [
  "proposal.not_object",
  "proposal.malformed_json",
  "proposal.ambiguous_wrapper",
  "proposal.unknown_field",
  "proposal.schema_invalid",
  "proposal.verdict_unknown",
  "proposal.next_task_required",
  "proposal.next_task_must_be_empty",
  "proposal.next_task_too_long",
  "proposal.rationale_required",
  "proposal.rationale_too_long",
  "proposal.evidence_refs_invalid",
  "proposal.evidence_refs_limit_exceeded",
  "proposal.evidence_ref_invalid",
  "proposal.evidence_ref_too_long",
  "proposal.evidence_ref_duplicate",
  "evidence.invalid",
  "policy.invalid",
  "host_control.invalid",
  "transition.host_stop",
  "transition.host_suspend",
  "transition.rejected_invalid_proposal",
  "transition.rejected_invalid_evidence",
  "transition.rejected_invalid_policy",
  "transition.rejected_invalid_host_control",
  "transition.blocked_not_permitted",
  "transition.blocker_evidence_unverified",
  "transition.completion_blocked",
  "transition.completion_validation_insufficient",
  "transition.repeated_task",
  "transition.continue",
  "transition.complete",
  "transition.blocked",
] as const;

export type ContinuationDiagnosticCodeV1 =
  (typeof CONTINUATION_DIAGNOSTIC_CODES_V1)[number];

export type ContinuationNormalizationRuleV1 =
  | "direct_object"
  | "json_text"
  | "fenced_json"
  | "trim_strings";

interface ContinuationNormalizationBaseV1 {
  readonly schema: "dzupagent/continuation-normalization/v1";
  readonly appliedRules: readonly ContinuationNormalizationRuleV1[];
  readonly diagnostics: readonly ContinuationDiagnosticCodeV1[];
}

export type ContinuationNormalizationResultV1 =
  | (ContinuationNormalizationBaseV1 & {
      readonly status: "valid";
      readonly proposal: ContinuationProposalV1;
    })
  | (ContinuationNormalizationBaseV1 & {
      readonly status: "invalid";
    });

export interface ContinuationEvidenceV1 {
  readonly schema: typeof CONTINUATION_EVIDENCE_SCHEMA_V1;
  readonly runIdentity: {
    readonly runId: string;
    readonly planDigest: string;
    readonly policyDigest: string;
  };
  readonly progress: {
    readonly iteration: number;
    readonly priorTaskKeys: readonly string[];
    readonly requestedToolCalls: number;
    readonly successfulToolCalls: number;
    readonly failedToolCalls: number;
  };
  readonly validation: {
    readonly status:
      | "not_required"
      | "not_run"
      | "passed"
      | "failed"
      | "unavailable";
    readonly verifiedRefs: readonly string[];
  };
  readonly blockers: readonly {
    readonly code: string;
    readonly verified: boolean;
    readonly evidenceRef: string;
  }[];
}

export interface ContinuationPolicyV1 {
  readonly schema: typeof CONTINUATION_POLICY_SCHEMA_V1;
  readonly terminalBlocked: "allow" | "review_again";
  readonly completionValidation:
    | "passed"
    | "passed_or_not_required";
  readonly repeatedTask: {
    readonly maxPriorOccurrences: number;
    readonly onLimit: "review_again" | "stop_stuck";
  };
}

export type HostControlV1 =
  | { readonly action: "run" }
  | {
      readonly action: "suspend";
      readonly reason: "paused" | "approval_required";
    }
  | {
      readonly action: "stop";
      readonly reason:
        | "cancelled"
        | "authority_denied"
        | "budget_exceeded"
        | "timeout"
        | "iteration_limit"
        | "host_failure";
    };

export type ContinuationHostStopReasonV1 = Extract<
  HostControlV1,
  { readonly action: "stop" }
>["reason"];

interface ContinuationTransitionBaseV1 {
  readonly schema: typeof CONTINUATION_TRANSITION_SCHEMA_V1;
  readonly diagnostics: readonly ContinuationDiagnosticCodeV1[];
}

export type ContinuationTransitionV1 =
  | (ContinuationTransitionBaseV1 & {
      readonly action: "continue";
      readonly nextTask: string;
      readonly taskKey: ContinuationTaskKeyV1;
    })
  | (ContinuationTransitionBaseV1 & {
      readonly action: "stop";
      readonly reason:
        | ContinuationHostStopReasonV1
        | "complete"
        | "blocked"
        | "stuck";
      readonly blockerCodes?: readonly string[];
    })
  | (ContinuationTransitionBaseV1 & {
      readonly action: "suspend";
      readonly reason: "paused" | "approval_required";
    })
  | (ContinuationTransitionBaseV1 & {
      readonly action: "review_again";
      readonly reason:
        | "blocked_not_permitted"
        | "blocker_evidence_unverified"
        | "completion_blocked"
        | "completion_validation_insufficient"
        | "repeated_task";
      readonly blockerCodes?: readonly string[];
    })
  | (ContinuationTransitionBaseV1 & {
      readonly action: "reject";
      readonly reason:
        | "invalid_proposal"
        | "invalid_evidence"
        | "invalid_policy"
        | "invalid_host_control";
    });

export type ContinuationTaskKeyV1 =
  `task-key/v1:sha256:${string}`;

export type ContinuationHashV1 = `sha256:${string}`;

export interface EvaluateContinuationTransitionInputV1 {
  readonly proposal: ContinuationNormalizationResultV1;
  readonly evidence: ContinuationEvidenceV1;
  readonly policy: ContinuationPolicyV1;
  readonly hostControl: HostControlV1;
}
