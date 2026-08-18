import type {
  AgentTaskRisk,
  AgentTaskRuntimePolicy,
  ValidationCommand,
  ValidationResult,
} from "../fleet/index.js";

/**
 * @deprecated Repository-delivery compatibility only. New delivery plans belong
 * to Scripts DeliveryBundle/ExecutionPlan contracts; use AgentTask for the
 * generic DzupAgent runtime boundary.
 */
export type ImplementationRunStatus =
  | "draft"
  | "running"
  | "paused"
  | "completed"
  | "blocked"
  | "cancelled";

/**
 * @deprecated Repository-delivery compatibility only. New delivery plans belong
 * to Scripts DeliveryBundle/ExecutionPlan contracts; use AgentTask for the
 * generic DzupAgent runtime boundary.
 */
export interface ImplementationRepoRef {
  id: string;
  path: string;
  instructions?: string[];
}

/**
 * @deprecated Repository-delivery compatibility only. New delivery plans belong
 * to Scripts DeliveryBundle/ExecutionPlan contracts; use AgentTask for the
 * generic DzupAgent runtime boundary.
 */
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

/**
 * @deprecated Repository-delivery compatibility only. New delivery plans belong
 * to Scripts DeliveryBundle/ExecutionPlan contracts; use AgentTask for the
 * generic DzupAgent runtime boundary.
 */
export interface ImplementationBatch {
  id: string;
  title: string;
  mode: "serial" | "parallel-repos";
  taskIds: string[];
  dependsOn?: string[];
}

/**
 * @deprecated Repository-delivery compatibility only. New delivery plans belong
 * to Scripts DeliveryBundle/ExecutionPlan contracts; use AgentTask for the
 * generic DzupAgent runtime boundary.
 */
export interface ImplementationPlanPolicy {
  maxAttemptsPerTask: number;
  repoConcurrency: number;
  highRiskRequiresApproval: boolean;
}

/**
 * @deprecated Repository-delivery compatibility only. New delivery plans belong
 * to Scripts DeliveryBundle/ExecutionPlan contracts; use AgentTask for the
 * generic DzupAgent runtime boundary.
 */
export interface ImplementationPlan {
  schemaVersion: 1;
  id: string;
  goal: string;
  repos: ImplementationRepoRef[];
  batches: ImplementationBatch[];
  tasks: ImplementationTask[];
  policy: ImplementationPlanPolicy;
}

/**
 * @deprecated Repository-delivery compatibility only. New delivery plans belong
 * to Scripts DeliveryBundle/ExecutionPlan contracts; use AgentTask for the
 * generic DzupAgent runtime boundary.
 */
export interface TaskAttempt {
  taskId: string;
  attempt: number;
  status: "completed" | "partial" | "blocked" | "failed";
  changedFiles: string[];
  validationResults: ValidationResult[];
  blockers: string[];
  summary: string;
}

/**
 * @deprecated Repository-delivery compatibility only. New delivery plans belong
 * to Scripts DeliveryBundle/ExecutionPlan contracts; use AgentTask for the
 * generic DzupAgent runtime boundary.
 */
export type EvaluationDecisionKind =
  | "accepted"
  | "needs-repair"
  | "blocked"
  | "needs-human-review"
  | "rejected-out-of-scope";

/**
 * @deprecated Repository-delivery compatibility only. New delivery plans belong
 * to Scripts DeliveryBundle/ExecutionPlan contracts; use AgentTask for the
 * generic DzupAgent runtime boundary.
 */
export interface EvaluationDecision {
  schemaVersion: 1;
  taskId: string;
  attempt: number;
  decision: EvaluationDecisionKind;
  reasons: string[];
  requiredValidation?: ValidationCommand[];
}
