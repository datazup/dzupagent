import type { DirtyPolicy } from "../ports/workspace-port.js";
import type { DialogueBranch } from "./dialogue-branch.js";
import type { HandoffDescriptor } from "./handoff-descriptor.js";
import type { TurnVerb } from "./turn-verb.js";
import type { ValidationSpec } from "./validation-spec.js";

export type RunSpecHash = `sha256:${string}`;

export type DialogueMode = "deliberate" | "build";

export interface ParticipantSpec {
  id: string;
  provider: string;
  model: string;
  role?: string;
  /** Participant-level system/persona prompt sent with each agent turn. */
  systemPrompt?: string;
}

export interface BudgetSpec {
  maxUsd?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export type DecidePolicy =
  | {
      kind: "agent";
      participantId: string;
    }
  | {
      kind: "rule";
      ruleId: string;
    };

export interface RunTurnSpec {
  id: string;
  verb: TurnVerb;
  participantId?: string;
  prompt?: string;
  validation?: ValidationSpec;
  handoff?: HandoffDescriptor;
  branch?: DialogueBranch;
}

export interface RunLoopSpec {
  id: string;
  condition: string;
  turnIds: string[];
  maxIterations: number;
}

export interface RunSpec {
  mode: DialogueMode;
  participants: ParticipantSpec[];
  turns: RunTurnSpec[];
  loops?: RunLoopSpec[];
  decidePolicy?: DecidePolicy;
  budget?: BudgetSpec;
  maxIterations?: number;
  allowEscape?: boolean;
  dirtyPolicy?: DirtyPolicy;
}
