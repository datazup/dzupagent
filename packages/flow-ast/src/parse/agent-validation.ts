/**
 * Agent-node validation-block parsers.
 *
 * Extracted from `parse/agent.ts` (MC-5 god-module split). Covers the
 * `agent.validation` block and the shared `commands` array shape, reused by
 * both the agent node's `validation.required` and the standalone `validate`
 * node's `commands`. Mirrors `../validate/agent-validation.ts`; shape
 * constraints are unchanged.
 */

import type { AgentValidation, AgentValidationCommand } from "../types.js";
import { type ParseContext, isPlainObject, joinPointer } from "./shared.js";
import { isNonNegativeNumber } from "../policy-numbers.js";

export function parseValidation(
  raw: unknown,
  pointer: string,
  ctx: ParseContext
): AgentValidation | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    ctx.errors.push({
      code: "EXPECTED_OBJECT",
      message: "agent.validation must be an object",
      pointer,
    });
    return undefined;
  }
  const required = parseCommands(
    raw.required,
    joinPointer(pointer, "required"),
    ctx,
    true
  );
  if (required === undefined) return undefined;
  const out: AgentValidation = { required };
  if (raw.repair !== undefined) {
    if (!isPlainObject(raw.repair)) {
      ctx.errors.push({
        code: "EXPECTED_OBJECT",
        message: "agent.validation.repair must be an object",
        pointer: joinPointer(pointer, "repair"),
      });
    } else {
      const max = raw.repair.maxAttempts;
      if (!isNonNegativeNumber(max)) {
        ctx.errors.push({
          code: "WRONG_FIELD_TYPE",
          message:
            "agent.validation.repair.maxAttempts is required (non-negative number)",
          pointer: joinPointer(pointer, "repair/maxAttempts"),
        });
      } else {
        out.repair = { maxAttempts: max };
      }
    }
  }
  return out;
}

export function parseCommands(
  raw: unknown,
  pointer: string,
  ctx: ParseContext,
  required: boolean
): AgentValidationCommand[] | undefined {
  if (raw === undefined) {
    if (required) {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: `${pointer} is required (array of {command} objects)`,
        pointer,
      });
    }
    return undefined;
  }
  if (!Array.isArray(raw)) {
    ctx.errors.push({
      code: "EXPECTED_ARRAY",
      message: `${pointer} must be an array`,
      pointer,
    });
    return undefined;
  }
  if (required && raw.length === 0) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `${pointer} must contain at least one entry`,
      pointer,
    });
    return undefined;
  }
  const out: AgentValidationCommand[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const itemPointer = `${pointer}/${i}`;
    if (!isPlainObject(item)) {
      ctx.errors.push({
        code: "EXPECTED_OBJECT",
        message: `${itemPointer} must be an object`,
        pointer: itemPointer,
      });
      continue;
    }
    const command = item.command;
    if (typeof command !== "string" || command.length === 0) {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: `${itemPointer}/command is required (non-empty string)`,
        pointer: joinPointer(itemPointer, "command"),
      });
      continue;
    }
    const entry: AgentValidationCommand = { command };
    if (typeof item.id === "string" && item.id.length > 0) entry.id = item.id;
    out.push(entry);
  }
  return out;
}
