import type {
  FlowReferenceDiagnostic,
  FlowReferenceDiagnosticCode,
  FlowReferenceParseResult,
  FlowReferencePolicy,
  FlowReferenceUseSite,
  ParsedFlowReference,
} from "./types.js";

export interface IdentifierToken {
  value: string;
  start: number;
  end: number;
}

export function createReferenceDiagnostic(
  code: FlowReferenceDiagnosticCode,
  policy: FlowReferencePolicy,
  useSite: FlowReferenceUseSite,
  message: string,
  start: number,
  end: number,
  sourcePath: string | undefined,
): FlowReferenceDiagnostic {
  return {
    code,
    severity: policy === "strict" ? "error" : "warning",
    message,
    start,
    end,
    useSite,
    ...(sourcePath !== undefined ? { sourcePath } : {}),
  };
}

export function referenceParseResult(
  reference: ParsedFlowReference | undefined,
  diagnostics: FlowReferenceDiagnostic[],
): FlowReferenceParseResult {
  return {
    ok: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    ...(reference !== undefined ? { reference } : {}),
    diagnostics,
  };
}

export function readIdentifier(
  source: string,
  start: number,
): IdentifierToken | undefined {
  const first = source.charCodeAt(start);
  if (!isIdentifierStart(first)) return undefined;
  let end = start + 1;
  while (end < source.length && isIdentifierPart(source.charCodeAt(end))) {
    end += 1;
  }
  return { value: source.slice(start, end), start, end };
}

export function isUnsignedInteger(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

export function isSignedInteger(value: string): boolean {
  const start = value[0] === "-" || value[0] === "+" ? 1 : 0;
  return start < value.length && isUnsignedInteger(value.slice(start));
}

export function skipWhitespace(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length && isWhitespace(source[cursor])) cursor += 1;
  return cursor;
}

export function isWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\n" || value === "\r" || value === "\t";
}

export function findNextUnquotedPipe(source: string, start: number): number {
  let quote: string | undefined;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== undefined) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "|") return index;
  }
  return source.length;
}

export function unwrapReferenceSource(
  source: string,
):
  | { ok: true; source: string; offset: number }
  | { ok: false; message: string; start: number; end: number } {
  const leading = source.length - source.trimStart().length;
  const trimmed = source.trim();
  const opens = trimmed.startsWith("{{");
  const closes = trimmed.endsWith("}}");
  if (opens !== closes) {
    return {
      ok: false,
      message: "reference template delimiters are unbalanced",
      start: leading,
      end: leading + trimmed.length,
    };
  }
  if (!opens) return { ok: true, source: trimmed, offset: leading };
  const inner = trimmed.slice(2, -2);
  if (inner.includes("{{") || inner.includes("}}")) {
    return {
      ok: false,
      message: "nested template delimiters are not supported",
      start: leading,
      end: leading + trimmed.length,
    };
  }
  return { ok: true, source: inner, offset: leading + 2 };
}

function isIdentifierStart(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || (code >= 48 && code <= 57);
}
