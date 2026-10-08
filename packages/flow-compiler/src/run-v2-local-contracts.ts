import type { V2InactiveLocalHostError } from "./v2-inactive-local-target.js";

export type DzupagentRunErrorCode =
  | "DZUPAGENT_RUN_ARGS_INVALID"
  | "DZUPAGENT_RUN_READ_FAILED"
  | "DZUPAGENT_RUN_CONFIG_INVALID"
  | "DZUPAGENT_RUN_PRIMITIVE_INVALID"
  | "DZUPAGENT_RUN_HANDLER_INVALID";

export interface DzupagentRunDiagnostic {
  readonly code: DzupagentRunErrorCode | V2InactiveLocalHostError["code"];
  readonly message: string;
  /** The `run.json` key or CLI argument the diagnostic is about. */
  readonly key?: string;
  /** Config keys that may have drifted when no single key is attributable. */
  readonly keys?: readonly string[];
  readonly path?: string;
  readonly causes?: readonly string[];
}

export interface DzupagentRunCliResult {
  readonly exitCode: 0 | 1;
  /** The host receipt as JSON on success; empty on failure. */
  readonly stdout: string;
  /** `{ ok: false, errors }` as JSON on failure; empty on success. */
  readonly stderr: string;
}

export interface DzupagentRunCliOptions {
  /** Module loader seam; defaults to native dynamic `import()`. */
  readonly importModule?: (url: string) => Promise<unknown>;
}

