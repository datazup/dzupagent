import type {
  RunSpec,
  RunSpecHash,
  TurnVerb,
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
