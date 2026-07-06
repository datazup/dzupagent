import {
  createRuntimeToolHandlers,
  RUNTIME_TOOL_NAMES,
  type RuntimeToolHandlers,
} from "@dzupagent/agent/pipeline";

export interface HostValidationCommandOutput {
  id: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs?: number;
}

export interface SdlcBatchValidationItem {
  id: string;
  command: string;
  result: "pass" | "fail";
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs?: number;
}

export interface SdlcBatchValidationStatus {
  id: string;
  command: string;
  accepted: boolean;
  status: "pass" | "fail";
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs?: number;
}

export function shapeCommandOutputsForBatchValidation(
  outputs: readonly HostValidationCommandOutput[],
): SdlcBatchValidationItem[] {
  return outputs.map((output) => {
    const item: SdlcBatchValidationItem = {
      id: output.id,
      command: output.command,
      result: output.exitCode === 0 ? "pass" : "fail",
      exitCode: output.exitCode,
      stdout: output.stdout,
      stderr: output.stderr,
    };
    if (output.durationMs !== undefined) {
      item.durationMs = output.durationMs;
    }
    return item;
  });
}

export interface SdlcValidationRuntimeToolHandlerOptions {
  /**
   * State key used by the `sdlc.batch_validation` loop body for each shaped
   * validation item.
   */
  itemStateKey?: string;
}

export function createSdlcValidationRuntimeToolHandlers(
  options: SdlcValidationRuntimeToolHandlerOptions = {},
): RuntimeToolHandlers {
  const itemStateKey = options.itemStateKey ?? "validationItem";
  const handlers = createRuntimeToolHandlers({
    validateSchema: async ({ context, source }) => {
      const item = context.state[itemStateKey];
      if (item === undefined) {
        return { output: source };
      }
      return {
        output: sdlcBatchValidationStatusFromItem(
          item as SdlcBatchValidationItem,
        ),
      };
    },
  });
  return {
    [RUNTIME_TOOL_NAMES.validateSchema]:
      handlers[RUNTIME_TOOL_NAMES.validateSchema]!,
  };
}

function sdlcBatchValidationStatusFromItem(
  item: SdlcBatchValidationItem,
): SdlcBatchValidationStatus {
  const status: SdlcBatchValidationStatus = {
    id: item.id,
    command: item.command,
    accepted: item.result === "pass",
    status: item.result,
    exitCode: item.exitCode,
    stdout: item.stdout,
    stderr: item.stderr,
  };
  if (item.durationMs !== undefined) {
    status.durationMs = item.durationMs;
  }
  return status;
}
