export const DYNAMIC_WORKFLOW_SCHEMA_VERSION = "dzup.dynamic-workflow.v1" as const;

export type DynamicWorkflowProvider = "claude" | "codex";

export type DynamicWorkflowSandboxMode = "read-only" | "workspace-write";

export type DynamicWorkflowApprovalPolicy = "untrusted" | "on-request" | "never";

export type DynamicWorkflowNetworkAccess =
  | "disabled"
  | "allowlisted"
  | "enabled";

export type DynamicWorkflowRole =
  | "workflow-designer"
  | "research-synthesizer"
  | "implementation-worker"
  | "code-reviewer"
  | "test-repair-worker"
  | "security-reviewer"
  | "product-flow-author"
  | "judge";

export type DynamicWorkflowArtifactKind =
  | "json"
  | "markdown"
  | "jsonl"
  | "patch"
  | "text";

export type DynamicWorkflowCheckpointMode =
  | "none"
  | "after-each-worker"
  | "after-each-node";

export type DynamicWorkflowEventType =
  | "workflow.started"
  | "workflow.completed"
  | "workflow.failed"
  | "worker.started"
  | "worker.output"
  | "worker.completed"
  | "worker.failed"
  | "tool.requested"
  | "tool.completed"
  | "approval.requested"
  | "approval.decided"
  | "checkpoint.saved"
  | "artifact.written";

export interface DynamicWorkflowSpec {
  schemaVersion: typeof DYNAMIC_WORKFLOW_SCHEMA_VERSION;
  runIntent: DynamicWorkflowRunIntent;
  policy: DynamicWorkflowPolicy;
  providers: DynamicWorkflowProviderRoute[];
  workers: DynamicWorkflowWorker[];
  graph: DynamicWorkflowGraph;
  artifacts: DynamicWorkflowArtifactRequirement[];
  checkpoints: DynamicWorkflowCheckpointPolicy;
}

export interface DynamicWorkflowRunIntent {
  topic: string;
  targetRepos: string[];
  objective: string;
  successCriteria: string[];
  nonGoals: string[];
}

export interface DynamicWorkflowPolicy {
  sandboxMode: DynamicWorkflowSandboxMode;
  approvalPolicy: DynamicWorkflowApprovalPolicy;
  networkAccess: DynamicWorkflowNetworkAccess;
  maxCostUsd?: number;
  maxWallClockMinutes?: number;
  allowedCommands: string[];
  allowedMcpTools: string[];
}

export interface DynamicWorkflowProviderRoute {
  provider: DynamicWorkflowProvider;
  roles: DynamicWorkflowRole[];
  model: string;
}

export interface DynamicWorkflowWorker {
  workerId: string;
  role: DynamicWorkflowRole;
  provider: DynamicWorkflowProvider;
  objective: string;
  targetRepos: string[];
  toolScope: {
    commands: string[];
    mcpTools: string[];
  };
}

export interface DynamicWorkflowGraph {
  nodes: string[];
  edges: Array<{
    from: string;
    to: string;
    condition?: string;
  }>;
}

export interface DynamicWorkflowArtifactRequirement {
  path: string;
  kind: DynamicWorkflowArtifactKind;
  required: boolean;
}

export interface DynamicWorkflowCheckpointPolicy {
  mode: DynamicWorkflowCheckpointMode;
  required: boolean;
}

export interface DynamicWorkflowEvent {
  runId: string;
  workerId?: string;
  nodeId?: string;
  timestamp: string;
  type: DynamicWorkflowEventType;
  payload: unknown;
}
