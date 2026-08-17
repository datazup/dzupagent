import type { SpawnJsonlOptions } from "../utils/process-helpers.js";

/**
 * Fully-resolved arguments/environment for one CLI spawn, produced by
 * {@link BaseCliAdapter.prepareCliRun} and consumed by the stream source.
 */
export interface PreparedCliRun {
  readonly args: string[];
  readonly cwd?: string | undefined;
  readonly env: Record<string, string>;
  /**
   * Declared as returning plain `void`, deliberately — not
   * `void | Promise<void>`.
   *
   * TypeScript's void-returning-function leniency lets a callback that returns
   * a value satisfy a `=> void` position, so `cleanup: () => temp.pop()`
   * type-checks. That leniency does not survive a union: under
   * `=> void | Promise<void>` the same expression is rejected with TS2322, so
   * the union that reads as the more permissive signature is in fact the
   * stricter one for every adapter that fills this in.
   *
   * `void` still accepts `async () => {…}` and `() => projection.cleanup()`,
   * and the stream source awaits whatever the action returned, so async
   * cleanup still completes before the run is torn down.
   */
  readonly cleanup?: (() => void) | undefined;
  readonly malformedLinePolicy?: "skip" | "error" | undefined;
  readonly stdoutMode?: SpawnJsonlOptions["stdoutMode"];
  readonly limits?: SpawnJsonlOptions["limits"];
}
