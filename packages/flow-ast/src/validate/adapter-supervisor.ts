import type { AdapterSupervisorNode, FlowNode } from "../types.js";
import { describeJsType, joinPath } from "../validation-helpers.js";
import { validateCommonNodeFields } from "./shared.js";
import type { SchemaIssue } from "./shared.js";

const REASONING_LEVELS = new Set<
  NonNullable<AdapterSupervisorNode["reasoning"]>
>(["low", "medium", "high"]);
const PROMPT_PREP_MODES = new Set<
  NonNullable<AdapterSupervisorNode["promptPrep"]>
>(["auto", "raw"]);
const IDEMPOTENCY_MODES = new Set<
  NonNullable<AdapterSupervisorNode["idempotency"]>
>(["idempotent", "at-least-once", "exactly-once-required"]);

export function validateAdapterSupervisor(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);

  const goal = obj["goal"];
  if (typeof goal !== "string" || goal.length === 0) {
    issues.push({
      path: joinPath(path, "goal"),
      code: "MISSING_REQUIRED_FIELD",
      message: `adapter.supervisor.goal is required (non-empty string), received ${describeJsType(
        goal
      )}`,
    });
    return null;
  }

  const output = obj["output"];
  if (typeof output !== "string" || output.length === 0) {
    issues.push({
      path: joinPath(path, "output"),
      code: "MISSING_REQUIRED_FIELD",
      message: `adapter.supervisor.output is required (non-empty string), received ${describeJsType(
        output
      )}`,
    });
    return null;
  }

  const node: AdapterSupervisorNode = {
    type: "adapter.supervisor",
    ...common,
    goal,
    output,
  };

  if (obj["specialists"] !== undefined) {
    const value = obj["specialists"];
    if (
      Array.isArray(value) &&
      value.every((v): v is string => typeof v === "string")
    ) {
      node.specialists = value;
    } else {
      issues.push({
        path: joinPath(path, "specialists"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "adapter.supervisor.specialists must be an array of strings when present",
      });
      return null;
    }
  }

  if (typeof obj["model"] === "string") node.model = obj["model"];
  if (typeof obj["systemPrompt"] === "string") {
    node.systemPrompt = obj["systemPrompt"];
  }
  if (typeof obj["persona"] === "string") node.persona = obj["persona"];

  if (obj["input"] !== undefined) {
    if (
      typeof obj["input"] === "object" &&
      obj["input"] !== null &&
      !Array.isArray(obj["input"])
    ) {
      node.input = obj["input"] as Record<string, unknown>;
    } else {
      issues.push({
        path: joinPath(path, "input"),
        code: "MISSING_REQUIRED_FIELD",
        message: `adapter.supervisor.input must be an object when present, received ${describeJsType(
          obj["input"]
        )}`,
      });
      return null;
    }
  }

  if (obj["reasoning"] !== undefined) {
    if (
      typeof obj["reasoning"] === "string" &&
      REASONING_LEVELS.has(
        obj["reasoning"] as NonNullable<AdapterSupervisorNode["reasoning"]>
      )
    ) {
      node.reasoning = obj["reasoning"] as NonNullable<
        AdapterSupervisorNode["reasoning"]
      >;
    } else {
      issues.push({
        path: joinPath(path, "reasoning"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          'adapter.supervisor.reasoning must be "low", "medium", or "high"',
      });
      return null;
    }
  }

  if (obj["outputSchema"] !== undefined) {
    if (typeof obj["outputSchema"] === "string") {
      node.outputSchema = obj["outputSchema"];
    } else if (
      typeof obj["outputSchema"] === "object" &&
      obj["outputSchema"] !== null &&
      !Array.isArray(obj["outputSchema"])
    ) {
      node.outputSchema = obj["outputSchema"] as Record<string, unknown>;
    } else {
      issues.push({
        path: joinPath(path, "outputSchema"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "adapter.supervisor.outputSchema must be a schema ref string or an inline object",
      });
      return null;
    }
  }

  if (obj["promptPrep"] !== undefined) {
    if (
      typeof obj["promptPrep"] === "string" &&
      PROMPT_PREP_MODES.has(
        obj["promptPrep"] as NonNullable<AdapterSupervisorNode["promptPrep"]>
      )
    ) {
      node.promptPrep = obj["promptPrep"] as NonNullable<
        AdapterSupervisorNode["promptPrep"]
      >;
    } else {
      issues.push({
        path: joinPath(path, "promptPrep"),
        code: "MISSING_REQUIRED_FIELD",
        message: 'adapter.supervisor.promptPrep must be "auto" or "raw"',
      });
      return null;
    }
  }

  if (obj["idempotency"] !== undefined) {
    if (
      typeof obj["idempotency"] === "string" &&
      IDEMPOTENCY_MODES.has(
        obj["idempotency"] as NonNullable<AdapterSupervisorNode["idempotency"]>
      )
    ) {
      node.idempotency = obj["idempotency"] as NonNullable<
        AdapterSupervisorNode["idempotency"]
      >;
    } else {
      issues.push({
        path: joinPath(path, "idempotency"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          'adapter.supervisor.idempotency must be "idempotent", "at-least-once", or "exactly-once-required"',
      });
      return null;
    }
  }

  if (obj["policy"] !== undefined) {
    if (
      typeof obj["policy"] === "object" &&
      obj["policy"] !== null &&
      !Array.isArray(obj["policy"])
    ) {
      node.policy = obj["policy"] as Record<string, unknown>;
    } else {
      issues.push({
        path: joinPath(path, "policy"),
        code: "MISSING_REQUIRED_FIELD",
        message: `adapter.supervisor.policy must be an object when present, received ${describeJsType(
          obj["policy"]
        )}`,
      });
      return null;
    }
  }

  return node;
}
