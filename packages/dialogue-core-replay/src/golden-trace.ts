import type {
  AgentResult,
  RunSpec,
  RunSpecHash,
  TurnVerb,
  ValidationResult,
  ValidationSpec,
  WorkspaceEffect,
  WorkspaceSnapshot,
} from "@dzupagent/dialogue-core";

import type { RecordedAgentCall } from "./recorded-agent-port.js";
import type { RecordedValidatorCall } from "./recorded-validator-port.js";
import type { RecordedWorkspaceEffectCapture } from "./recorded-workspace-port.js";

export interface GoldenTraceTurn {
  readonly turnId: string;
  readonly verb: TurnVerb;
  readonly agentCalls: readonly RecordedAgentCall[];
  readonly validatorCalls: readonly RecordedValidatorCall[];
  readonly workspaceSnapshots: readonly WorkspaceSnapshot[];
  readonly workspaceEffects: readonly RecordedWorkspaceEffectCapture[];
}

export interface GoldenTrace {
  readonly runId: string;
  readonly runSpecHash: RunSpecHash;
  readonly verbSequence: readonly TurnVerb[];
  readonly runSpec: RunSpec;
  readonly turns: readonly GoldenTraceTurn[];
}

export class GoldenTraceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldenTraceValidationError";
  }
}

export function validateGoldenTrace(value: unknown): GoldenTrace {
  if (typeof value !== "object" || value === null) {
    throw new GoldenTraceValidationError("GoldenTrace must be an object.");
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj["runId"] !== "string" || obj["runId"].length === 0) {
    throw new GoldenTraceValidationError(
      "GoldenTrace.runId must be a non-empty string."
    );
  }

  if (
    typeof obj["runSpecHash"] !== "string" ||
    !obj["runSpecHash"].startsWith("sha256:")
  ) {
    throw new GoldenTraceValidationError(
      "GoldenTrace.runSpecHash must be a sha256: prefixed string."
    );
  }

  if (!Array.isArray(obj["verbSequence"])) {
    throw new GoldenTraceValidationError(
      "GoldenTrace.verbSequence must be an array."
    );
  }

  if (typeof obj["runSpec"] !== "object" || obj["runSpec"] === null) {
    throw new GoldenTraceValidationError(
      "GoldenTrace.runSpec must be an object."
    );
  }

  if (!Array.isArray(obj["turns"])) {
    throw new GoldenTraceValidationError("GoldenTrace.turns must be an array.");
  }

  return value as GoldenTrace;
}

export function loadGoldenTrace(json: string): GoldenTrace {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new GoldenTraceValidationError(
      `GoldenTrace JSON parse error: ${String(err)}`
    );
  }
  return validateGoldenTrace(parsed);
}

export {
  AgentResult,
  RunSpec,
  RunSpecHash,
  TurnVerb,
  ValidationResult,
  ValidationSpec,
  WorkspaceEffect,
  WorkspaceSnapshot,
};
