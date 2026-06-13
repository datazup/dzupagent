import type { WorkerDispatchNode } from "../types.js";
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from "./shared.js";

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
  ["text", "json"]
);

export function parseWorkerDispatch(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext
): WorkerDispatchNode | null {
  const common = parseCommonNodeFields(obj, pointer, ctx);

  const dispatchId = obj.dispatchId;
  if (typeof dispatchId !== "string" || dispatchId.length === 0) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `worker.dispatch.dispatchId must be a non-empty string, received ${describeJsType(
        dispatchId
      )}`,
      pointer: joinPointer(pointer, "dispatchId"),
    });
    return null;
  }

  const provider = obj.provider;
  if (
    typeof provider !== "string" ||
    !WORKER_PROVIDERS.has(provider as WorkerDispatchNode["provider"])
  ) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `worker.dispatch.provider must be one of ${[
        ...WORKER_PROVIDERS,
      ].join("|")}, received ${describeJsType(provider)}`,
      pointer: joinPointer(pointer, "provider"),
    });
    return null;
  }

  const instructions = obj.instructions;
  if (typeof instructions !== "string" || instructions.length === 0) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `worker.dispatch.instructions must be a non-empty string, received ${describeJsType(
        instructions
      )}`,
      pointer: joinPointer(pointer, "instructions"),
    });
    return null;
  }

  const outputKey = obj.outputKey;
  if (typeof outputKey !== "string" || outputKey.length === 0) {
    ctx.errors.push({
      code: "WRONG_FIELD_TYPE",
      message: `worker.dispatch.outputKey must be a non-empty string, received ${describeJsType(
        outputKey
      )}`,
      pointer: joinPointer(pointer, "outputKey"),
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

  if (typeof obj.model === "string") node.model = obj.model;
  if (typeof obj.systemPrompt === "string")
    node.systemPrompt = obj.systemPrompt;
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
        message: `worker.dispatch.input must be an object when present, received ${describeJsType(
          obj.input
        )}`,
        pointer: joinPointer(pointer, "input"),
      });
      return null;
    }
  }
  if (obj.commandSurface !== undefined) {
    if (
      typeof obj.commandSurface === "string" &&
      COMMAND_SURFACES.has(
        obj.commandSurface as NonNullable<WorkerDispatchNode["commandSurface"]>
      )
    ) {
      node.commandSurface = obj.commandSurface as NonNullable<
        WorkerDispatchNode["commandSurface"]
      >;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: 'worker.dispatch.commandSurface must be "none" or "code"',
        pointer: joinPointer(pointer, "commandSurface"),
      });
      return null;
    }
  }
  if (obj.commandAllowlist !== undefined) {
    if (
      Array.isArray(obj.commandAllowlist) &&
      obj.commandAllowlist.every((v): v is string => typeof v === "string")
    ) {
      node.commandAllowlist = obj.commandAllowlist;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: "worker.dispatch.commandAllowlist must be an array of strings",
        pointer: joinPointer(pointer, "commandAllowlist"),
      });
      return null;
    }
  }
  if (typeof obj.validationCommand === "string") {
    node.validationCommand = obj.validationCommand;
  }
  if (obj.resultFormat !== undefined) {
    if (
      typeof obj.resultFormat === "string" &&
      RESULT_FORMATS.has(
        obj.resultFormat as NonNullable<WorkerDispatchNode["resultFormat"]>
      )
    ) {
      node.resultFormat = obj.resultFormat as NonNullable<
        WorkerDispatchNode["resultFormat"]
      >;
    } else {
      ctx.errors.push({
        code: "WRONG_FIELD_TYPE",
        message: 'worker.dispatch.resultFormat must be "text" or "json"',
        pointer: joinPointer(pointer, "resultFormat"),
      });
      return null;
    }
  }

  return node;
}
