import { describe, expect, it } from "vitest";

import {
  digestRagEvidenceBundle,
  executeRagComposition,
  validateRagEvidenceBundle,
  validateRagGroundedAnswer,
  type RagEvidenceBundle,
  type RagGroundedAnswer,
  type RagRetrievalRequest,
} from "../rag.js";

const DIGEST = `sha256:${"a".repeat(64)}` as const;

function request(
  overrides: Partial<RagRetrievalRequest> = {},
): RagRetrievalRequest {
  return {
    schema: "dzupagent.ragRetrievalRequest/v1",
    requestId: "request-1",
    correlationId: "correlation-1",
    snapshot: {
      schema: "dzupagent.ragCorpusSnapshotRef/v1",
      snapshotId: "snapshot-1",
      digest: DIGEST,
      createdAt: "2026-07-25T00:00:00.000Z",
      sourceCount: 1,
      accessScopes: ["tenant:t1", "project:p1"],
    },
    query: "What is implemented?",
    topK: 5,
    authority: {
      providerIds: ["local-retriever", "approved-fallback"],
      dataScopes: ["tenant:t1", "project:p1"],
      maxCostCents: 20,
    },
    freshness: { maximumAgeMs: 60_000 },
    fallback: {
      mode: "alternate-retriever",
      providerId: "approved-fallback",
      dataScopes: ["tenant:t1"],
      maxCostCents: 10,
    },
    ...overrides,
  };
}

function bundle(
  overrides: Partial<RagEvidenceBundle> = {},
): RagEvidenceBundle {
  return {
    schema: "dzupagent.ragEvidenceBundle/v1",
    requestId: "request-1",
    correlationId: "correlation-1",
    snapshot: { snapshotId: "snapshot-1", digest: DIGEST },
    status: "results",
    items: [
      {
        evidenceId: "evidence-1",
        snapshot: { snapshotId: "snapshot-1", digest: DIGEST },
        source: {
          ref: "repo://dzupagent/runtime-contracts",
          locator: "src/rag.ts:1",
        },
        accessScopes: ["tenant:t1", "project:p1"],
        retrievedAt: "2026-07-25T00:00:01.000Z",
        score: 0.95,
        content: {
          uri: "evidence://sanitized/1",
          digest: DIGEST,
          digestOf: "sanitized",
          redactionStatus: "passed",
          contentClass: "internal",
        },
      },
    ],
    ...overrides,
  };
}

function answer(
  overrides: Partial<RagGroundedAnswer> = {},
): RagGroundedAnswer {
  return {
    schema: "dzupagent.ragGroundedAnswer/v1",
    requestId: "request-1",
    correlationId: "correlation-1",
    answer: "The typed contract is implemented.",
    claims: [
      {
        claimId: "claim-1",
        text: "The typed contract is implemented.",
        evidenceIds: ["evidence-1"],
      },
    ],
    evidenceBundleDigest: digestRagEvidenceBundle(bundle()),
    ...overrides,
  };
}

describe("RAG runtime contracts", () => {
  it("admits snapshot-bound sanitized evidence and resolvable claims", () => {
    expect(validateRagEvidenceBundle(request(), bundle())).toEqual({
      valid: true,
      diagnostics: [],
    });
    expect(
      validateRagGroundedAnswer(request(), bundle(), answer()),
    ).toEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it("rejects fallback provider, scope, and cost widening", () => {
    const result = validateRagEvidenceBundle(
      request({
        fallback: {
          mode: "alternate-retriever",
          providerId: "unapproved-provider",
          dataScopes: ["tenant:other"],
          maxCostCents: 21,
        },
      }),
      bundle(),
    );
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "RAG_FALLBACK_PROVIDER_WIDENED",
        "RAG_FALLBACK_SCOPE_WIDENED",
        "RAG_FALLBACK_COST_WIDENED",
      ]),
    );
  });

  it("rejects request authority beyond the pinned snapshot", () => {
    const result = validateRagEvidenceBundle(
      request({
        authority: {
          providerIds: ["local-retriever"],
          dataScopes: ["tenant:t1", "project:other"],
          maxCostCents: 20,
        },
        fallback: { mode: "none" },
      }),
      bundle(),
    );
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "RAG_REQUEST_SCOPE_WIDENED",
    );
  });

  it("rejects snapshot drift, scope widening, and duplicate evidence", () => {
    const first = bundle().items[0]!;
    const result = validateRagEvidenceBundle(
      request(),
      bundle({
        snapshot: {
          snapshotId: "different",
          digest: `sha256:${"b".repeat(64)}`,
        },
        items: [
          first,
          {
            ...first,
            snapshot: {
              snapshotId: "different",
              digest: `sha256:${"b".repeat(64)}`,
            },
            accessScopes: ["tenant:other"],
          },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "RAG_SNAPSHOT_MISMATCH",
        "RAG_DUPLICATE_EVIDENCE_ID",
        "RAG_EVIDENCE_SCOPE_WIDENED",
      ]),
    );
  });

  it("requires truthful no-result bundles", () => {
    expect(
      validateRagEvidenceBundle(
        request(),
        bundle({ status: "no-results", items: [] }),
      ).diagnostics.map((item) => item.code),
    ).toContain("RAG_NO_RESULTS_REASON_MISSING");
    expect(
      validateRagEvidenceBundle(
        request(),
        bundle({
          status: "no-results",
          noResultReason: "No accessible sources matched.",
        }),
      ).diagnostics.map((item) => item.code),
    ).toContain("RAG_NO_RESULTS_HAS_ITEMS");
  });

  it("rejects claims without exact retained evidence", () => {
    const result = validateRagGroundedAnswer(
      request(),
      bundle(),
      answer({
        claims: [
          {
            claimId: "claim-1",
            text: "Unsupported claim.",
            evidenceIds: ["missing"],
          },
          {
            claimId: "claim-1",
            text: "Uncited claim.",
            evidenceIds: [],
          },
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "RAG_CLAIM_EVIDENCE_MISSING",
        "RAG_DUPLICATE_CLAIM_ID",
        "RAG_CLAIM_EVIDENCE_EMPTY",
      ]),
    );
  });

  it("binds a grounded answer to the exact evidence bundle", () => {
    const changedBundle = bundle({
      items: [
        {
          ...bundle().items[0]!,
          source: {
            ref: "repo://dzupagent/runtime-contracts",
            locator: "src/rag.ts:2",
          },
        },
      ],
    });
    const result = validateRagGroundedAnswer(
      request(),
      changedBundle,
      answer(),
    );
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "RAG_EVIDENCE_BUNDLE_DIGEST_MISMATCH",
    );
  });

  it("executes a bounded provider-neutral fake-corpus composition", async () => {
    const calls: string[] = [];
    const result = await executeRagComposition(
      request(),
      {
        retrieve: async (_request, context) => {
          calls.push(`retrieve:${context.route}`);
          return bundle();
        },
        synthesize: async (_request, evidence) => {
          calls.push("synthesize");
          return answer({
            evidenceBundleDigest: digestRagEvidenceBundle(evidence),
          });
        },
      },
      { maxRetrievalAttempts: 2, minimumEvidenceItems: 1 },
    );
    expect(calls).toEqual(["retrieve:primary", "synthesize"]);
    expect(result.status).toBe("answered");
    expect(result.attempts).toHaveLength(1);
    expect(result.boundaries).toEqual({
      bounded: true,
      providerSelectedByHost: true,
      dataAuthorityWidened: false,
      indexMutationAuthorized: false,
      snapshotPromotionAuthorized: false,
      authorityEffect: "none",
    });
  });

  it("uses one declared fallback after truthful no-results", async () => {
    const calls: string[] = [];
    const result = await executeRagComposition(
      request(),
      {
        retrieve: async (_request, context) => {
          calls.push(context.route);
          if (context.route === "primary") {
            return bundle({
              status: "no-results",
              items: [],
              noResultReason: "Primary index has no accessible match.",
            });
          }
          return bundle();
        },
        synthesize: async (_request, evidence) =>
          answer({
            evidenceBundleDigest: digestRagEvidenceBundle(evidence),
          }),
      },
      { maxRetrievalAttempts: 2, minimumEvidenceItems: 1 },
    );
    expect(calls).toEqual(["primary", "declared-fallback"]);
    expect(result.status).toBe("answered");
    expect(result.attempts).toHaveLength(2);
  });

  it("abstains after bounded no-results without synthesizing", async () => {
    let synthesized = false;
    const result = await executeRagComposition(
      request({ fallback: { mode: "none" } }),
      {
        retrieve: async () =>
          bundle({
            status: "no-results",
            items: [],
            noResultReason: "No authorized source matched.",
          }),
        synthesize: async () => {
          synthesized = true;
          return answer();
        },
      },
      { maxRetrievalAttempts: 2, minimumEvidenceItems: 1 },
    );
    expect(result.status).toBe("no-results");
    expect(result.attempts).toHaveLength(1);
    expect(synthesized).toBe(false);
  });

  it("fails closed on invalid evidence and unsupported claims", async () => {
    const invalidEvidence = await executeRagComposition(
      request(),
      {
        retrieve: async () =>
          bundle({
            items: [
              {
                ...bundle().items[0]!,
                accessScopes: ["tenant:other"],
              },
            ],
          }),
        synthesize: async () => answer(),
      },
    );
    expect(invalidEvidence.status).toBe("invalid-evidence");
    expect(
      invalidEvidence.diagnostics.map((item) => item.code),
    ).toContain("RAG_EVIDENCE_SCOPE_WIDENED");

    const invalidAnswer = await executeRagComposition(
      request(),
      {
        retrieve: async () => bundle(),
        synthesize: async (_request, evidence) =>
          answer({
            claims: [
              {
                claimId: "unsupported",
                text: "Unsupported.",
                evidenceIds: ["missing"],
              },
            ],
            evidenceBundleDigest: digestRagEvidenceBundle(evidence),
          }),
      },
    );
    expect(invalidAnswer.status).toBe("invalid-answer");
    expect(
      invalidAnswer.diagnostics.map((item) => item.code),
    ).toContain("RAG_CLAIM_EVIDENCE_MISSING");
  });

  it("enforces evidence thresholds without widening retrieval", async () => {
    let synthesized = false;
    const result = await executeRagComposition(
      request(),
      {
        retrieve: async () => bundle(),
        synthesize: async () => {
          synthesized = true;
          return answer();
        },
      },
      { maxRetrievalAttempts: 1, minimumEvidenceItems: 2 },
    );
    expect(result.status).toBe("insufficient-evidence");
    expect(synthesized).toBe(false);
    expect(result.attempts).toHaveLength(1);
  });
});
