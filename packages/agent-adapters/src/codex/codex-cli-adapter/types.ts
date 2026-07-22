import type { CliHomeProjection } from "../../cli-runtime/index.js";

/**
 * The fully-resolved inputs for a single Codex CLI subprocess invocation,
 * produced by CodexCliAdapter.prepareCliRun and consumed by runJsonlProcess.
 * Kept module-internal to the codex-cli-adapter leaf group (not part of the
 * package public surface).
 */
export interface PreparedCodexCliRun {
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly homeProjection: CliHomeProjection;
}
