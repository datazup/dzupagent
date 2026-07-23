import { parseFlowReferenceExpression } from "./parser.js";
import type { FlowReferenceValue } from "./types.js";

export function flowReference<T = unknown>(
  source: string,
): FlowReferenceValue<T> {
  const parsed = parseFlowReferenceExpression(source, { policy: "strict" });
  if (!parsed.ok || parsed.reference === undefined) {
    const reason = parsed.diagnostics[0]?.message ?? "invalid flow reference";
    throw new TypeError(reason);
  }
  return Object.freeze({
    kind: "flow-reference" as const,
    source: parsed.reference.source,
  });
}

export function isFlowReferenceValue(
  value: unknown,
): value is FlowReferenceValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.kind === "flow-reference" &&
    typeof record.source === "string" &&
    record.source.length > 0
  );
}
