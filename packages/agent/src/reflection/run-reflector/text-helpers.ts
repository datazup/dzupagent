/**
 * Pure text/value helpers used by {@link RunReflector} heuristics.
 */

/** Stringify an unknown value into a string for length measurement. */
export function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Clamp a number between 0 and 1. */
export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Check if a string looks like valid JSON. */
export function isJsonParseable(s: string): boolean {
  const trimmed = s.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Detect common truncation markers in output text. */
export function hasTruncationMarkers(s: string): boolean {
  const lower = s.toLowerCase();
  const tail = lower.slice(-100);
  return (
    (tail.includes("...") && tail.endsWith("...")) ||
    tail.includes("[truncated]") ||
    tail.includes("[cut off]") ||
    tail.includes("<!-- truncated")
  );
}
