import type { AdapterRunNode, FlowNode } from "../types.js";
import { describeJsType, joinPath } from "../validation-helpers.js";
import { validateCommonNodeFields } from "./shared.js";
import type { SchemaIssue } from "./shared.js";

const ADAPTER_PROVIDERS = new Set<NonNullable<AdapterRunNode["provider"]>>([
  "claude",
  "codex",
  "gemini",
  "openai",
  "openrouter",
  "qwen",
  "goose",
  "crush",
]);
const REASONING_LEVELS = new Set<NonNullable<AdapterRunNode["reasoning"]>>([
  "low",
  "medium",
  "high",
]);
const PROMPT_PREP_MODES = new Set<NonNullable<AdapterRunNode["promptPrep"]>>([
  "auto",
  "raw",
]);
const IDEMPOTENCY_MODES = new Set<NonNullable<AdapterRunNode["idempotency"]>>([
  "idempotent",
  "at-least-once",
  "exactly-once-required",
]);

export function validateAdapterRun(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);

  const hasProvider = obj["provider"] !== undefined;
  const hasTags = obj["tags"] !== undefined;
  let provider: AdapterRunNode["provider"] | undefined;
  let tags: string[] | undefined;

  if (hasProvider) {
    const value = obj["provider"];
    if (
      typeof value !== "string" ||
      !ADAPTER_PROVIDERS.has(value as NonNullable<AdapterRunNode["provider"]>)
    ) {
      issues.push({
        path: joinPath(path, "provider"),
        code: "MISSING_REQUIRED_FIELD",
        message: `adapter.run.provider must be one of ${[
          ...ADAPTER_PROVIDERS,
        ].join("|")}, received ${describeJsType(value)}`,
      });
      return null;
    }
    provider = value as AdapterRunNode["provider"];
  }

  if (hasTags) {
    const value = obj["tags"];
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((v): v is string => typeof v === "string")
    ) {
      tags = value;
    } else {
      issues.push({
        path: joinPath(path, "tags"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          "adapter.run.tags must be a non-empty array of strings when present",
      });
      return null;
    }
  }

  if (!hasProvider && !hasTags) {
    issues.push({
      path: joinPath(path, "provider"),
      code: "MISSING_REQUIRED_FIELD",
      message:
        "adapter.run requires one of provider or tags to select an adapter",
    });
    return null;
  }

  const instructions = obj["instructions"];
  if (typeof instructions !== "string" || instructions.length === 0) {
    issues.push({
      path: joinPath(path, "instructions"),
      code: "MISSING_REQUIRED_FIELD",
      message: `adapter.run.instructions is required (non-empty string), received ${describeJsType(
        instructions
      )}`,
    });
    return null;
  }

  const output = obj["output"];
  if (typeof output !== "string" || output.length === 0) {
    issues.push({
      path: joinPath(path, "output"),
      code: "MISSING_REQUIRED_FIELD",
      message: `adapter.run.output is required (non-empty string), received ${describeJsType(
        output
      )}`,
    });
    return null;
  }

  const node: AdapterRunNode = {
    type: "adapter.run",
    ...common,
    instructions,
    output,
  };

  if (provider !== undefined) node.provider = provider;
  if (tags !== undefined) node.tags = tags;
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
        message: `adapter.run.input must be an object when present, received ${describeJsType(
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
        obj["reasoning"] as NonNullable<AdapterRunNode["reasoning"]>
      )
    ) {
      node.reasoning = obj["reasoning"] as NonNullable<
        AdapterRunNode["reasoning"]
      >;
    } else {
      issues.push({
        path: joinPath(path, "reasoning"),
        code: "MISSING_REQUIRED_FIELD",
        message: 'adapter.run.reasoning must be "low", "medium", or "high"',
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
          "adapter.run.outputSchema must be a schema ref string or an inline object",
      });
      return null;
    }
  }

  if (obj["promptPrep"] !== undefined) {
    if (
      typeof obj["promptPrep"] === "string" &&
      PROMPT_PREP_MODES.has(
        obj["promptPrep"] as NonNullable<AdapterRunNode["promptPrep"]>
      )
    ) {
      node.promptPrep = obj["promptPrep"] as NonNullable<
        AdapterRunNode["promptPrep"]
      >;
    } else {
      issues.push({
        path: joinPath(path, "promptPrep"),
        code: "MISSING_REQUIRED_FIELD",
        message: 'adapter.run.promptPrep must be "auto" or "raw"',
      });
      return null;
    }
  }

  if (obj["idempotency"] !== undefined) {
    if (
      typeof obj["idempotency"] === "string" &&
      IDEMPOTENCY_MODES.has(
        obj["idempotency"] as NonNullable<AdapterRunNode["idempotency"]>
      )
    ) {
      node.idempotency = obj["idempotency"] as NonNullable<
        AdapterRunNode["idempotency"]
      >;
    } else {
      issues.push({
        path: joinPath(path, "idempotency"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          'adapter.run.idempotency must be "idempotent", "at-least-once", or "exactly-once-required"',
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
        message: `adapter.run.policy must be an object when present, received ${describeJsType(
          obj["policy"]
        )}`,
      });
      return null;
    }
  }

  return node;
}
