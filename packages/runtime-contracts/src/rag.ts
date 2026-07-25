import { createHash } from "node:crypto";

import type { SanitizedEvidenceRef } from "./canonical-execution.js";

export interface RagCorpusSnapshotRef {
  readonly schema: "dzupagent.ragCorpusSnapshotRef/v1";
  readonly snapshotId: string;
  readonly digest: `sha256:${string}`;
  readonly createdAt: string;
  readonly sourceCount: number;
  readonly accessScopes: readonly string[];
}

export interface RagAuthorityEnvelope {
  readonly providerIds: readonly string[];
  readonly dataScopes: readonly string[];
  readonly maxCostCents: number;
}

export interface RagRetrievalRequest {
  readonly schema: "dzupagent.ragRetrievalRequest/v1";
  readonly requestId: string;
  readonly correlationId: string;
  readonly snapshot: RagCorpusSnapshotRef;
  readonly query: string;
  readonly topK: number;
  readonly authority: RagAuthorityEnvelope;
  readonly freshness: {
    readonly maximumAgeMs?: number;
    readonly requiredAfter?: string;
  };
  readonly fallback:
    | { readonly mode: "none" }
    | {
        readonly mode: "alternate-retriever";
        readonly providerId: string;
        readonly dataScopes: readonly string[];
        readonly maxCostCents: number;
      };
}

export interface RagEvidenceItem {
  readonly evidenceId: string;
  readonly snapshot: Pick<RagCorpusSnapshotRef, "snapshotId" | "digest">;
  readonly source: {
    readonly ref: string;
    readonly locator: string;
    readonly version?: string;
  };
  readonly accessScopes: readonly string[];
  readonly retrievedAt: string;
  readonly score?: number;
  readonly content: SanitizedEvidenceRef;
}

export interface RagEvidenceBundle {
  readonly schema: "dzupagent.ragEvidenceBundle/v1";
  readonly requestId: string;
  readonly correlationId: string;
  readonly snapshot: Pick<RagCorpusSnapshotRef, "snapshotId" | "digest">;
  readonly status: "results" | "no-results";
  readonly items: readonly RagEvidenceItem[];
  readonly noResultReason?: string;
}

export interface RagGroundedClaim {
  readonly claimId: string;
  readonly text: string;
  readonly evidenceIds: readonly string[];
}

export interface RagGroundedAnswer {
  readonly schema: "dzupagent.ragGroundedAnswer/v1";
  readonly requestId: string;
  readonly correlationId: string;
  readonly answer: string;
  readonly claims: readonly RagGroundedClaim[];
  readonly evidenceBundleDigest: `sha256:${string}`;
}

export type RagContractDiagnosticCode =
  | "RAG_REQUEST_ID_MISMATCH"
  | "RAG_CORRELATION_ID_MISMATCH"
  | "RAG_SNAPSHOT_MISMATCH"
  | "RAG_REQUEST_SCOPE_WIDENED"
  | "RAG_DUPLICATE_EVIDENCE_ID"
  | "RAG_EVIDENCE_SCOPE_WIDENED"
  | "RAG_EVIDENCE_CONTENT_UNSANITIZED"
  | "RAG_RESULTS_EMPTY"
  | "RAG_NO_RESULTS_HAS_ITEMS"
  | "RAG_NO_RESULTS_REASON_MISSING"
  | "RAG_FALLBACK_PROVIDER_WIDENED"
  | "RAG_FALLBACK_SCOPE_WIDENED"
  | "RAG_FALLBACK_COST_WIDENED"
  | "RAG_DUPLICATE_CLAIM_ID"
  | "RAG_CLAIM_EVIDENCE_MISSING"
  | "RAG_CLAIM_EVIDENCE_EMPTY"
  | "RAG_EVIDENCE_BUNDLE_DIGEST_MISMATCH";

export interface RagContractDiagnostic {
  readonly code: RagContractDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface RagContractValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly RagContractDiagnostic[];
}

export function digestRagEvidenceBundle(
  bundle: RagEvidenceBundle,
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stableJson(bundle)))
    .digest("hex")}`;
}

export function validateRagEvidenceBundle(
  request: RagRetrievalRequest,
  bundle: RagEvidenceBundle,
): RagContractValidation {
  const diagnostics: RagContractDiagnostic[] = [];
  compareIdentity(
    request.requestId,
    bundle.requestId,
    "RAG_REQUEST_ID_MISMATCH",
    "requestId",
    diagnostics,
  );
  compareIdentity(
    request.correlationId,
    bundle.correlationId,
    "RAG_CORRELATION_ID_MISMATCH",
    "correlationId",
    diagnostics,
  );
  if (
    bundle.snapshot.snapshotId !== request.snapshot.snapshotId ||
    bundle.snapshot.digest !== request.snapshot.digest
  ) {
    diagnostics.push({
      code: "RAG_SNAPSHOT_MISMATCH",
      path: "snapshot",
      message: "RAG evidence must remain bound to the requested corpus snapshot.",
    });
  }
  if (!isSubset(request.authority.dataScopes, request.snapshot.accessScopes)) {
    diagnostics.push({
      code: "RAG_REQUEST_SCOPE_WIDENED",
      path: "authority.dataScopes",
      message: "RAG request data scopes exceed corpus snapshot access scopes.",
    });
  }

  validateFallback(request, diagnostics);
  const evidenceIds = new Set<string>();
  for (const [index, item] of bundle.items.entries()) {
    const path = `items[${index}]`;
    if (evidenceIds.has(item.evidenceId)) {
      diagnostics.push({
        code: "RAG_DUPLICATE_EVIDENCE_ID",
        path: `${path}.evidenceId`,
        message: `Duplicate RAG evidence id "${item.evidenceId}".`,
      });
    }
    evidenceIds.add(item.evidenceId);
    if (
      item.snapshot.snapshotId !== request.snapshot.snapshotId ||
      item.snapshot.digest !== request.snapshot.digest
    ) {
      diagnostics.push({
        code: "RAG_SNAPSHOT_MISMATCH",
        path: `${path}.snapshot`,
        message: "RAG evidence item is bound to a different corpus snapshot.",
      });
    }
    if (!isSubset(item.accessScopes, request.authority.dataScopes)) {
      diagnostics.push({
        code: "RAG_EVIDENCE_SCOPE_WIDENED",
        path: `${path}.accessScopes`,
        message: "RAG evidence access scopes exceed request authority.",
      });
    }
    if (
      item.content.digestOf !== "sanitized" ||
      item.content.redactionStatus.trim().length === 0
    ) {
      diagnostics.push({
        code: "RAG_EVIDENCE_CONTENT_UNSANITIZED",
        path: `${path}.content`,
        message: "RAG evidence content must identify sanitized evidence.",
      });
    }
  }

  if (bundle.status === "results" && bundle.items.length === 0) {
    diagnostics.push({
      code: "RAG_RESULTS_EMPTY",
      path: "items",
      message: "A results bundle must contain at least one evidence item.",
    });
  }
  if (bundle.status === "no-results") {
    if (bundle.items.length > 0) {
      diagnostics.push({
        code: "RAG_NO_RESULTS_HAS_ITEMS",
        path: "items",
        message: "A no-results bundle cannot contain evidence items.",
      });
    }
    if (!bundle.noResultReason?.trim()) {
      diagnostics.push({
        code: "RAG_NO_RESULTS_REASON_MISSING",
        path: "noResultReason",
        message: "A no-results bundle requires an explicit reason.",
      });
    }
  }

  return validation(diagnostics);
}

export function validateRagGroundedAnswer(
  request: RagRetrievalRequest,
  bundle: RagEvidenceBundle,
  answer: RagGroundedAnswer,
): RagContractValidation {
  const diagnostics = [
    ...validateRagEvidenceBundle(request, bundle).diagnostics,
  ];
  compareIdentity(
    request.requestId,
    answer.requestId,
    "RAG_REQUEST_ID_MISMATCH",
    "answer.requestId",
    diagnostics,
  );
  if (answer.evidenceBundleDigest !== digestRagEvidenceBundle(bundle)) {
    diagnostics.push({
      code: "RAG_EVIDENCE_BUNDLE_DIGEST_MISMATCH",
      path: "answer.evidenceBundleDigest",
      message: "Grounded answer is not bound to the supplied evidence bundle.",
    });
  }
  compareIdentity(
    request.correlationId,
    answer.correlationId,
    "RAG_CORRELATION_ID_MISMATCH",
    "answer.correlationId",
    diagnostics,
  );
  const evidenceIds = new Set(bundle.items.map((item) => item.evidenceId));
  const claimIds = new Set<string>();
  for (const [index, claim] of answer.claims.entries()) {
    const path = `claims[${index}]`;
    if (claimIds.has(claim.claimId)) {
      diagnostics.push({
        code: "RAG_DUPLICATE_CLAIM_ID",
        path: `${path}.claimId`,
        message: `Duplicate grounded claim id "${claim.claimId}".`,
      });
    }
    claimIds.add(claim.claimId);
    if (claim.evidenceIds.length === 0) {
      diagnostics.push({
        code: "RAG_CLAIM_EVIDENCE_EMPTY",
        path: `${path}.evidenceIds`,
        message: "Every grounded claim must cite at least one evidence item.",
      });
    }
    for (const evidenceId of claim.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        diagnostics.push({
          code: "RAG_CLAIM_EVIDENCE_MISSING",
          path: `${path}.evidenceIds`,
          message: `Grounded claim cites unknown evidence "${evidenceId}".`,
        });
      }
    }
  }
  return validation(diagnostics);
}

function validateFallback(
  request: RagRetrievalRequest,
  diagnostics: RagContractDiagnostic[],
): void {
  if (request.fallback.mode === "none") return;
  if (!request.authority.providerIds.includes(request.fallback.providerId)) {
    diagnostics.push({
      code: "RAG_FALLBACK_PROVIDER_WIDENED",
      path: "fallback.providerId",
      message: "RAG fallback provider exceeds request authority.",
    });
  }
  if (!isSubset(request.fallback.dataScopes, request.authority.dataScopes)) {
    diagnostics.push({
      code: "RAG_FALLBACK_SCOPE_WIDENED",
      path: "fallback.dataScopes",
      message: "RAG fallback data scopes exceed request authority.",
    });
  }
  if (request.fallback.maxCostCents > request.authority.maxCostCents) {
    diagnostics.push({
      code: "RAG_FALLBACK_COST_WIDENED",
      path: "fallback.maxCostCents",
      message: "RAG fallback cost exceeds request authority.",
    });
  }
}

function compareIdentity(
  expected: string,
  actual: string,
  code: RagContractDiagnosticCode,
  path: string,
  diagnostics: RagContractDiagnostic[],
): void {
  if (expected === actual) return;
  diagnostics.push({
    code,
    path,
    message: `${path} does not match the RAG retrieval request.`,
  });
}

function isSubset(values: readonly string[], allowed: readonly string[]): boolean {
  const admitted = new Set(allowed);
  return values.every((value) => admitted.has(value));
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableJson(item)]),
  );
}

function validation(
  diagnostics: RagContractDiagnostic[],
): RagContractValidation {
  return {
    valid: diagnostics.length === 0,
    diagnostics,
  };
}
