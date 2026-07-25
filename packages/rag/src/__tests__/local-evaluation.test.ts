import { describe, expect, it } from "vitest";

import {
  DeterministicLocalRagEvaluationHost,
  type LocalRagEvaluationDocument,
} from "../local-evaluation.js";

const DOCUMENTS: readonly LocalRagEvaluationDocument[] = [
  {
    id: "public-config",
    text: "The server timeout is configured in server.yaml.",
    sourceRef: "docs/server",
    locator: "docs/server.md:10",
    version: "v1",
    accessScopes: ["docs:public"],
    contentClass: "public-documentation",
  },
  {
    id: "internal-budget",
    text: "The internal campaign budget requires explicit cost admission.",
    sourceRef: "runbooks/budget",
    locator: "runbooks/budget.md:4",
    accessScopes: ["docs:internal"],
    contentClass: "internal-runbook",
  },
  {
    id: "public-restart",
    text: "Restart recovery verifies the exact checkpoint before continuation.",
    sourceRef: "docs/restart",
    locator: "docs/restart.md:7",
    accessScopes: ["docs:public"],
    contentClass: "public-documentation",
  },
];

function host() {
  return new DeterministicLocalRagEvaluationHost(DOCUMENTS, {
    snapshotId: "local-eval-v1",
    snapshotCreatedAt: "2026-07-25T00:00:00.000Z",
    evaluatedAt: "2026-07-25T12:00:00.000Z",
  });
}

describe("deterministic local RAG evaluation host", () => {
  it("retrieves lexical evidence within exact classified scopes", async () => {
    const runtime = host();
    const result = await runtime.execute(
      runtime.createRequest({
        requestId: "request:config",
        correlationId: "correlation:config",
        query: "server timeout configuration",
        dataScopes: ["docs:public"],
        topK: 2,
      }),
    );

    expect(result.status).toBe("answered");
    expect(result.evidence?.items.map((item) => item.evidenceId)).toEqual([
      "evidence:public-config",
    ]);
    expect(result.evidence?.items[0]?.source.ref).toBe("docs/server");
    expect(result.answer?.claims).toEqual([
      {
        claimId: "claim:1",
        text: DOCUMENTS[0]!.text,
        evidenceIds: ["evidence:public-config"],
      },
    ]);
    expect(result.boundaries).toEqual({
      bounded: true,
      providerSelectedByHost: true,
      dataAuthorityWidened: false,
      indexMutationAuthorized: false,
      snapshotPromotionAuthorized: false,
      authorityEffect: "none",
    });
  });

  it("truthfully abstains when matching evidence is outside authority", async () => {
    const runtime = host();
    const result = await runtime.execute(
      runtime.createRequest({
        requestId: "request:budget",
        correlationId: "correlation:budget",
        query: "internal campaign budget cost admission",
        dataScopes: ["docs:public"],
        topK: 3,
      }),
    );

    expect(result.status).toBe("no-results");
    expect(result.answer).toBeUndefined();
    expect(result.evidence?.items).toEqual([]);
  });

  it("produces deterministic retrieval, grounding, abstention, latency, and cost evaluation", async () => {
    const runtime = host();
    const cases = [
      {
        caseId: "config",
        query: "server timeout",
        dataScopes: ["docs:public"],
        relevantDocumentIds: ["public-config"],
        expectedStatus: "answered" as const,
        requiredAnswerTerms: ["server.yaml"],
      },
      {
        caseId: "restart",
        query: "restart checkpoint continuation",
        dataScopes: ["docs:public"],
        relevantDocumentIds: ["public-restart"],
        expectedStatus: "answered" as const,
        requiredAnswerTerms: ["checkpoint"],
      },
      {
        caseId: "abstain",
        query: "internal campaign budget",
        dataScopes: ["docs:public"],
        relevantDocumentIds: [],
        expectedStatus: "no-results" as const,
      },
    ];
    const first = await runtime.evaluate(cases);
    const second = await runtime.evaluate(cases);

    expect(first.passed).toBe(true);
    expect(first.aggregate).toMatchObject({
      caseCount: 3,
      meanRecallAtK: 1,
      meanPrecisionAtK: 1,
      statusAccuracy: 1,
      groundingCoverage: 1,
      requiredTermCoverage: 1,
      abstentionAccuracy: 1,
      providerCalls: 0,
      estimatedCostCents: 0,
    });
    expect(first.aggregate.observedDurationMs).toBeGreaterThanOrEqual(0);
    expect(first.deterministicFingerprint).toBe(
      second.deterministicFingerprint,
    );
    expect(first.boundaries).toEqual({
      providerCalls: 0,
      networkAccess: false,
      indexMutationAuthorized: false,
      snapshotPromotionAuthorized: false,
      authorityEffect: "none",
    });
  });

  it("reports insufficient evidence without synthesizing unsupported claims", async () => {
    const runtime = host();
    const report = await runtime.evaluate(
      [
        {
          caseId: "threshold",
          query: "server timeout",
          dataScopes: ["docs:public"],
          relevantDocumentIds: ["public-config"],
          expectedStatus: "insufficient-evidence",
          minimumEvidenceItems: 2,
        },
      ],
      {
        minimumRecallAtK: 1,
        minimumPrecisionAtK: 1,
        minimumStatusAccuracy: 1,
        minimumGroundingCoverage: 1,
        minimumRequiredTermCoverage: 1,
        minimumAbstentionAccuracy: 1,
      },
    );

    expect(report.passed).toBe(true);
    expect(report.cases[0]?.result.answer).toBeUndefined();
    expect(report.cases[0]?.groundingCoverage).toBe(1);
  });

  it("rejects duplicate corpus and case identities", async () => {
    expect(
      () =>
        new DeterministicLocalRagEvaluationHost(
          [DOCUMENTS[0]!, DOCUMENTS[0]!],
          {
            snapshotId: "duplicate",
            snapshotCreatedAt: "2026-07-25T00:00:00.000Z",
            evaluatedAt: "2026-07-25T12:00:00.000Z",
          },
        ),
    ).toThrow(/Duplicate local RAG document/u);

    await expect(
      host().evaluate([
        {
          caseId: "same",
          query: "server",
          dataScopes: ["docs:public"],
          relevantDocumentIds: ["public-config"],
          expectedStatus: "answered",
        },
        {
          caseId: "same",
          query: "restart",
          dataScopes: ["docs:public"],
          relevantDocumentIds: ["public-restart"],
          expectedStatus: "answered",
        },
      ]),
    ).rejects.toThrow(/Duplicate local RAG case/u);
  });
});
