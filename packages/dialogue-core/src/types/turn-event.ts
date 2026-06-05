import type { AgentRunInput } from "./agent-run-request.js";
import type { DialogueMode, RunSpecHash } from "./run-spec.js";
import type { TurnVerb } from "./turn-verb.js";

export type TurnEventStatus = "completed" | "skipped" | "failed";

export type TurnEventVisibility = "raw" | "persisted" | "stream";

export interface TurnEventWorkspace {
  baseRevision: string;
  postRevision: string;
  baseTreeHash: string;
  postTreeHash: string;
  changedFiles: string[];
  diff: string;
  applyStatus: "clean" | "partial" | "failed" | "no-op";
}

export interface TurnEventValidation {
  commandId: string;
  ok: boolean;
  exitCode: number;
  output: string;
  durationMs: number;
}

export interface DecisionCriterion {
  name: string;
  met: boolean;
  weight?: number;
}

export interface DecisionBlock {
  verdict: "continue" | "stop" | "branch" | "accept" | "reject";
  criteria: DecisionCriterion[];
  rationale: string;
  wouldFlipIf?: string;
}

export interface TurnEventTiming {
  startedAt: string;
  ms: number;
}

interface TurnEventBase {
  runId: string;
  runSpecHash: RunSpecHash;
  turnIndex: number;
  turnType: TurnVerb;
  participantId?: string;
  provider?: string;
  model?: string;
  mode: DialogueMode;
  decision?: DecisionBlock;
  cost?: {
    usd: number;
  };
  timing: TurnEventTiming;
  escape: boolean;
  status: TurnEventStatus;
  skipReason?: string;
}

export interface RawTurnEvent extends TurnEventBase {
  visibility: "raw";
  input?: AgentRunInput;
  output?: {
    raw: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  };
  workspace?: TurnEventWorkspace;
  validation?: TurnEventValidation;
}

export interface PersistedTurnEvent extends TurnEventBase {
  visibility: "persisted";
  input?: Omit<AgentRunInput, "prompt"> & {
    promptRedacted?: string;
  };
  output?: {
    rawRedacted?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  };
  workspace?: Omit<TurnEventWorkspace, "diff"> & {
    diffRedacted?: string;
  };
  validation?: Omit<TurnEventValidation, "output"> & {
    outputRedacted?: string;
  };
}

export interface StreamTurnEvent extends TurnEventBase {
  visibility: "stream";
  input?: Omit<AgentRunInput, "prompt"> & {
    promptPreview?: string;
  };
  output?: {
    rawPreview?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
  };
  workspace?: Omit<TurnEventWorkspace, "diff"> & {
    diffPreview?: string;
  };
  validation?: Omit<TurnEventValidation, "output"> & {
    outputPreview?: string;
  };
}
