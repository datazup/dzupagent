import type { SpawnJsonlOptions } from "../utils/process-helpers.js";

/**
 * Fully-resolved arguments/environment for one CLI spawn, produced by
 * {@link BaseCliAdapter.prepareCliRun} and consumed by the stream source.
 */
export interface PreparedCliRun {
  readonly args: string[];
  readonly cwd?: string | undefined;
  readonly env: Record<string, string>;
  readonly cleanup?: (() => void | Promise<void>) | undefined;
  readonly malformedLinePolicy?: "skip" | "error" | undefined;
  readonly stdoutMode?: SpawnJsonlOptions["stdoutMode"];
  readonly limits?: SpawnJsonlOptions["limits"];
}
