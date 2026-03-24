/**
 * Abstract persistence interfaces for ForgeAgent.
 *
 * Core defines interfaces; implementations live in consumer packages:
 * - InMemoryRunStore / InMemoryAgentStore (core — for dev/test)
 * - PostgresRunStore / PostgresAgentStore (@forgeagent/server)
 */

// ---------------------------------------------------------------------------
// Run Store
// ---------------------------------------------------------------------------

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'approved'
  | 'completed'
  | 'failed'
  | 'rejected'
  | 'cancelled'

export interface Run {
  id: string
  agentId: string
  status: RunStatus
  input: unknown
  output?: unknown
  plan?: unknown
  tokenUsage?: { input: number; output: number }
  costCents?: number
  error?: string
  metadata?: Record<string, unknown>
  startedAt: Date
  completedAt?: Date
}

export interface CreateRunInput {
  agentId: string
  input: unknown
  metadata?: Record<string, unknown>
}

export interface RunFilter {
  agentId?: string
  status?: RunStatus
  limit?: number
  offset?: number
}

export interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'debug'
  phase?: string
  message: string
  data?: unknown
  timestamp?: Date
}

export interface RunStore {
  create(input: CreateRunInput): Promise<Run>
  update(id: string, update: Partial<Run>): Promise<void>
  get(id: string): Promise<Run | null>
  list(filter?: RunFilter): Promise<Run[]>
  addLog(runId: string, entry: LogEntry): Promise<void>
  getLogs(runId: string): Promise<LogEntry[]>
}

// ---------------------------------------------------------------------------
// Agent Store
// ---------------------------------------------------------------------------

export interface AgentDefinition {
  id: string
  name: string
  description?: string
  instructions: string
  modelTier: string
  tools?: string[]
  guardrails?: Record<string, unknown>
  approval?: 'auto' | 'required' | 'conditional'
  version?: number
  active?: boolean
  metadata?: Record<string, unknown>
  createdAt?: Date
  updatedAt?: Date
}

export interface AgentFilter {
  active?: boolean
  tags?: string[]
  limit?: number
}

export interface AgentStore {
  save(agent: AgentDefinition): Promise<void>
  get(id: string): Promise<AgentDefinition | null>
  list(filter?: AgentFilter): Promise<AgentDefinition[]>
  delete(id: string): Promise<void>
}
