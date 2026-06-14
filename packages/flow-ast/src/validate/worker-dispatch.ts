import type { FlowNode, WorkerDispatchNode } from "../types.js";
import { describeJsType, joinPath } from "../validation-helpers.js";
import { validateCommonNodeFields } from "./shared.js";
import type { SchemaIssue } from "./shared.js";

const WORKER_PROVIDERS = new Set<WorkerDispatchNode["provider"]>([
  "claude",
  "codex",
  "gemini",
  "qwen",
  "goose",
  "crush",
]);
const COMMAND_SURFACES = new Set<
  NonNullable<WorkerDispatchNode["commandSurface"]>
>(["none", "code"]);
const RESULT_FORMATS = new Set<NonNullable<WorkerDispatchNode["resultFormat"]>>(
  ["text", "json"],
);

export function validateWorkerDispatch(
  obj: Record<string, unknown>,
  path: string,
  issues: SchemaIssue[],
): FlowNode | null {
  const common = validateCommonNodeFields(obj, path, issues);

  const dispatchId = obj["dispatchId"];
  if (typeof dispatchId !== "string" || dispatchId.length === 0) {
    issues.push({
      path: joinPath(path, "dispatchId"),
      code: "MISSING_REQUIRED_FIELD",
      message: `worker.dispatch.dispatchId is required (non-empty string), received ${describeJsType(
        dispatchId,
      )}`,
    });
    return null;
  }

  const provider = obj["provider"];
  if (
    typeof provider !== "string" ||
    !WORKER_PROVIDERS.has(provider as WorkerDispatchNode["provider"])
  ) {
    issues.push({
      path: joinPath(path, "provider"),
      code: "MISSING_REQUIRED_FIELD",
      message: `worker.dispatch.provider must be one of ${[
        ...WORKER_PROVIDERS,
      ].join("|")}, received ${describeJsType(provider)}`,
    });
    return null;
  }

  const instructions = obj["instructions"];
  if (typeof instructions !== "string" || instructions.length === 0) {
    issues.push({
      path: joinPath(path, "instructions"),
      code: "MISSING_REQUIRED_FIELD",
      message: `worker.dispatch.instructions is required (non-empty string), received ${describeJsType(
        instructions,
      )}`,
    });
    return null;
  }

  const outputKey = obj["outputKey"];
  if (typeof outputKey !== "string" || outputKey.length === 0) {
    issues.push({
      path: joinPath(path, "outputKey"),
      code: "MISSING_REQUIRED_FIELD",
      message: `worker.dispatch.outputKey is required (non-empty string), received ${describeJsType(
        outputKey,
      )}`,
    });
    return null;
  }

  const node: WorkerDispatchNode = {
    type: "worker.dispatch",
    ...common,
    dispatchId,
    provider: provider as WorkerDispatchNode["provider"],
    instructions,
    outputKey,
  };

  if (typeof obj["model"] === "string") node.model = obj["model"];
  if (typeof obj["systemPrompt"] === "string") {
    node.systemPrompt = obj["systemPrompt"];
  }
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
        message: `worker.dispatch.input must be an object when present, received ${describeJsType(
          obj["input"],
        )}`,
      });
      return null;
    }
  }
  if (obj["commandSurface"] !== undefined) {
    if (
      typeof obj["commandSurface"] === "string" &&
      COMMAND_SURFACES.has(
        obj["commandSurface"] as NonNullable<
          WorkerDispatchNode["commandSurface"]
        >,
      )
    ) {
      node.commandSurface = obj["commandSurface"] as NonNullable<
        WorkerDispatchNode["commandSurface"]
      >;
    } else {
      issues.push({
        path: joinPath(path, "commandSurface"),
        code: "MISSING_REQUIRED_FIELD",
        message: 'worker.dispatch.commandSurface must be "none" or "code"',
      });
      return null;
    }
  }
  if (obj["commandAllowlist"] !== undefined) {
    if (
      Array.isArray(obj["commandAllowlist"]) &&
      obj["commandAllowlist"].every((v): v is string => typeof v === "string")
    ) {
      node.commandAllowlist = obj["commandAllowlist"];
    } else {
      issues.push({
        path: joinPath(path, "commandAllowlist"),
        code: "MISSING_REQUIRED_FIELD",
        message: "worker.dispatch.commandAllowlist must be an array of strings",
      });
      return null;
    }
  }
  if (typeof obj["validationCommand"] === "string") {
    node.validationCommand = obj["validationCommand"];
  }
  if (typeof obj["resultSchema"] === "string") {
    node.resultSchema = obj["resultSchema"];
  }
  if (obj["resultFormat"] !== undefined) {
    if (
      typeof obj["resultFormat"] === "string" &&
      RESULT_FORMATS.has(
        obj["resultFormat"] as NonNullable<WorkerDispatchNode["resultFormat"]>,
      )
    ) {
      node.resultFormat = obj["resultFormat"] as NonNullable<
        WorkerDispatchNode["resultFormat"]
      >;
    } else {
      issues.push({
        path: joinPath(path, "resultFormat"),
        code: "MISSING_REQUIRED_FIELD",
        message: 'worker.dispatch.resultFormat must be "text" or "json"',
      });
      return null;
    }
  }

  return node;
}
