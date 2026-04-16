/**
 * Abstract persistence interfaces for DzupAgent.
 *
 * Core defines interfaces; implementations live in consumer packages:
 * - InMemoryRunStore / InMemoryAgentStore (core — for dev/test)
 * - PostgresRunStore / PostgresAgentStore (@dzupagent/server)
 */

// ---------------------------------------------------------------------------
// Run Store
// ---------------------------------------------------------------------------

export type RunStatus =
  | 'pending'            // initial state before queuing
  | 'queued'             // queued for execution
  | 'running'            // actively running
  | 'executing'          // adapter-level active execution
  | 'awaiting_approval'  // paused, waiting for human approval
  | 'approved'           // approval given, ready to resume
  | 'paused'             // Wave 9: cooperative pause via RunHandle
  | 'suspended'          // Wave 9: workflow-level suspension
  | 'completed'          // terminal: success
  | 'failed'             // terminal: error
  | 'rejected'           // terminal: approval rejected
  | 'cancelled'          // terminal: user-cancelled

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

/**
 * Canonical run persistence interface for DzupAgent.
 *
 * This is THE single RunStore definition. Server routes, test-utils, and all
 * new code should use this interface. Implementations:
 * - `InMemoryRunStore`  (core — dev/test, in `in-memory-store.ts`)
 * - `PostgresRunStore`  (@dzupagent/server)
 *
 * Note: The legacy `RunRecordStore` in `run-store.ts` tracks low-level LLM
 * execution records and is a separate concern.
 */
export interface RunStore {
  create(input: CreateRunInput): Promise<Run>
  update(id: string, update: Partial<Run>): Promise<void>
  get(id: string): Promise<Run | null>
  list(filter?: RunFilter): Promise<Run[]>
  addLog(runId: string, entry: LogEntry): Promise<void>
  addLogs(runId: string, entries: LogEntry[]): Promise<void>
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
