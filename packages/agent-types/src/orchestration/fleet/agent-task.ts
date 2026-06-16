import type { TaskId } from "./fleet-types.js";

export type AgentTaskProviderId = string;

export interface AgentTaskRuntimePolicy {
  sandboxMode?: "read-only" | "workspace-write" | "full-access";
  networkAccess?: boolean;
  approvalRequired?: boolean;
  allowedTools?: string[];
  blockedTools?: string[];
  maxBudgetUsd?: number;
  maxTurns?: number;
}

export type AgentTaskRisk = "low" | "medium" | "high" | "critical";

export type ValidationScope = "task" | "repo" | "run";

export interface ValidationCommand {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  scope?: ValidationScope;
  allowFailure?: boolean;
}

export type ValidationStatus = "passed" | "failed" | "skipped";

export interface ValidationResult {
  command: string;
  status: ValidationStatus;
  exitCode: number;
  durationMs: number;
  outputPath?: string;
  summary?: string;
}

export interface AgentTask {
  id: TaskId;
  title?: string;
  prompt: string;
  systemPrompt?: string;
  personaId?: string;
  templateId?: string;
  templateVariables?: Record<string, unknown>;
  workingDirectory?: string;
  targetRepo?: string;
  scopeFiles?: string[];
  payload?: unknown;
  acceptanceCriteria?: string[];
  outputSchema?: Record<string, unknown>;
  validationCommands?: ValidationCommand[];
  dependsOn?: TaskId[];
  maxAttempts?: number;
  risk?: AgentTaskRisk;
  tags?: string[];
  provider?: AgentTaskProviderId;
  model?: string;
  runtimePolicy?: AgentTaskRuntimePolicy;
}

export type AgentTaskStatus = "completed" | "partial" | "blocked" | "failed";

export interface AgentTaskResult {
  taskId: TaskId;
  status: AgentTaskStatus;
  providerId?: AgentTaskProviderId;
  sessionId?: string;
  changedFiles?: string[];
  declaredArtifacts?: string[];
  validationResults?: ValidationResult[];
  blockers?: string[];
  summary?: string;
  eventsPath?: string;
}

export type ReviewDecisionKind =
  | "accepted"
  | "needs-repair"
  | "blocked"
  | "rejected-out-of-scope";

export interface ReviewDecision {
  taskId: TaskId;
  attempt: number;
  decision: ReviewDecisionKind;
  reasons: string[];
  repairTask?: AgentTask;
}
