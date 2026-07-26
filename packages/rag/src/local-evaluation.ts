import { performance } from "node:perf_hooks";

import {
  digestRagEvidenceBundle,
  executeRagComposition,
  type RagCompositionPolicy,
  type RagCompositionResult,
  type RagCorpusSnapshotRef,
  type RagEvidenceBundle,
  type RagRetrievalAttemptContext,
  type RagRetrievalRequest,
} from "@dzupagent/runtime-contracts/rag";
import {
  SAFE_ID,
  digest,
  isSubset,
  lexicalScore,
  mean,
  round,
  termFrequencies,
  validateCase,
  validateDocument,
  validateThresholds,
  validateTimestamp,
} from "./local-evaluation-internals.js";
import type {
  DeterministicLocalRagEvaluationHostOptions,
  LocalRagEvaluationCase,
  LocalRagEvaluationCaseResult,
  LocalRagEvaluationDocument,
  LocalRagEvaluationReport,
  LocalRagEvaluationThresholds,
} from "./local-evaluation-types.js";

export type {
  DeterministicLocalRagEvaluationHostOptions,
  LocalRagEvaluationCase,
  LocalRagEvaluationCaseResult,
  LocalRagEvaluationDocument,
  LocalRagEvaluationReport,
  LocalRagEvaluationThresholds,
} from "./local-evaluation-types.js";
const DEFAULT_THRESHOLDS: LocalRagEvaluationThresholds = Object.freeze({
  minimumRecallAtK: 1,
  minimumPrecisionAtK: 1,
  minimumStatusAccuracy: 1,
  minimumGroundingCoverage: 1,
  minimumRequiredTermCoverage: 1,
  minimumAbstentionAccuracy: 1,
});

interface IndexedDocument {
  readonly document: LocalRagEvaluationDocument;
  readonly terms: ReadonlyMap<string, number>;
}

export class DeterministicLocalRagEvaluationHost {
  readonly snapshot: RagCorpusSnapshotRef;

  private readonly documents: readonly IndexedDocument[];
  private readonly documentsById: ReadonlyMap<string, IndexedDocument>;
  private readonly evaluatedAt: string;

  constructor(
    documents: readonly LocalRagEvaluationDocument[],
    options: DeterministicLocalRagEvaluationHostOptions,
  ) {
    validateTimestamp(options.snapshotCreatedAt, "snapshotCreatedAt");
    validateTimestamp(options.evaluatedAt, "evaluatedAt");
    if (!SAFE_ID.test(options.snapshotId)) {
      throw new Error("Local RAG snapshotId is invalid.");
    }
    const ids = new Set<string>();
    const normalized = [...documents]
      .map((document) => {
        validateDocument(document);
        if (ids.has(document.id)) {
          throw new Error(`Duplicate local RAG document id "${document.id}".`);
        }
        ids.add(document.id);
        return Object.freeze({
          document: Object.freeze({
            ...document,
            accessScopes: Object.freeze(
              [...new Set(document.accessScopes)].sort(),
            ),
          }),
          terms: termFrequencies(document.text),
        });
      })
      .sort((left, right) =>
        left.document.id.localeCompare(right.document.id),
      );
    if (normalized.length === 0) {
      throw new Error("Local RAG evaluation requires a non-empty corpus.");
    }
    this.documents = Object.freeze(normalized);
    this.documentsById = new Map(
      normalized.map((entry) => [entry.document.id, entry]),
    );
    this.evaluatedAt = options.evaluatedAt;
    const accessScopes = [
      ...new Set(
        normalized.flatMap((entry) => entry.document.accessScopes),
      ),
    ].sort();
    const snapshotPayload = normalized.map((entry) => entry.document);
    this.snapshot = Object.freeze({
      schema: "dzupagent.ragCorpusSnapshotRef/v1",
      snapshotId: options.snapshotId,
      digest: digest(snapshotPayload),
      createdAt: options.snapshotCreatedAt,
      sourceCount: normalized.length,
      accessScopes: Object.freeze(accessScopes),
    });
  }

  createRequest(input: {
    readonly requestId: string;
    readonly correlationId: string;
    readonly query: string;
    readonly dataScopes: readonly string[];
    readonly topK: number;
  }): RagRetrievalRequest {
    if (
      !SAFE_ID.test(input.requestId) ||
      !SAFE_ID.test(input.correlationId) ||
      !input.query.trim() ||
      !Number.isSafeInteger(input.topK) ||
      input.topK < 1 ||
      input.topK > 100
    ) {
      throw new Error("Local RAG retrieval request is invalid.");
    }
    return Object.freeze({
      schema: "dzupagent.ragRetrievalRequest/v1",
      requestId: input.requestId,
      correlationId: input.correlationId,
      snapshot: this.snapshot,
      query: input.query,
      topK: input.topK,
      authority: {
        providerIds: Object.freeze(["local-lexical"]),
        dataScopes: Object.freeze([...input.dataScopes].sort()),
        maxCostCents: 0,
      },
      freshness: {},
      fallback: { mode: "none" as const },
    });
  }

  async execute(
    request: RagRetrievalRequest,
    policy: RagCompositionPolicy = {
      maxRetrievalAttempts: 1,
      minimumEvidenceItems: 1,
    },
  ): Promise<RagCompositionResult> {
    if (
      request.snapshot.snapshotId !== this.snapshot.snapshotId ||
      request.snapshot.digest !== this.snapshot.digest
    ) {
      throw new Error("Local RAG request snapshot does not match the host.");
    }
    return executeRagComposition(
      request,
      {
        retrieve: (candidate, context) =>
          this.retrieve(candidate, context),
        synthesize: (candidate, evidence) =>
          this.synthesize(candidate, evidence),
      },
      policy,
    );
  }

  async evaluate(
    cases: readonly LocalRagEvaluationCase[],
    thresholds: LocalRagEvaluationThresholds = DEFAULT_THRESHOLDS,
  ): Promise<LocalRagEvaluationReport> {
    validateThresholds(thresholds);
    if (cases.length === 0) {
      throw new Error("Local RAG evaluation requires at least one case.");
    }
    const seen = new Set<string>();
    const results: LocalRagEvaluationCaseResult[] = [];
    for (const item of cases) {
      validateCase(item);
      if (seen.has(item.caseId)) {
        throw new Error(`Duplicate local RAG case id "${item.caseId}".`);
      }
      if (
        item.relevantDocumentIds.some(
          (id) => !this.documentsById.has(id),
        )
      ) {
        throw new Error(
          `Local RAG case "${item.caseId}" references an unknown document.`,
        );
      }
      seen.add(item.caseId);
      const request = this.createRequest({
        requestId: `request:${item.caseId}`,
        correlationId: `correlation:${item.caseId}`,
        query: item.query,
        dataScopes: item.dataScopes,
        topK: item.topK ?? 3,
      });
      const startedAt = performance.now();
      const result = await this.execute(request, {
        maxRetrievalAttempts: 1,
        minimumEvidenceItems: item.minimumEvidenceItems ?? 1,
      });
      const observedDurationMs = round(performance.now() - startedAt);
      results.push(
        this.evaluateCase(item, result, observedDurationMs),
      );
    }
    const aggregate = {
      caseCount: results.length,
      meanRecallAtK: mean(results.map((item) => item.recallAtK)),
      meanPrecisionAtK: mean(
        results.map((item) => item.precisionAtK),
      ),
      statusAccuracy: mean(
        results.map((item) => Number(item.statusCorrect)),
      ),
      groundingCoverage: mean(
        results.map((item) => item.groundingCoverage),
      ),
      requiredTermCoverage: mean(
        results.map((item) => item.requiredTermCoverage),
      ),
      abstentionAccuracy: mean(
        results.map((item) => Number(item.abstentionCorrect)),
      ),
      deterministicOperationCount: results.reduce(
        (sum, item) => sum + item.deterministicOperationCount,
        0,
      ),
      observedDurationMs: round(
        results.reduce(
          (sum, item) => sum + item.observedDurationMs,
          0,
        ),
      ),
      providerCalls: 0 as const,
      estimatedCostCents: 0 as const,
    };
    const deterministicCases = results.map(
      ({ observedDurationMs: ignored, ...item }) => item,
    );
    const deterministicPayload = {
      schema: "dzupagent.localRagEvaluationReport/v1" as const,
      snapshot: this.snapshot,
      evaluatedAt: this.evaluatedAt,
      cases: deterministicCases,
      aggregate: {
        ...aggregate,
        observedDurationMs: 0,
      },
      thresholds,
    };
    return Object.freeze({
      ...deterministicPayload,
      cases: Object.freeze(results),
      aggregate: Object.freeze(aggregate),
      passed:
        aggregate.meanRecallAtK >= thresholds.minimumRecallAtK &&
        aggregate.meanPrecisionAtK >= thresholds.minimumPrecisionAtK &&
        aggregate.statusAccuracy >= thresholds.minimumStatusAccuracy &&
        aggregate.groundingCoverage >=
          thresholds.minimumGroundingCoverage &&
        aggregate.requiredTermCoverage >=
          thresholds.minimumRequiredTermCoverage &&
        aggregate.abstentionAccuracy >=
          thresholds.minimumAbstentionAccuracy,
      deterministicFingerprint: digest(deterministicPayload),
      boundaries: Object.freeze({
        providerCalls: 0 as const,
        networkAccess: false as const,
        indexMutationAuthorized: false as const,
        snapshotPromotionAuthorized: false as const,
        authorityEffect: "none" as const,
      }),
    });
  }

  private async retrieve(
    request: RagRetrievalRequest,
    context: RagRetrievalAttemptContext,
  ): Promise<RagEvidenceBundle> {
    const queryTerms = termFrequencies(request.query);
    const matches = this.documents
      .filter((entry) =>
        isSubset(entry.document.accessScopes, context.dataScopes),
      )
      .map((entry) => ({
        entry,
        score: lexicalScore(queryTerms, entry.terms),
      }))
      .filter((entry) => entry.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.entry.document.id.localeCompare(
            right.entry.document.id,
          ),
      )
      .slice(0, request.topK);
    if (matches.length === 0) {
      return {
        schema: "dzupagent.ragEvidenceBundle/v1",
        requestId: request.requestId,
        correlationId: request.correlationId,
        snapshot: {
          snapshotId: this.snapshot.snapshotId,
          digest: this.snapshot.digest,
        },
        status: "no-results",
        items: [],
        noResultReason:
          "No authorized local corpus document matched the normalized query.",
      };
    }
    return {
      schema: "dzupagent.ragEvidenceBundle/v1",
      requestId: request.requestId,
      correlationId: request.correlationId,
      snapshot: {
        snapshotId: this.snapshot.snapshotId,
        digest: this.snapshot.digest,
      },
      status: "results",
      items: matches.map(({ entry, score }) => ({
        evidenceId: `evidence:${entry.document.id}`,
        snapshot: {
          snapshotId: this.snapshot.snapshotId,
          digest: this.snapshot.digest,
        },
        source: {
          ref: entry.document.sourceRef,
          locator: entry.document.locator,
          ...(entry.document.version
            ? { version: entry.document.version }
            : {}),
        },
        accessScopes: entry.document.accessScopes,
        retrievedAt: this.evaluatedAt,
        score,
        content: {
          uri: `local-rag://${this.snapshot.snapshotId}/${entry.document.id}`,
          digest: digest(entry.document.text),
          digestOf: "sanitized",
          redactionStatus: "fixture_classified_and_sanitized",
          contentClass: entry.document.contentClass,
        },
      })),
    };
  }

  private async synthesize(
    request: RagRetrievalRequest,
    evidence: RagEvidenceBundle,
  ) {
    const selected = evidence.items.map((item) => {
      const documentId = item.evidenceId.startsWith("evidence:")
        ? item.evidenceId.slice("evidence:".length)
        : "";
      const document = this.documentsById.get(documentId)?.document;
      if (!document) {
        throw new Error(
          `Local RAG evidence "${item.evidenceId}" lost its document binding.`,
        );
      }
      return { item, document };
    });
    return {
      schema: "dzupagent.ragGroundedAnswer/v1" as const,
      requestId: request.requestId,
      correlationId: request.correlationId,
      answer: selected.map(({ document }) => document.text).join("\n\n"),
      claims: selected.map(({ item, document }, index) => ({
        claimId: `claim:${index + 1}`,
        text: document.text,
        evidenceIds: [item.evidenceId],
      })),
      evidenceBundleDigest: digestRagEvidenceBundle(evidence),
    };
  }

  private evaluateCase(
    item: LocalRagEvaluationCase,
    result: RagCompositionResult,
    observedDurationMs: number,
  ): LocalRagEvaluationCaseResult {
    const retrieved = (result.evidence?.items ?? []).map(
      (evidence) =>
        evidence.evidenceId.startsWith("evidence:")
          ? evidence.evidenceId.slice("evidence:".length)
          : "",
    );
    const relevant = new Set(item.relevantDocumentIds);
    const relevantRetrieved = retrieved.filter((id) => relevant.has(id));
    const claims = result.answer?.claims ?? [];
    const admittedEvidence = new Set(
      result.evidence?.items.map((entry) => entry.evidenceId) ?? [],
    );
    const groundedClaims = claims.filter(
      (claim) =>
        claim.evidenceIds.length > 0 &&
        claim.evidenceIds.every((id) => admittedEvidence.has(id)),
    );
    const requiredTerms = item.requiredAnswerTerms ?? [];
    const normalizedAnswer = result.answer?.answer.toLocaleLowerCase("en-US") ?? "";
    const matchedTerms = requiredTerms.filter((term) =>
      normalizedAnswer.includes(term.toLocaleLowerCase("en-US")),
    );
    const abstentionExpected = item.expectedStatus === "no-results";
    const abstentionObserved = result.status === "no-results";
    return Object.freeze({
      caseId: item.caseId,
      status: result.status,
      expectedStatus: item.expectedStatus,
      retrievedDocumentIds: Object.freeze(retrieved),
      recallAtK:
        relevant.size === 0
          ? Number(retrieved.length === 0)
          : round(relevantRetrieved.length / relevant.size),
      precisionAtK:
        retrieved.length === 0
          ? Number(relevant.size === 0)
          : round(relevantRetrieved.length / retrieved.length),
      statusCorrect: result.status === item.expectedStatus,
      groundingCoverage:
        claims.length === 0
          ? Number(result.status !== "answered")
          : round(groundedClaims.length / claims.length),
      requiredTermCoverage:
        requiredTerms.length === 0
          ? 1
          : round(matchedTerms.length / requiredTerms.length),
      abstentionExpected,
      abstentionObserved,
      abstentionCorrect:
        abstentionExpected === abstentionObserved,
      deterministicOperationCount:
        this.documents.length + retrieved.length + claims.length,
      observedDurationMs,
      result,
    });
  }
}
