import type {
  AgentTaskRisk,
  AgentTaskRuntimePolicy,
  ValidationCommand,
  ValidationResult,
} from "../fleet/index.js";

export type ImplementationRunStatus =
  | "draft"
  | "running"
  | "paused"
  | "completed"
  | "blocked"
  | "cancelled";

export interface ImplementationRepoRef {
  id: string;
  path: string;
  instructions?: string[];
}

export interface ImplementationTask {
  id: string;
  repoId: string;
  title: string;
  prompt: string;
  scopeFiles: string[];
  acceptanceCriteria: string[];
  validationCommands: ValidationCommand[];
  dependsOn?: string[];
  risk?: AgentTaskRisk;
  provider?: string;
  runtimePolicy?: AgentTaskRuntimePolicy;
  maxAttempts?: number;
  tags?: string[];
}

export interface ImplementationBatch {
  id: string;
  title: string;
  mode: "serial" | "parallel-repos";
  taskIds: string[];
  dependsOn?: string[];
}

export interface ImplementationPlanPolicy {
  maxAttemptsPerTask: number;
  repoConcurrency: number;
  highRiskRequiresApproval: boolean;
}

export interface ImplementationPlan {
  schemaVersion: 1;
  id: string;
  goal: string;
  repos: ImplementationRepoRef[];
  batches: ImplementationBatch[];
  tasks: ImplementationTask[];
  policy: ImplementationPlanPolicy;
}

export interface TaskAttempt {
  taskId: string;
  attempt: number;
  status: "completed" | "partial" | "blocked" | "failed";
  changedFiles: string[];
  validationResults: ValidationResult[];
  blockers: string[];
  summary: string;
}

export type EvaluationDecisionKind =
  | "accepted"
  | "needs-repair"
  | "blocked"
  | "needs-human-review"
  | "rejected-out-of-scope";

export interface EvaluationDecision {
  schemaVersion: 1;
  taskId: string;
  attempt: number;
  decision: EvaluationDecisionKind;
  reasons: string[];
  requiredValidation?: ValidationCommand[];
}
