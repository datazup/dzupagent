import type { AdapterParallelNode, FlowNode } from "../types.js";
import { describeJsType, joinPath } from "../validation-helpers.js";
import { validateCommonNodeFields } from "./shared.js";
import type { SchemaIssue } from "./shared.js";

type ParallelProvider = AdapterParallelNode["providers"][number];

const ADAPTER_PROVIDERS = new Set<ParallelProvider>([
  "claude",
  "codex",
  "gemini",
  "qwen",
  "goose",
  "crush",
]);
const MERGE_MODES = new Set<NonNullable<AdapterParallelNode["merge"]>>([
  "first-wins",
  "all",
  "best-of-n",
]);
const REASONING_LEVELS = new Set<NonNullable<AdapterParallelNode["reasoning"]>>(
  ["low", "medium", "high"]
);
const PROMPT_PREP_MODES = new Set<
  NonNullable<AdapterParallelNode["promptPrep"]>
>(["auto", "raw"]);
const IDEMPOTENCY_MODES = new Set<
  NonNullable<AdapterParallelNode["idempotency"]>
>(["idempotent", "at-least-once", "exactly-once-required"]);

export function validateAdapterParallel(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[]
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);

  const providersValue = obj["providers"];
  if (
    !Array.isArray(providersValue) ||
    providersValue.length < 2 ||
    !providersValue.every(
      (v): v is ParallelProvider =>
        typeof v === "string" && ADAPTER_PROVIDERS.has(v as ParallelProvider)
    )
  ) {
    issues.push({
      path: joinPath(path, "providers"),
      code: "MISSING_REQUIRED_FIELD",
      message: `adapter.parallel.providers must be an array of at least 2 providers from ${[
        ...ADAPTER_PROVIDERS,
      ].join("|")}, received ${describeJsType(providersValue)}`,
    });
    return null;
  }
  const providers = providersValue as ParallelProvider[];

  const instructions = obj["instructions"];
  if (typeof instructions !== "string" || instructions.length === 0) {
    issues.push({
      path: joinPath(path, "instructions"),
      code: "MISSING_REQUIRED_FIELD",
      message: `adapter.parallel.instructions is required (non-empty string), received ${describeJsType(
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
      message: `adapter.parallel.output is required (non-empty string), received ${describeJsType(
        output
      )}`,
    });
    return null;
  }

  const node: AdapterParallelNode = {
    type: "adapter.parallel",
    ...common,
    providers,
    instructions,
    output,
  };

  if (obj["merge"] !== undefined) {
    if (
      typeof obj["merge"] === "string" &&
      MERGE_MODES.has(obj["merge"] as NonNullable<AdapterParallelNode["merge"]>)
    ) {
      node.merge = obj["merge"] as NonNullable<AdapterParallelNode["merge"]>;
    } else {
      issues.push({
        path: joinPath(path, "merge"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          'adapter.parallel.merge must be "first-wins", "all", or "best-of-n"',
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
        message: `adapter.parallel.input must be an object when present, received ${describeJsType(
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
        obj["reasoning"] as NonNullable<AdapterParallelNode["reasoning"]>
      )
    ) {
      node.reasoning = obj["reasoning"] as NonNullable<
        AdapterParallelNode["reasoning"]
      >;
    } else {
      issues.push({
        path: joinPath(path, "reasoning"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          'adapter.parallel.reasoning must be "low", "medium", or "high"',
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
          "adapter.parallel.outputSchema must be a schema ref string or an inline object",
      });
      return null;
    }
  }

  if (obj["promptPrep"] !== undefined) {
    if (
      typeof obj["promptPrep"] === "string" &&
      PROMPT_PREP_MODES.has(
        obj["promptPrep"] as NonNullable<AdapterParallelNode["promptPrep"]>
      )
    ) {
      node.promptPrep = obj["promptPrep"] as NonNullable<
        AdapterParallelNode["promptPrep"]
      >;
    } else {
      issues.push({
        path: joinPath(path, "promptPrep"),
        code: "MISSING_REQUIRED_FIELD",
        message: 'adapter.parallel.promptPrep must be "auto" or "raw"',
      });
      return null;
    }
  }

  if (obj["idempotency"] !== undefined) {
    if (
      typeof obj["idempotency"] === "string" &&
      IDEMPOTENCY_MODES.has(
        obj["idempotency"] as NonNullable<AdapterParallelNode["idempotency"]>
      )
    ) {
      node.idempotency = obj["idempotency"] as NonNullable<
        AdapterParallelNode["idempotency"]
      >;
    } else {
      issues.push({
        path: joinPath(path, "idempotency"),
        code: "MISSING_REQUIRED_FIELD",
        message:
          'adapter.parallel.idempotency must be "idempotent", "at-least-once", or "exactly-once-required"',
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
        message: `adapter.parallel.policy must be an object when present, received ${describeJsType(
          obj["policy"]
        )}`,
      });
      return null;
    }
  }

  return node;
}
