import type { DialogueMode, RunSpecHash } from "./run-spec.js";
import type { TurnVerb } from "./turn-verb.js";

export interface AgentRunScopeFile {
  path: string;
  content?: string;
}

export interface AgentRunInput {
  prompt: string;
  role?: string;
  systemPrompt?: string;
  scopeFiles?: AgentRunScopeFile[];
}

export interface AgentRunRequest {
  runId: string;
  runSpecHash: RunSpecHash;
  turnIndex: number;
  turnType: TurnVerb;
  participantId: string;
  provider?: string;
  model?: string;
  mode: DialogueMode;
  input: AgentRunInput;
  escape?: boolean;
}
