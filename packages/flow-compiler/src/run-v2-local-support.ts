import { readFile } from "node:fs/promises";
import type { V2InactiveLocalHostError } from "./v2-inactive-local-target.js";
import type { DzupagentRunDiagnostic, DzupagentRunCliResult } from "./run-v2-local-contracts.js";

const CHECKPOINT_BOUND_KEYS = Object.freeze([
  "handlers",
  "primitives",
  "initialState",
  "inheritedPolicy",
  "conditionBindings",
  "compilerOptions",
  "config",
]);

export class RunFailure extends Error {
  constructor(readonly diagnostic: DzupagentRunDiagnostic) {
    super(diagnostic.message);
  }
}

export function attributeHostError(
  error: V2InactiveLocalHostError
): DzupagentRunDiagnostic {
  if (
    error.code === "V2_LOCAL_HOST_PLAN_INVALID" &&
    error.path.endsWith(".policy")
  ) {
    return { ...error, key: "inheritedPolicy" };
  }
  if (
    error.code === "V2_LOCAL_HOST_REQUEST_INVALID" &&
    (error.path === "configBindings" || error.path.startsWith("configBindings."))
  ) {
    return {
      code: "DZUPAGENT_RUN_CONFIG_INVALID",
      message: error.message,
      key: `config${error.path.slice("configBindings".length)}`,
    };
  }
  if (error.code === "V2_LOCAL_HOST_CHECKPOINT_DRIFT") {
    return {
      ...error,
      message: `${error.message}; the flow or a checkpoint-bound run.json input changed since this runId was first checkpointed (use a new runId or restore the inputs)`,
      keys: CHECKPOINT_BOUND_KEYS,
    };
  }
  return error;
}

export async function readText(path: string, key: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new RunFailure({
      code: "DZUPAGENT_RUN_READ_FAILED",
      key,
      message: `cannot read ${path}: ${message(error)}`,
    });
  }
}

export function failed(errors: readonly DzupagentRunDiagnostic[]): DzupagentRunCliResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: `${JSON.stringify({ ok: false, errors }, null, 2)}\n`,
  };
}

export function argsError(key: string, text: string): RunFailure {
  return new RunFailure({ code: "DZUPAGENT_RUN_ARGS_INVALID", key, message: text });
}

export function configError(key: string, text: string): RunFailure {
  return new RunFailure({ code: "DZUPAGENT_RUN_CONFIG_INVALID", key, message: text });
}

export function primitiveError(key: string, text: string): RunFailure {
  return new RunFailure({ code: "DZUPAGENT_RUN_PRIMITIVE_INVALID", key, message: text });
}

export function handlerError(key: string, text: string): RunFailure {
  return new RunFailure({ code: "DZUPAGENT_RUN_HANDLER_INVALID", key, message: text });
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
