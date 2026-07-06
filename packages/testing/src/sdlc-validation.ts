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
