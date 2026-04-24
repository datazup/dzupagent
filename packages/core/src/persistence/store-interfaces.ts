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
  | 'halted'             // terminal: clean halt (e.g. token exhaustion)
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
  /**
   * Identifier of the API key (or other principal) that created this run.
   * Used by the server routes to scope list/get/cancel/pause/resume access
   * so one tenant's API key cannot manage another's runs. Nullable for
   * backward compatibility with records created before tenant scoping.
   */
  ownerId?: string | null
  /**
   * MC-S02: Tenant scope for this run. Populated from the authenticated
   * API key's `tenantId`. Used by the server to filter listings so keys
   * from different tenants cannot observe each other's runs. Defaults to
   * `'default'` for pre-migration rows and single-tenant deployments.
   */
  tenantId?: string | null
  startedAt: Date
  completedAt?: Date
}

export interface CreateRunInput {
  agentId: string
  input: unknown
  metadata?: Record<string, unknown>
  /** See {@link Run.ownerId}. */
  ownerId?: string | null
  /** See {@link Run.tenantId}. */
  tenantId?: string | null
}

export interface RunFilter {
  agentId?: string
  status?: RunStatus
  limit?: number
  offset?: number
  /** MC-S02: Restrict listings to a single tenant scope. */
  tenantId?: string
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
  /**
   * Count the total number of runs matching `filter` (ignoring `limit`/`offset`).
   *
   * Used by GET /api/runs to return a `total` alongside the paginated `data`,
   * enabling UIs to render accurate pagination controls without having to fetch
   * the entire result set.
   *
   * Optional: implementations that predate this interface method will cause
   * callers to fall back to `list(...).length` (page size), which is not the
   * true total. All first-party stores (`InMemoryRunStore`, `PostgresRunStore`,
   * `RunJournalBridgeRunStore`) implement this method.
   */
  count?(filter?: RunFilter): Promise<number>
  addLog(runId: string, entry: LogEntry): Promise<void>
  addLogs(runId: string, entries: LogEntry[]): Promise<void>
  getLogs(runId: string): Promise<LogEntry[]>
}

// ---------------------------------------------------------------------------
// Agent Execution Spec Store
// ---------------------------------------------------------------------------

/**
 * Local runnable agent configuration used by the current execution path.
 *
 * This is intentionally distinct from the control-plane `RegisteredAgent`
 * model used by `AgentRegistry`.
 */
export interface AgentExecutionSpec {
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
  /**
   * MC-S02: Tenant scope for this agent definition. Defaults to `'default'`.
   */
  tenantId?: string | null
  createdAt?: Date
  updatedAt?: Date
}

export interface AgentExecutionSpecFilter {
  active?: boolean
  tags?: string[]
  limit?: number
  /** MC-S02: Restrict listings to a single tenant scope. */
  tenantId?: string
}

export interface AgentExecutionSpecStore {
  save(agent: AgentExecutionSpec): Promise<void>
  get(id: string): Promise<AgentExecutionSpec | null>
  list(filter?: AgentExecutionSpecFilter): Promise<AgentExecutionSpec[]>
  delete(id: string): Promise<void>
}

/** @deprecated Use `AgentExecutionSpec`. */
export type AgentDefinition = AgentExecutionSpec

/** @deprecated Use `AgentExecutionSpecFilter`. */
export type AgentFilter = AgentExecutionSpecFilter

/** @deprecated Use `AgentExecutionSpecStore`. */
export type AgentStore = AgentExecutionSpecStore
