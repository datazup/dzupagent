/**
 * Source scanning for the legacy runtime condition subset — quote- and
 * paren-aware operator location plus token classification. Pure string
 * functions with no knowledge of state or templates.
 *
 * Internal to the condition-expression engine; consume the engine through
 * `../condition-expression.js`.
 */

export const COMPARISON_OPERATORS = [
  "===",
  "!==",
  ">=",
  "<=",
  "==",
  "!=",
  ">",
  "<",
] as const;

export function findTopLevelComparison(
  source: string,
): { left: string; operator: string; right: string } | null {
  for (const operator of COMPARISON_OPERATORS) {
    const index = findTopLevelOperator(source, operator);
    if (index !== -1) {
      return {
        left: source.slice(0, index),
        operator,
        right: source.slice(index + operator.length),
      };
    }
  }
  return null;
}

export function splitTopLevel(source: string, operator: "&&" | "||"): string[] {
  const parts: string[] = [];
  let cursor = 0;
  let index = 0;
  while (index < source.length) {
    const opIndex = findTopLevelOperator(source.slice(index), operator);
    if (opIndex === -1) break;
    const absolute = index + opIndex;
    parts.push(source.slice(cursor, absolute));
    cursor = absolute + operator.length;
    index = cursor;
  }
  if (parts.length === 0) return [source];
  parts.push(source.slice(cursor));
  return parts;
}

function findTopLevelOperator(source: string, operator: string): number {
  let quote: string | null = null;
  let depth = 0;
  for (let index = 0; index <= source.length - operator.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (
      depth === 0 &&
      source.slice(index, index + operator.length) === operator
    )
      return index;
  }
  return -1;
}

export function stripWrappingParens(source: string): string {
  let current = source;
  while (
    current.startsWith("(") &&
    current.endsWith(")") &&
    wrapsEntireExpression(current)
  ) {
    current = current.slice(1, -1).trim();
  }
  return current;
}

function wrapsEntireExpression(source: string): boolean {
  let quote: string | null = null;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth === 0 && index < source.length - 1) return false;
  }
  return depth === 0;
}

export function isPathExpression(value: string): boolean {
  const parts = value.trim().split(".");
  if (parts.length === 0) return false;
  return parts.every(isIdentifier);
}

function isIdentifier(value: string): boolean {
  if (value.length === 0) return false;
  const first = value.charCodeAt(0);
  if (!isIdentifierStart(first)) return false;
  for (let index = 1; index < value.length; index += 1) {
    if (!isIdentifierPart(value.charCodeAt(index))) return false;
  }
  return true;
}

function isIdentifierStart(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36
  );
}

function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || (code >= 48 && code <= 57);
}

export function isNumberLiteral(value: string): boolean {
  if (value.length === 0) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && String(parsed) === value;
}

export function isQuotedString(value: string): boolean {
  if (value.length < 2) return false;
  const first = value[0];
  const last = value[value.length - 1];
  return (first === "'" || first === '"') && first === last;
}

export function containsDisallowedConstruct(value: string): boolean {
  const compact = value
    .replaceAll(" ", "")
    .replaceAll("\n", "")
    .replaceAll("\t", "");
  return (
    compact.includes("eval(") ||
    compact.includes("Function(") ||
    compact.includes("import(")
  );
}
