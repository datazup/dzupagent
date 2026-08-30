/**
 * Leaf validation primitives for the `ai-execution` contracts.
 *
 * Shape checks and small coercions with no knowledge of any particular
 * contract: record/string/number/enum readers, token summing, canonical JSON
 * comparison, and the message/artifact shape checks the operation validators
 * share. Nothing here imports a validator, so the contract validators in
 * `ai-execution.ts` can depend on it freely.
 *
 * @module ai-execution-validation-primitives
 */

import type { ExecutionArtifactRef } from "./canonical-execution.js";
import type { AiChatMessage } from "./ai-execution-types.js";
import type {
  AiExecutionDiagnostic,
  AiExecutionDiagnosticCode,
  AiExecutionValidation,
  AiTokenUsage,
} from "./ai-execution-receipt-types.js";

export const SUMMED_TOKEN_FIELDS = {
  input: true,
  output: true,
  cachedInput: true,
  cacheWrite: true,
  reasoning: true,
} satisfies Record<keyof AiTokenUsage, true>;

export const SUMMED_TOKEN_KEYS = Object.keys(SUMMED_TOKEN_FIELDS) as ReadonlyArray<
  keyof AiTokenUsage
>;

export function sumTokens(values: readonly unknown[]): Record<string, number> {
  const total: Record<string, number> = { input: 0, output: 0 };
  for (const value of values) {
    if (!isRecord(value)) continue;
    for (const key of SUMMED_TOKEN_KEYS) {
      const amount = numberValue(value[key]);
      if (amount !== undefined) total[key] = (total[key] ?? 0) + amount;
    }
  }
  return total;
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function validateMessages(
  messages: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!Array.isArray(messages) || messages.length === 0) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      path,
      "At least one chat message is required."
    );
    return;
  }
  messages.forEach((message, index) => {
    const item = isRecord(message) ? message : {};
    enumValue(
      stringValue(item.role),
      ["system", "user", "assistant", "tool"] as const,
      `${path}[${index}].role`,
      diagnostics
    );
    nonEmpty(
      stringValue(item.content),
      `${path}[${index}].content`,
      diagnostics
    );
  });
}

export function validateArtifact(
  artifact: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  const value = isRecord(artifact) ? artifact : {};
  nonEmpty(stringValue(value.uri), `${path}.uri`, diagnostics);
  nonEmpty(stringValue(value.digest), `${path}.digest`, diagnostics);
  nonEmpty(
    stringValue(value.contentClass),
    `${path}.contentClass`,
    diagnostics
  );
}

export function uniqueEnumValues<T extends string>(
  values: unknown,
  allowed: readonly T[],
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!Array.isArray(values)) {
    add(diagnostics, "AI_INVALID_VALUE", path, "Value must be an array.");
    return;
  }
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const string = stringValue(value);
    enumValue(string, allowed, `${path}[${index}]`, diagnostics);
    if (string !== undefined && seen.has(string)) {
      add(
        diagnostics,
        "AI_DUPLICATE_VALUE",
        `${path}[${index}]`,
        `Duplicate value ${string}.`
      );
    }
    if (string !== undefined) seen.add(string);
  });
}

export function uniqueStrings(
  values: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!Array.isArray(values)) {
    add(diagnostics, "AI_INVALID_VALUE", path, "Value must be an array.");
    return;
  }
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const string = stringValue(value);
    nonEmpty(string, `${path}[${index}]`, diagnostics);
    if (string !== undefined && seen.has(string)) {
      add(
        diagnostics,
        "AI_DUPLICATE_VALUE",
        `${path}[${index}]`,
        `Duplicate value ${string}.`
      );
    }
    if (string !== undefined) seen.add(string);
  });
}

export function nonEmptyStrings(
  values: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!Array.isArray(values) || values.length === 0) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      path,
      "At least one value is required."
    );
    return;
  }
  values.forEach((value, index) =>
    nonEmpty(stringValue(value), `${path}[${index}]`, diagnostics)
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function enumValue<T extends string>(
  value: T | undefined,
  allowed: readonly T[],
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!allowed.includes(value as T)) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      path,
      `Value must be one of: ${allowed.join(", ")}.`
    );
  }
}

export function nonEmpty(
  value: string | undefined,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      path,
      "Value must be a non-empty string."
    );
  }
}

export function positiveInteger(
  value: number | undefined,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      path,
      "Value must be a positive safe integer."
    );
  }
}

export function validateOptionalTime(
  value: string | undefined,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (value !== undefined && !isIsoDate(value)) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      path,
      "Value must be an ISO-8601 timestamp."
    );
  }
}

export function isIsoDate(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function validation(
  diagnostics: AiExecutionDiagnostic[]
): AiExecutionValidation {
  return { valid: diagnostics.length === 0, diagnostics };
}

export function add(
  diagnostics: AiExecutionDiagnostic[],
  code: AiExecutionDiagnosticCode,
  path: string,
  message: string
): void {
  diagnostics.push({ code, path, message });
}
