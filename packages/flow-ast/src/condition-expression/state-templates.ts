/**
 * State-path resolution and `{{ … }}` template rendering for the legacy
 * runtime condition subset.
 *
 * Internal to the condition-expression engine; consume the engine through
 * `../condition-expression.js`.
 */

export function resolveFlowStatePath(
  path: string,
  state: Record<string, unknown>,
): unknown {
  const normalized = normalizePath(path);
  if (normalized.length === 0) return undefined;
  let value: unknown = state;
  for (const part of normalized) {
    if (value === null || value === undefined || typeof value !== "object")
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function normalizePath(path: string): string[] {
  const parts = path
    .trim()
    .split(".")
    .filter((part) => part.length > 0);
  const first = parts[0];
  if (first === "state" || first === "ctx") return parts.slice(1);
  return parts;
}

export function getWholeTemplatePath(expr: string): string | null {
  const trimmed = expr.trim();
  if (!trimmed.startsWith("{{") || !trimmed.endsWith("}}")) return null;
  const inner = trimmed.slice(2, -2).trim();
  if (inner.length === 0) return null;
  if (inner.includes("{{") || inner.includes("}}")) return null;
  return inner;
}

export function renderTemplateText(
  expr: string,
  state: Record<string, unknown>,
): string {
  let output = "";
  let cursor = 0;
  while (cursor < expr.length) {
    const open = expr.indexOf("{{", cursor);
    if (open === -1) {
      output += expr.slice(cursor);
      break;
    }
    const close = expr.indexOf("}}", open + 2);
    if (close === -1) {
      output += expr.slice(cursor);
      break;
    }
    output += expr.slice(cursor, open);
    const path = expr.slice(open + 2, close).trim();
    const value = resolveFlowStatePath(path, state);
    output += value == null ? "" : String(value);
    cursor = close + 2;
  }
  return output;
}
