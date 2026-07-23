import type {
  ContinuationEvidenceV1,
  ContinuationHashV1,
  ContinuationNormalizationResultV1,
  ContinuationPolicyV1,
  ContinuationTransitionV1,
  HostControlV1,
} from "@dzupagent/dialogue-core/continuation/v1";

export const CONTINUATION_CONFORMANCE_FIXTURE_SET_SCHEMA_V1 =
  "dzupagent/continuation-conformance-fixture-set/v1" as const;
export const CONTINUATION_DIVERGENCE_LEDGER_SCHEMA_V1 =
  "dzupagent/continuation-divergence-ledger/v1" as const;

export type ContinuationConformanceFamilyV1 =
  | "scripts_historical"
  | "codev"
  | "adversarial";

export type ContinuationComparisonClassificationV1 =
  | "match"
  | "safer_kernel"
  | "unsafe_kernel"
  | "reviewed_difference";

export interface ContinuationConformanceSourceV1 {
  readonly sourceId: string;
  readonly family: ContinuationConformanceFamilyV1;
  readonly sourceSchema: string;
  readonly sourceDigest: ContinuationHashV1;
  readonly sourceByteDigest?: ContinuationHashV1;
  readonly sourceCaseCount: number;
  readonly reductionProcedureVersion: string;
}

export interface ContinuationLegacyObservationV1 {
  readonly normalizedDecision:
    | "continue"
    | "complete"
    | "blocked"
    | "judge_required"
    | "genuine_blocker"
    | "non_semantic_blocker"
    | "unclassified";
  readonly admittedTransition:
    | "continue"
    | "complete"
    | "blocked"
    | "review_again"
    | "reject"
    | "host_stop"
    | "suspend";
  readonly diagnosticCodes: readonly string[];
}

export interface ContinuationConformanceCaseV1 {
  readonly caseId: string;
  readonly family: ContinuationConformanceFamilyV1;
  readonly sourceId: string;
  readonly description: string;
  readonly input: {
    readonly proposal: ContinuationNormalizationResultV1;
    readonly evidence: ContinuationEvidenceV1;
    readonly policy: ContinuationPolicyV1;
    readonly hostControl: HostControlV1;
  };
  readonly expected: {
    readonly kernelTransition: ContinuationTransitionV1;
    readonly comparisonClassification: Exclude<
      ContinuationComparisonClassificationV1,
      "unsafe_kernel"
    >;
    readonly legacy?: ContinuationLegacyObservationV1;
  };
}

export interface ContinuationDivergenceLedgerEntryV1 {
  readonly schema: typeof CONTINUATION_DIVERGENCE_LEDGER_SCHEMA_V1;
  readonly caseId: string;
  readonly classification: "safer_kernel" | "reviewed_difference";
  readonly legacySummary: string;
  readonly kernelSummary: string;
  readonly safetyRationale: string;
  readonly reviewStatus: "proposed" | "approved";
  readonly reviewedBy: string;
  readonly reviewedAt: string;
}

export interface ContinuationFixturePublicationReviewV1 {
  readonly reviewStatus: "automated" | "approved";
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly containsRawProviderOutput: false;
  readonly containsAbsolutePaths: false;
  readonly containsTenantContent: false;
  readonly containsCredentials: false;
}

/**
 * Separate from scheduler golden traces. A fixture set records normalized
 * continuation inputs and expected pure transitions; it never embeds raw
 * provider responses, host paths, tenant content, or credentials.
 */
export interface ContinuationConformanceFixtureSetV1 {
  readonly schema: typeof CONTINUATION_CONFORMANCE_FIXTURE_SET_SCHEMA_V1;
  readonly fixtureSetId: string;
  readonly contractVersion: "continuation/v1";
  readonly sources: readonly ContinuationConformanceSourceV1[];
  readonly cases: readonly ContinuationConformanceCaseV1[];
  readonly divergenceLedger: readonly ContinuationDivergenceLedgerEntryV1[];
  readonly publicationReview: ContinuationFixturePublicationReviewV1;
}
