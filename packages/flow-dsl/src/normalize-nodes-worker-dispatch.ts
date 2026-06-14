/**
 * DSL normalization for `worker.dispatch` nodes (dzupflow/v1alpha-worker).
 *
 * Mirrors `normalize-nodes-agent.ts` style: declare allowed keys, run the
 * `reportUnsupportedFields` guard, normalize the common base, and emit
 * diagnostics for shape problems. A `worker.dispatch` node hands an operator
 * task to a CLI provider running on a worker; command governance defaults to a
 * read-only surface and the result is parsed as text unless overridden.
 */

import type { WorkerDispatchNode } from "@dzupagent/flow-ast";

import { DSL_ERROR } from "./errors.js";
import {
  COMMON_NODE_KEYS,
  normalizeObject,
  normalizeCommonNodeFields,
  reportUnsupportedFields,
} from "./normalize-value-helpers.js";
import type { DslDiagnostic } from "./types.js";

const WORKER_DISPATCH_KEYS = new Set<string>([
  ...COMMON_NODE_KEYS,
  "dispatchId",
  "provider",
  "model",
  "systemPrompt",
  "instructions",
  "input",
  "commandSurface",
  "commandAllowlist",
  "validationCommand",
  "outputKey",
  "resultFormat",
  "resultSchema",
]);

const VALID_PROVIDERS = new Set<WorkerDispatchNode["provider"]>([
  "claude",
  "codex",
  "gemini",
  "qwen",
  "goose",
  "crush",
]);

const VALID_COMMAND_SURFACES = new Set<
  NonNullable<WorkerDispatchNode["commandSurface"]>
>(["none", "code"]);

const VALID_RESULT_FORMATS = new Set<
  NonNullable<WorkerDispatchNode["resultFormat"]>
>(["text", "json"]);

function isWorkerProvider(
  value: unknown,
): value is WorkerDispatchNode["provider"] {
  return (
    typeof value === "string" &&
    VALID_PROVIDERS.has(value as WorkerDispatchNode["provider"])
  );
}

export function normalizeWorkerDispatch(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: DslDiagnostic[],
): WorkerDispatchNode {
  reportUnsupportedFields(raw, WORKER_DISPATCH_KEYS, path, diagnostics);
  const base = normalizeCommonNodeFields(raw, path, diagnostics);

  const dispatchId = typeof raw.dispatchId === "string" ? raw.dispatchId : "";
  const instructions =
    typeof raw.instructions === "string" ? raw.instructions : "";
  const outputKey = typeof raw.outputKey === "string" ? raw.outputKey : "";

  if (dispatchId.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "worker.dispatch.dispatchId is required",
      path: `${path}.dispatchId`,
    });
  }
  if (instructions.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "worker.dispatch.instructions is required",
      path: `${path}.instructions`,
    });
  }
  if (outputKey.length === 0) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "worker.dispatch.outputKey is required",
      path: `${path}.outputKey`,
    });
  }

  // provider is required and must be one of the supported CLI providers.
  let provider: WorkerDispatchNode["provider"] = "claude";
  if (raw.provider === undefined) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.MISSING_REQUIRED_FIELD,
      message: "worker.dispatch.provider is required",
      path: `${path}.provider`,
    });
  } else if (isWorkerProvider(raw.provider)) {
    provider = raw.provider;
  } else {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_ENUM_VALUE,
      message: `worker.dispatch.provider must be one of ${[
        ...VALID_PROVIDERS,
      ].join("|")}`,
      path: `${path}.provider`,
    });
  }

  // Defaults per design intent: read-only command surface, text result parse.
  let commandSurface: NonNullable<WorkerDispatchNode["commandSurface"]> =
    "none";
  if (raw.commandSurface !== undefined) {
    if (
      typeof raw.commandSurface === "string" &&
      VALID_COMMAND_SURFACES.has(
        raw.commandSurface as NonNullable<WorkerDispatchNode["commandSurface"]>,
      )
    ) {
      commandSurface = raw.commandSurface as NonNullable<
        WorkerDispatchNode["commandSurface"]
      >;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message: 'worker.dispatch.commandSurface must be "none" or "code"',
        path: `${path}.commandSurface`,
      });
    }
  }

  let resultFormat: NonNullable<WorkerDispatchNode["resultFormat"]> = "text";
  if (raw.resultFormat !== undefined) {
    if (
      typeof raw.resultFormat === "string" &&
      VALID_RESULT_FORMATS.has(
        raw.resultFormat as NonNullable<WorkerDispatchNode["resultFormat"]>,
      )
    ) {
      resultFormat = raw.resultFormat as NonNullable<
        WorkerDispatchNode["resultFormat"]
      >;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_ENUM_VALUE,
        message: 'worker.dispatch.resultFormat must be "text" or "json"',
        path: `${path}.resultFormat`,
      });
    }
  }

  const node: WorkerDispatchNode = {
    type: "worker.dispatch",
    ...base,
    dispatchId,
    provider,
    instructions,
    outputKey,
    commandSurface,
    resultFormat,
  };

  if (typeof raw.model === "string") node.model = raw.model;
  if (typeof raw.systemPrompt === "string")
    node.systemPrompt = raw.systemPrompt;

  if (raw.input !== undefined) {
    const input = normalizeObject(raw.input, `${path}.input`, diagnostics);
    if (input !== undefined) node.input = input;
  }

  if (raw.commandAllowlist !== undefined) {
    if (
      Array.isArray(raw.commandAllowlist) &&
      raw.commandAllowlist.every((v): v is string => typeof v === "string")
    ) {
      node.commandAllowlist = raw.commandAllowlist;
    } else {
      diagnostics.push({
        phase: "normalize",
        code: DSL_ERROR.INVALID_NODE_SHAPE,
        message: "worker.dispatch.commandAllowlist must be an array of strings",
        path: `${path}.commandAllowlist`,
      });
    }
  }

  if (typeof raw.validationCommand === "string") {
    node.validationCommand = raw.validationCommand;
  } else if (raw.validationCommand !== undefined) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: "worker.dispatch.validationCommand must be a string",
      path: `${path}.validationCommand`,
    });
  }

  if (typeof raw.resultSchema === "string") {
    node.resultSchema = raw.resultSchema;
  } else if (raw.resultSchema !== undefined) {
    diagnostics.push({
      phase: "normalize",
      code: DSL_ERROR.INVALID_NODE_SHAPE,
      message: "worker.dispatch.resultSchema must be a string",
      path: `${path}.resultSchema`,
    });
  }

  return node;
}
