import type {
  RagCompositionResult,
  RagCorpusSnapshotRef,
} from "@dzupagent/runtime-contracts/rag";

export interface LocalRagEvaluationDocument {
  readonly id: string;
  readonly text: string;
  readonly sourceRef: string;
  readonly locator: string;
  readonly version?: string;
  readonly accessScopes: readonly string[];
  readonly contentClass: string;
}

export interface LocalRagEvaluationCase {
  readonly caseId: string;
  readonly query: string;
  readonly dataScopes: readonly string[];
  readonly relevantDocumentIds: readonly string[];
  readonly expectedStatus:
    | "answered"
    | "no-results"
    | "insufficient-evidence";
  readonly topK?: number;
  readonly minimumEvidenceItems?: number;
  readonly requiredAnswerTerms?: readonly string[];
}

export interface LocalRagEvaluationThresholds {
  readonly minimumRecallAtK: number;
  readonly minimumPrecisionAtK: number;
  readonly minimumStatusAccuracy: number;
  readonly minimumGroundingCoverage: number;
  readonly minimumRequiredTermCoverage: number;
  readonly minimumAbstentionAccuracy: number;
}

export interface LocalRagEvaluationCaseResult {
  readonly caseId: string;
  readonly status: RagCompositionResult["status"];
  readonly expectedStatus: LocalRagEvaluationCase["expectedStatus"];
  readonly retrievedDocumentIds: readonly string[];
  readonly recallAtK: number;
  readonly precisionAtK: number;
  readonly statusCorrect: boolean;
  readonly groundingCoverage: number;
  readonly requiredTermCoverage: number;
  readonly abstentionExpected: boolean;
  readonly abstentionObserved: boolean;
  readonly abstentionCorrect: boolean;
  readonly deterministicOperationCount: number;
  readonly observedDurationMs: number;
  readonly result: RagCompositionResult;
}

export interface LocalRagEvaluationReport {
  readonly schema: "dzupagent.localRagEvaluationReport/v1";
  readonly snapshot: RagCorpusSnapshotRef;
  readonly evaluatedAt: string;
  readonly cases: readonly LocalRagEvaluationCaseResult[];
  readonly aggregate: {
    readonly caseCount: number;
    readonly meanRecallAtK: number;
    readonly meanPrecisionAtK: number;
    readonly statusAccuracy: number;
    readonly groundingCoverage: number;
    readonly requiredTermCoverage: number;
    readonly abstentionAccuracy: number;
    readonly deterministicOperationCount: number;
    readonly observedDurationMs: number;
    readonly providerCalls: 0;
    readonly estimatedCostCents: 0;
  };
  readonly thresholds: LocalRagEvaluationThresholds;
  readonly passed: boolean;
  readonly deterministicFingerprint: `sha256:${string}`;
  readonly boundaries: {
    readonly providerCalls: 0;
    readonly networkAccess: false;
    readonly indexMutationAuthorized: false;
    readonly snapshotPromotionAuthorized: false;
    readonly authorityEffect: "none";
  };
}

export interface DeterministicLocalRagEvaluationHostOptions {
  readonly snapshotId: string;
  readonly snapshotCreatedAt: string;
  readonly evaluatedAt: string;
}
