import { createHash } from "node:crypto";

import type {
  LocalRagEvaluationCase,
  LocalRagEvaluationDocument,
  LocalRagEvaluationThresholds,
} from "./local-evaluation-types.js";

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function validateDocument(
  document: LocalRagEvaluationDocument,
): void {
  if (
    !SAFE_ID.test(document.id) ||
    !document.text.trim() ||
    !document.sourceRef.trim() ||
    !document.locator.trim() ||
    !document.contentClass.trim() ||
    document.accessScopes.length === 0 ||
    document.accessScopes.some((scope) => !scope.trim())
  ) {
    throw new Error("Local RAG evaluation document is invalid.");
  }
}

export function validateCase(item: LocalRagEvaluationCase): void {
  if (
    !SAFE_ID.test(item.caseId) ||
    !item.query.trim() ||
    item.dataScopes.length === 0 ||
    item.relevantDocumentIds.some((id) => !SAFE_ID.test(id)) ||
    (item.topK !== undefined &&
      (!Number.isSafeInteger(item.topK) ||
        item.topK < 1 ||
        item.topK > 100))
  ) {
    throw new Error("Local RAG evaluation case is invalid.");
  }
}

export function validateThresholds(
  thresholds: LocalRagEvaluationThresholds,
): void {
  if (
    Object.values(thresholds).some(
      (value) =>
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1,
    )
  ) {
    throw new Error("Local RAG evaluation thresholds must be within 0..1.");
  }
}

export function validateTimestamp(value: string, label: string): void {
  if (
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be a canonical RFC3339 timestamp.`);
  }
}

function tokenize(value: string): readonly string[] {
  return Object.freeze(
    value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [],
  );
}

export function termFrequencies(value: string): ReadonlyMap<string, number> {
  const frequencies = new Map<string, number>();
  for (const term of tokenize(value)) {
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  return frequencies;
}

export function lexicalScore(
  query: ReadonlyMap<string, number>,
  document: ReadonlyMap<string, number>,
): number {
  if (query.size === 0) return 0;
  let matches = 0;
  for (const [term, frequency] of query) {
    matches += Math.min(frequency, document.get(term) ?? 0);
  }
  const queryTerms = [...query.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  return round(matches / queryTerms);
}

export function isSubset(
  values: readonly string[],
  allowed: readonly string[],
): boolean {
  const allowedSet = new Set(allowed);
  return values.every((value) => allowedSet.has(value));
}

export function mean(values: readonly number[]): number {
  return round(
    values.reduce((sum, value) => sum + value, 0) / values.length,
  );
}

export function round(value: number): number {
  return Number(value.toFixed(8));
}

export function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex")}`;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]),
  );
}
