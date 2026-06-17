import type { AdapterSupervisorNode } from "../types.js";
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from "./shared.js";

const REASONING_LEVELS = new Set<
  NonNullable<AdapterSupervisorNode["reasoning"]>
>(["low", "medium", "high"]);
const PROMPT_PREP_MODES = new Set<
  NonNullable<AdapterSupervisorNode["promptPrep"]>
>(["auto", "raw"]);
const IDEMPOTENCY_MODES = new Set<
  NonNullable<AdapterSupervisorNode["idempotency"]>
>(["idempotent", "at-least-once", "exactly-once-required"]);

export function parseAdapterSupervisor(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): AdapterSupervisorNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);

  const goal = obj.goal;
  if (typeof goal !== "string" || goal.length === 0) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `adapter.supervisor.goal must be a non-empty string, received ${describeJsType(
        goal
      )}`,
      pointer: joinPointer(pointer, "goal"),
    });
    return null;
  }

  const output = obj.output;
  if (typeof output !== "string" || output.length === 0) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `adapter.supervisor.output must be a non-empty string, received ${describeJsType(
        output
      )}`,
      pointer: joinPointer(pointer, "output"),
    });
    return null;
  }

  const node: AdapterSupervisorNode = {
    type: "adapter.supervisor",
    ...common,
    goal,
    output,
  };

  if (obj.specialists !== undefined) {
    if (
      Array.isArray(obj.specialists) &&
      obj.specialists.every((v): v is string => typeof v === "string")
    ) {
      node.specialists = obj.specialists;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message:
          "adapter.supervisor.specialists must be an array of strings when present",
        pointer: joinPointer(pointer, "specialists"),
      });
      return null;
    }
  }

  if (typeof obj.model === "string") node.model = obj.model;
  if (typeof obj.systemPrompt === "string")
    node.systemPrompt = obj.systemPrompt;
  if (typeof obj.persona === "string") node.persona = obj.persona;

  if (obj.input !== undefined) {
    if (
      typeof obj.input === "object" &&
      obj.input !== null &&
      !Array.isArray(obj.input)
    ) {
      node.input = obj.input as Record<string, unknown>;
    } else {
      ctx.errors.push({
        code: "EXPECTED_OBJECT",
        message: `adapter.supervisor.input must be an object when present, received ${describeJsType(
          obj.input
        )}`,
        pointer: joinPointer(pointer, "input"),
      });
      return null;
    }
  }

  if (obj.reasoning !== undefined) {
    if (
      typeof obj.reasoning === "string" &&
      REASONING_LEVELS.has(
        obj.reasoning as NonNullable<AdapterSupervisorNode["reasoning"]>
      )
    ) {
      node.reasoning = obj.reasoning as NonNullable<
        AdapterSupervisorNode["reasoning"]
      >;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message:
          'adapter.supervisor.reasoning must be "low", "medium", or "high"',
        pointer: joinPointer(pointer, "reasoning"),
      });
      return null;
    }
  }

  if (obj.outputSchema !== undefined) {
    if (typeof obj.outputSchema === "string") {
      node.outputSchema = obj.outputSchema;
    } else if (
      typeof obj.outputSchema === "object" &&
      obj.outputSchema !== null &&
      !Array.isArray(obj.outputSchema)
    ) {
      node.outputSchema = obj.outputSchema as Record<string, unknown>;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message:
          "adapter.supervisor.outputSchema must be a schema ref string or an inline object",
        pointer: joinPointer(pointer, "outputSchema"),
      });
      return null;
    }
  }

  if (obj.promptPrep !== undefined) {
    if (
      typeof obj.promptPrep === "string" &&
      PROMPT_PREP_MODES.has(
        obj.promptPrep as NonNullable<AdapterSupervisorNode["promptPrep"]>
      )
    ) {
      node.promptPrep = obj.promptPrep as NonNullable<
        AdapterSupervisorNode["promptPrep"]
      >;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: 'adapter.supervisor.promptPrep must be "auto" or "raw"',
        pointer: joinPointer(pointer, "promptPrep"),
      });
      return null;
    }
  }

  if (obj.idempotency !== undefined) {
    if (
      typeof obj.idempotency === "string" &&
      IDEMPOTENCY_MODES.has(
        obj.idempotency as NonNullable<AdapterSupervisorNode["idempotency"]>
      )
    ) {
      node.idempotency = obj.idempotency as NonNullable<
        AdapterSupervisorNode["idempotency"]
      >;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message:
          'adapter.supervisor.idempotency must be "idempotent", "at-least-once", or "exactly-once-required"',
        pointer: joinPointer(pointer, "idempotency"),
      });
      return null;
    }
  }

  if (obj.policy !== undefined) {
    if (
      typeof obj.policy === "object" &&
      obj.policy !== null &&
      !Array.isArray(obj.policy)
    ) {
      node.policy = obj.policy as Record<string, unknown>;
    } else {
      ctx.errors.push({
        code: "EXPECTED_OBJECT",
        message: `adapter.supervisor.policy must be an object when present, received ${describeJsType(
          obj.policy
        )}`,
        pointer: joinPointer(pointer, "policy"),
      });
      return null;
    }
  }

  return node;
}
