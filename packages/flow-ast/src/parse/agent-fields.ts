/**
 * Agent-node optional primitive-field parser.
 *
 * Extracted from `parse/agent.ts` (MC-5 god-module split). Mirrors the
 * validator's `optionalString` for the simple string-valued optional fields
 * (`profile`, `toolset`, `model`, `provider`). Shape constraints are unchanged.
 */

import { type ParseContext, joinPointer } from "./shared.js";

export function copyOptionalString(
  obj: Record<string, unknown>,
  key: string,
  pointer: string,
  ctx: ParseContext,
  assign: (value: string) => void
): void {
  if (!(key in obj) || obj[key] === undefined) return;
  const v = obj[key];
  if (typeof v === "string") {
    assign(v);
    return;
  }
  ctx.errors.push({
    code: "WRONG_FIELD_TYPE",
    message: `agent.${key} must be a string when present`,
    pointer: joinPointer(pointer, key),
  });
}
