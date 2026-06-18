/**
 * Shared types, helpers, and constants used by every per-node-kind parser
 * in this directory.
 *
 * This module deliberately holds NO node-kind-specific logic — only the
 * primitives that all per-kind files consume.
 */

import type { FlowNode, FlowNodeBase } from "../types.js";
import { FLOW_NODE_KINDS } from "../types.js";

// ---------------------------------------------------------------------------
// Public parse-result surface
// ---------------------------------------------------------------------------

export type ParseInput = string | object;

export type ParseErrorCode =
  | "INVALID_JSON"
  | "NOT_AN_OBJECT"
  | "MISSING_TYPE"
  | "UNKNOWN_NODE_TYPE"
  | "WRONG_FIELD_TYPE"
  | "EXPECTED_ARRAY"
  | "EXPECTED_OBJECT";

export interface ParseError {
  code: ParseErrorCode;
  message: string;
  /** Line/column when input was a string; undefined when input was a pre-parsed object. */
  position?: { line: number; column: number };
  /** JSON pointer path (RFC 6901-style, "/nodes/0/body/2") — always populated. */
  pointer: string;
}

export interface ParseResult {
  /** Parsed AST. Present even when errors are non-empty IF the parser could recover; otherwise null. */
  ast: FlowNode | null;
  errors: ParseError[];
}

// ---------------------------------------------------------------------------
// Internal walker context
// ---------------------------------------------------------------------------

export interface ParseContext {
  errors: ParseError[];
  /** Line/column tracking is available only when the original input was a string. */
  hasPositions: boolean;
  parseNodeArray: ParseNodeArray;
}

export type ParseNodeArray = (
  items: unknown[],
  basePointer: string,
  ctx: ParseContext
) => FlowNode[];

export const KNOWN_NODE_TYPES = new Set<string>(FLOW_NODE_KINDS);

// ---------------------------------------------------------------------------
// Common-field parsing
// ---------------------------------------------------------------------------

export function parseCommonNodeFields(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): Pick<
  FlowNodeBase,
  "id" | "name" | "description" | "meta" | "resumePoint"
> {
  const fields: Pick<
    FlowNodeBase,
    "id" | "name" | "description" | "meta" | "resumePoint"
  > = {};

  parseOptionalStringField(obj, "id", pointer, ctx, (value) => {
    fields.id = value;
  });
  parseOptionalStringField(obj, "name", pointer, ctx, (value) => {
    fields.name = value;
  });
  parseOptionalStringField(obj, "description", pointer, ctx, (value) => {
    fields.description = value;
  });

  if ("meta" in obj) {
    const metaRaw = obj.meta;
    if (metaRaw !== undefined) {
      if (isPlainObject(metaRaw)) {
        fields.meta = metaRaw;
      } else {
        ctx.errors.push({
          code: "EXPECTED_OBJECT",
          message: `Field "meta" must be an object when present, received ${describeJsType(
            metaRaw
          )}`,
          pointer: joinPointer(pointer, "meta"),
        });
      }
    }
  }
  parseOptionalBooleanField(obj, "resumePoint", pointer, ctx, (value) => {
    fields.resumePoint = value;
  });

  return fields;
}

export function parseOptionalStringField(
  obj: Record<string, unknown>,
  key: "id" | "name" | "description",
  pointer: string,
  ctx: ParseContext,
  assign: (value: string) => void
): void {
  if (!(key in obj)) return;
  const raw = obj[key];
  if (raw === undefined) return;
  if (typeof raw === "string") {
    assign(raw);
    return;
  }
  ctx.errors.push({
    code: "WRONG_FIELD_TYPE",
    message: `Field "${key}" must be a string when present, received ${describeJsType(
      raw
    )}`,
    pointer: joinPointer(pointer, key),
  });
}

export function parseOptionalBooleanField(
  obj: Record<string, unknown>,
  key: "resumePoint",
  pointer: string,
  ctx: ParseContext,
  assign: (value: boolean) => void
): void {
  if (!(key in obj)) return;
  const raw = obj[key];
  if (raw === undefined) return;
  if (typeof raw === "boolean") {
    assign(raw);
    return;
  }
  ctx.errors.push({
    code: "WRONG_FIELD_TYPE",
    message: `Field "${key}" must be a boolean when present, received ${describeJsType(
      raw
    )}`,
    pointer: joinPointer(pointer, key),
  });
}

export function parseOptionalMemoryStringField(
  obj: Record<string, unknown>,
  key: "key" | "valueExpr" | "outputVar" | "query",
  pointer: string,
  ctx: ParseContext,
  assign: (value: string) => void
): void {
  if (!(key in obj)) return;
  const raw = obj[key];
  if (raw === undefined) return;
  if (typeof raw === "string") {
    assign(raw);
    return;
  }
  ctx.errors.push({
    code: "WRONG_FIELD_TYPE",
    message: `memory.${key} must be a string when present, received ${describeJsType(
      raw
    )}`,
    pointer: joinPointer(pointer, key),
  });
}

// ---------------------------------------------------------------------------
// Type-introspection helpers
// ---------------------------------------------------------------------------

export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function describeJsType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** RFC 6901-style pointer join: encode '~' and '/' in segments. */
export function joinPointer(base: string, segment: string): string {
  const encoded = segment.replace(/~/g, "~0").replace(/\//g, "~1");
  return `${base}/${encoded}`;
}

/**
 * Best-effort line/column extraction from a V8 / Node JSON.parse error.
 * Returns undefined on any parsing miss — never throws.
 */
export function extractJsonErrorPosition(
  message: string,
  source: string
): { line: number; column: number } | undefined {
  // V8 / Node ≥20: "Unexpected token X in JSON at position N" or "...at position N (line L column C)"
  const lineColMatch = /line (\d+) column (\d+)/.exec(message);
  if (lineColMatch && lineColMatch[1] && lineColMatch[2]) {
    const line = Number(lineColMatch[1]);
    const column = Number(lineColMatch[2]);
    if (Number.isFinite(line) && Number.isFinite(column))
      return { line, column };
  }
  const positionMatch = /position (\d+)/.exec(message);
  if (positionMatch && positionMatch[1]) {
    const offset = Number(positionMatch[1]);
    if (Number.isFinite(offset)) return offsetToLineColumn(source, offset);
  }
  return undefined;
}

export function offsetToLineColumn(
  source: string,
  offset: number
): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const limit = Math.min(offset, source.length);
  for (let i = 0; i < limit; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}
