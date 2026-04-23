import type {
  RunStore,
  Run,
  CreateRunInput,
  RunFilter,
  LogEntry,
  AgentExecutionSpecStore,
  AgentExecutionSpec,
  AgentExecutionSpecFilter,
} from './store-interfaces.js'
import { defaultLogger, type FrameworkLogger } from '../utils/logger.js'

// ---------------------------------------------------------------------------
// InMemoryRunStore — for development and testing (no database required)
// ---------------------------------------------------------------------------

export interface InMemoryRunStoreOptions {
  /** Maximum number of runs retained (default: 10_000). Use `Infinity` to opt out. */
  maxRuns?: number
  /** Maximum number of log entries retained per run (default: 1_000). Use `Infinity` to opt out. */
  maxLogsPerRun?: number
}

const DEFAULT_MAX_RUNS = 10_000
const DEFAULT_MAX_LOGS_PER_RUN = 1_000

function attachRetentionMetadata(
  target: object,
  limits: { maxRuns: number; maxLogsPerRun: number },
  explicitUnbounded: boolean,
): void {
  Object.defineProperty(target, '__dzupagentRetention', {
    value: {
      ...limits,
      explicitUnbounded,
    },
    configurable: true,
    enumerable: false,
    writable: true,
  })
}

const logger: FrameworkLogger = defaultLogger

function warnIfExplicitlyUnbounded(limitName: string): void {
  logger.warn(
    `[InMemoryRunStore] ${limitName} is configured as unbounded. ` +
      'This is intended for explicit development/test opt-out only.',
  )
}

export class InMemoryRunStore implements RunStore {
  private runs = new Map<string, Run>()
  private logs = new Map<string, LogEntry[]>()
  private readonly runOrder: string[] = []
  private readonly maxRuns: number
  private readonly maxLogsPerRun: number

  constructor(options?: InMemoryRunStoreOptions) {
    if (options?.maxRuns === Number.POSITIVE_INFINITY) {
      warnIfExplicitlyUnbounded('maxRuns')
    }
    if (options?.maxLogsPerRun === Number.POSITIVE_INFINITY) {
      warnIfExplicitlyUnbounded('maxLogsPerRun')
    }

    this.maxRuns = options?.maxRuns ?? DEFAULT_MAX_RUNS
    this.maxLogsPerRun = options?.maxLogsPerRun ?? DEFAULT_MAX_LOGS_PER_RUN
    attachRetentionMetadata(this, this.getRetentionLimits(), Boolean(
      options?.maxRuns === Number.POSITIVE_INFINITY ||
      options?.maxLogsPerRun === Number.POSITIVE_INFINITY,
    ))
  }

  getRetentionLimits(): { maxRuns: number; maxLogsPerRun: number } {
    return {
      maxRuns: this.maxRuns,
      maxLogsPerRun: this.maxLogsPerRun,
    }
  }

  async create(input: CreateRunInput): Promise<Run> {
    const run: Run = {
      id: crypto.randomUUID(),
      agentId: input.agentId,
      status: 'queued',
      input: input.input,
      metadata: input.metadata ?? {},
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      startedAt: new Date(),
    }
    this.runs.set(run.id, run)
    this.logs.set(run.id, [])
    this.runOrder.push(run.id)
    this.enforceRunLimit()
    return run
  }

  async update(id: string, update: Partial<Run>): Promise<void> {
    const existing = this.runs.get(id)
    if (!existing) return
    this.runs.set(id, { ...existing, ...update })
  }

  async get(id: string): Promise<Run | null> {
    return this.runs.get(id) ?? null
  }

  async list(filter?: RunFilter): Promise<Run[]> {
    let results = [...this.runs.values()]

    if (filter?.agentId) {
      results = results.filter(r => r.agentId === filter.agentId)
    }
    if (filter?.status) {
      results = results.filter(r => r.status === filter.status)
    }

    // Sort by startedAt descending
    results.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())

    const offset = filter?.offset ?? 0
    const limit = filter?.limit ?? 50
    return results.slice(offset, offset + limit)
  }

  async count(filter?: RunFilter): Promise<number> {
    let results = [...this.runs.values()]

    if (filter?.agentId) {
      results = results.filter(r => r.agentId === filter.agentId)
    }
    if (filter?.status) {
      results = results.filter(r => r.status === filter.status)
    }

    return results.length
  }

  async addLog(runId: string, entry: LogEntry): Promise<void> {
    const list = this.logs.get(runId)
    if (!list) return
    list.push({ ...entry, timestamp: entry.timestamp ?? new Date() })
    this.enforceLogLimit(list)
  }

  async addLogs(runId: string, entries: LogEntry[]): Promise<void> {
    const list = this.logs.get(runId)
    if (!list) return
    const now = new Date()
    for (const entry of entries) {
      list.push({ ...entry, timestamp: entry.timestamp ?? now })
    }
    this.enforceLogLimit(list)
  }

  async getLogs(runId: string): Promise<LogEntry[]> {
    return [...(this.logs.get(runId) ?? [])]
  }

  /** Clear all data (for test teardown) */
  clear(): void {
    this.runs.clear()
    this.logs.clear()
    this.runOrder.length = 0
  }

  private enforceRunLimit(): void {
    if (!Number.isFinite(this.maxRuns)) return
    while (this.runOrder.length > this.maxRuns) {
      const evictedRunId = this.runOrder.shift()
      if (!evictedRunId) break
      this.runs.delete(evictedRunId)
      this.logs.delete(evictedRunId)
    }
  }

  private enforceLogLimit(logEntries: LogEntry[]): void {
    if (!Number.isFinite(this.maxLogsPerRun)) return
    const overflow = logEntries.length - this.maxLogsPerRun
    if (overflow <= 0) return
    logEntries.splice(0, overflow)
  }
}

// ---------------------------------------------------------------------------
// InMemoryAgentStore — for development and testing
// ---------------------------------------------------------------------------

export class InMemoryAgentStore implements AgentExecutionSpecStore {
  private agents = new Map<string, AgentExecutionSpec>()

  async save(agent: AgentExecutionSpec): Promise<void> {
    this.agents.set(agent.id, { ...agent, updatedAt: new Date() })
  }

  async get(id: string): Promise<AgentExecutionSpec | null> {
    return this.agents.get(id) ?? null
  }

  async list(filter?: AgentExecutionSpecFilter): Promise<AgentExecutionSpec[]> {
    let results = [...this.agents.values()]

    if (filter?.active !== undefined) {
      results = results.filter(a => a.active === filter.active)
    }

    const limit = filter?.limit ?? 100
    return results.slice(0, limit)
  }

  async delete(id: string): Promise<void> {
    this.agents.delete(id)
  }

  /** Clear all data (for test teardown) */
  clear(): void {
    this.agents.clear()
  }
}
