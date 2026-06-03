/**
 * Per-kind parser for `agent` and `validate` nodes. Mirrors the discipline of
 * the validator under `../validate/agent.ts` — keep the shape constraints
 * isomorphic so a round-trip parse + validate produces the same node or the
 * same error set.
 */

import type { AgentNode, AgentOutput, ValidateNode } from "../types.js";
import {
  type ParseContext,
  describeJsType,
  isPlainObject,
  joinPointer,
  parseCommonNodeFields,
} from "./shared.js";
import { isNonNegativeNumber } from "../policy-numbers.js";
import { copyOptionalString } from "./agent-fields.js";
import {
  parseOnInvalidOutput,
  parseOutput,
  parseRetry,
  parseStop,
} from "./agent-loop.js";
import { parseCommands, parseValidation } from "./agent-validation.js";
import { parsePolicy } from "./agent-policy.js";

export function parseAgent(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): AgentNode | null {
  let failed = false;

  const agentIdRaw = obj.agentId;
  if (typeof agentIdRaw !== "string" || agentIdRaw.length === 0) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `agent.agentId must be a non-empty string, received ${describeJsType(
        agentIdRaw
      )}`,
      pointer: joinPointer(pointer, "agentId"),
    });
    failed = true;
  }

  const instructionsRaw = obj.instructions;
  if (typeof instructionsRaw !== "string" || instructionsRaw.length === 0) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `agent.instructions must be a non-empty string, received ${describeJsType(
        instructionsRaw
      )}`,
      pointer: joinPointer(pointer, "instructions"),
    });
    failed = true;
  }

  const output = parseOutput(obj.output, joinPointer(pointer, "output"), ctx);
  if (output === null) failed = true;

  if (failed) return null;

  const node: AgentNode = {
    type: "agent",
    ...parseCommonNodeFields(obj, pointer, ctx),
    agentId: agentIdRaw as string,
    instructions: instructionsRaw as string,
    output: output as AgentOutput,
  };

  copyOptionalString(obj, "profile", pointer, ctx, (v) => {
    node.profile = v;
  });
  copyOptionalString(obj, "toolset", pointer, ctx, (v) => {
    node.toolset = v;
  });
  copyOptionalString(obj, "model", pointer, ctx, (v) => {
    node.model = v;
  });
  copyOptionalString(obj, "provider", pointer, ctx, (v) => {
    node.provider = v;
  });

  if ("tools" in obj && obj.tools !== undefined) {
    const tools = obj.tools;
    if (
      Array.isArray(tools) &&
      tools.every((v): v is string => typeof v === "string")
    ) {
      node.tools = tools;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: "agent.tools must be an array of strings when present",
        pointer: joinPointer(pointer, "tools"),
      });
    }
  }

  if ("input" in obj && obj.input !== undefined) {
    if (isPlainObject(obj.input)) node.input = obj.input;
    else {
      ctx.errors.push({
        code: "EXPECTED_OBJECT",
        message: "agent.input must be an object when present",
        pointer: joinPointer(pointer, "input"),
      });
    }
  }

  const stop = parseStop(obj.stop, joinPointer(pointer, "stop"), ctx);
  if (stop !== undefined) node.stop = stop;

  const onInvalidOutput = parseOnInvalidOutput(
    obj.onInvalidOutput,
    joinPointer(pointer, "onInvalidOutput"),
    ctx
  );
  if (onInvalidOutput !== undefined) node.onInvalidOutput = onInvalidOutput;

  const retry = parseRetry(obj.retry, joinPointer(pointer, "retry"), ctx);
  if (retry !== undefined) node.retry = retry;

  const validation = parseValidation(
    obj.validation,
    joinPointer(pointer, "validation"),
    ctx
  );
  if (validation !== undefined) node.validation = validation;

  const policy = parsePolicy(obj.policy, joinPointer(pointer, "policy"), ctx);
  if (policy !== undefined) node.policy = policy;

  return node;
}

export function parseValidateNode(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): ValidateNode | null {
  let ref: string | undefined;
  if ("ref" in obj && obj.ref !== undefined) {
    if (typeof obj.ref === "string" && obj.ref.length > 0) {
      ref = obj.ref;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: "validate.ref must be a non-empty string when present",
        pointer: joinPointer(pointer, "ref"),
      });
      return null;
    }
  }

  const commands = parseCommands(
    obj.commands,
    joinPointer(pointer, "commands"),
    ctx,
    false
  );
  if (ref === undefined && (commands === undefined || commands.length === 0)) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message:
        "validate node requires either `ref` or a non-empty `commands` array",
      pointer,
    });
    return null;
  }

  const node: ValidateNode = {
    type: "validate",
    ...parseCommonNodeFields(obj, pointer, ctx),
  };
  if (ref !== undefined) node.ref = ref;
  if (commands !== undefined) node.commands = commands;

  if ("repair" in obj && obj.repair !== undefined) {
    const repair = obj.repair;
    if (!isPlainObject(repair)) {
      ctx.errors.push({
        code: "EXPECTED_OBJECT",
        message: "validate.repair must be an object when present",
        pointer: joinPointer(pointer, "repair"),
      });
    } else {
      const maxAttempts = repair.maxAttempts;
      if (!isNonNegativeNumber(maxAttempts)) {
        ctx.errors.push({
          code: "WRONG_FIELD_TYPE",
          message:
            "validate.repair.maxAttempts is required (non-negative number)",
          pointer: joinPointer(pointer, "repair/maxAttempts"),
        });
      } else {
        const out: NonNullable<ValidateNode["repair"]> = { maxAttempts };
        if (
          repair.onFailure === "retry-prior-agent" ||
          repair.onFailure === "stop"
        ) {
          out.onFailure = repair.onFailure;
        } else if (repair.onFailure !== undefined) {
          ctx.errors.push({
            code: "WRONG_FIELD_TYPE",
            message:
              'validate.repair.onFailure must be "retry-prior-agent" or "stop"',
            pointer: joinPointer(pointer, "repair/onFailure"),
          });
        }
        node.repair = out;
      }
    }
  }

  return node;
}
