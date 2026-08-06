/**
 * Agent-node validation-block parsers.
 *
 * Extracted from `parse/agent.ts` (MC-5 god-module split). Covers the
 * `agent.validation` block and the shared `commands` array shape, reused by
 * both the agent node's `validation.required` and the standalone `validate`
 * node's `commands`. Mirrors `../validate/agent-validation.ts`; shape
 * constraints are unchanged.
 */

import type {
  AgentValidation,
  AgentValidationCommand,
  ValidationBlock,
} from "../types.js";
import { type ParseContext, isPlainObject, joinPointer } from "./shared.js";
import { isNonNegativeNumber } from "../policy-numbers.js";

const VALIDATION_FAIL_BEHAVIORS = ["retry", "abort", "continue"] as const;

/**
 * Parses the optional `agent.validate` inline JSON-Schema validation block
 * (Stage 2). Mirrors `../validate/agent-validation.ts`'s
 * `validateValidationBlock`; shape constraints must stay isomorphic
 * (`schema` required object, `errorMessage` optional string, `failBehavior`
 * optional enum, `maxRetries` optional non-negative number).
 */
export function parseValidationBlock(
  raw: unknown,
  pointer: string,
  ctx: ParseContext
): ValidationBlock | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    ctx.errors.push({
      code: "EXPECTED_OBJECT",
      message: "agent.validate must be an object when present",
      pointer,
    });
    return undefined;
  }
  if (!isPlainObject(raw.schema)) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: "agent.validate.schema is required (object)",
      pointer: joinPointer(pointer, "schema"),
    });
    return undefined;
  }
  const out: ValidationBlock = { schema: raw.schema };
  if (raw.errorMessage !== undefined) {
    if (typeof raw.errorMessage === "string") {
      out.errorMessage = raw.errorMessage;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: "agent.validate.errorMessage must be a string when present",
        pointer: joinPointer(pointer, "errorMessage"),
      });
    }
  }
  if (raw.failBehavior !== undefined) {
    if (
      (VALIDATION_FAIL_BEHAVIORS as readonly unknown[]).includes(
        raw.failBehavior
      )
    ) {
      out.failBehavior = raw.failBehavior as ValidationBlock["failBehavior"];
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message:
          'agent.validate.failBehavior must be "retry", "abort" or "continue"',
        pointer: joinPointer(pointer, "failBehavior"),
      });
    }
  }
  if (raw.maxRetries !== undefined) {
    if (isNonNegativeNumber(raw.maxRetries)) {
      out.maxRetries = raw.maxRetries;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message:
          "agent.validate.maxRetries must be a non-negative number when present",
        pointer: joinPointer(pointer, "maxRetries"),
      });
    }
  }
  return out;
}

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
