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
