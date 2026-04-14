/**
 * Neutral runtime contracts shared by scheduler and execution ledger runtimes.
 * These types are intentionally domain-agnostic and do not depend on
 * workflow orchestration services.
 */

// ---------------------------------------------------------------------------
// Persona & feature planning domain model
// ---------------------------------------------------------------------------

export type PersonaRoleType =
  | 'architect'
  | 'backend_dev'
  | 'frontend_dev'
  | 'tester'
  | 'designer'
  | 'data_modeler'
  | 'devops'
  | 'security'
  | 'analyst'
  | 'custom'

/**
 * High-level description of a feature to be built.
 * Produced by the brainstorming / decomposition phase.
 */
export interface FeatureBrief {
  id: string
  title: string
  /** Problem statement this feature solves */
  problem: string
  /** Constraints (technical, business, time) */
  constraints: string[]
  /** Measurable acceptance criteria */
  acceptanceCriteria: string[]
  /** Priority level */
  priority: 'critical' | 'high' | 'medium' | 'low'
  /** Who created this brief */
  createdBy: string
  createdAt: number
  updatedAt: number
}

/**
 * A single unit of work derived from a FeatureBrief.
 * Assigned to a PersonaProfile for execution.
 */
export interface WorkItem {
  id: string
  /** Parent feature */
  featureId: string
  title: string
  description: string
  /** IDs of WorkItems that must complete before this one */
  dependsOn: string[]
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled'
  /** Rough story-point estimate */
  estimate?: number | undefined
  /** Assigned persona ID */
  assignedPersonaId?: string | undefined
  createdAt: number
  updatedAt: number
}

/**
 * A reusable role definition that can be assigned to WorkItems.
 * Maps to a set of Skills and a set of guardrails.
 */
export interface PersonaProfile {
  id: string
  name: string
  roleType: PersonaRoleType
  description: string
  /** High-level capability tags (e.g., 'sql', 'react', 'testing') */
  capabilities: string[]
  /** Skill tags this persona prefers */
  preferredTags: string[]
  /** Hard guardrails: things this persona must/must not do */
  guardrails: string[]
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Execution runtime contracts
// ---------------------------------------------------------------------------

export type ExecutionRunStatus =
  | 'queued'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled'

export interface ExecutionRun {
  id: string
  taskId: string
  workflowRunId: string
  providerId: string
  model?: string
  status: ExecutionRunStatus
  input: string
  result?: string
  error?: string
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  costCents?: number
  startedAt: number
  completedAt?: number
  durationMs?: number
}

export type PromptType = 'system' | 'user' | 'expanded' | 'tool_context' | 'retry'

export interface PromptRecord {
  id: string
  executionRunId: string
  promptType: PromptType
  rawPrompt: string
  resolvedPrompt?: string
  templateId?: string
  templateVersion?: number
  tokenEstimate?: number
  hashSha256: string
  createdAt: number
}

export type BudgetBucket = 'task' | 'workflow' | 'project'

export interface CostLedgerEntry {
  id: string
  executionRunId: string
  workflowRunId?: string
  taskId?: string
  projectId?: string
  providerId: string
  model: string
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  costCents: number
  currency: string
  budgetBucket: BudgetBucket
  recordedAt: number
}

export type ArtifactType = 'plan' | 'report' | 'patch' | 'log' | 'diff' | 'spec' | 'brief'

export interface Artifact {
  id: string
  workflowRunId?: string
  taskId?: string
  executionRunId?: string
  type: ArtifactType
  name: string
  content: string
  mimeType?: string
  sizeBytes: number
  checksum?: string
  createdAt: number
}

export type ScheduleType = 'immediate' | 'delayed' | 'recurring' | 'event_triggered'

export interface WorkflowSchedule {
  id: string
  workflowTemplateId: string
  scheduleType: ScheduleType
  scheduleExpression?: string
  triggerEvent?: string
  context: Record<string, unknown>
  enabled: boolean
  lastRunAt?: number
  nextRunAt?: number
  createdBy: string
  createdAt: number
  updatedAt: number
}
