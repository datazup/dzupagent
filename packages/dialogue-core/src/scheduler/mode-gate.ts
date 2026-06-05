import type { DialogueMode } from "../types/run-spec.js";
import type { TurnVerb } from "../types/turn-verb.js";

export const DELIBERATE_MODE_SKIP_REASON = "mode=deliberate";

export interface ModeGateDecision {
  shouldRun: boolean;
  skipReason?: string;
}

export function evaluateModeGate(
  mode: DialogueMode,
  verb: TurnVerb,
): ModeGateDecision {
  if (mode === "deliberate" && (verb === "implement" || verb === "validate")) {
    return {
      shouldRun: false,
      skipReason: DELIBERATE_MODE_SKIP_REASON,
    };
  }

  return {
    shouldRun: true,
  };
}
