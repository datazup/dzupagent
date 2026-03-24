import type {
  RunStore,
  Run,
  CreateRunInput,
  RunFilter,
  LogEntry,
  AgentStore,
  AgentDefinition,
  AgentFilter,
} from './store-interfaces.js'

// ---------------------------------------------------------------------------
// InMemoryRunStore — for development and testing (no database required)
// ---------------------------------------------------------------------------

export class InMemoryRunStore implements RunStore {
  private runs = new Map<string, Run>()
  private logs = new Map<string, LogEntry[]>()

  async create(input: CreateRunInput): Promise<Run> {
    const run: Run = {
      id: crypto.randomUUID(),
      agentId: input.agentId,
      status: 'queued',
      input: input.input,
      metadata: input.metadata ?? {},
      startedAt: new Date(),
    }
    this.runs.set(run.id, run)
    this.logs.set(run.id, [])
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

  async addLog(runId: string, entry: LogEntry): Promise<void> {
    const list = this.logs.get(runId)
    if (!list) return
    list.push({ ...entry, timestamp: entry.timestamp ?? new Date() })
  }

  async getLogs(runId: string): Promise<LogEntry[]> {
    return this.logs.get(runId) ?? []
  }

  /** Clear all data (for test teardown) */
  clear(): void {
    this.runs.clear()
    this.logs.clear()
  }
}

// ---------------------------------------------------------------------------
// InMemoryAgentStore — for development and testing
// ---------------------------------------------------------------------------

export class InMemoryAgentStore implements AgentStore {
  private agents = new Map<string, AgentDefinition>()

  async save(agent: AgentDefinition): Promise<void> {
    this.agents.set(agent.id, { ...agent, updatedAt: new Date() })
  }

  async get(id: string): Promise<AgentDefinition | null> {
    return this.agents.get(id) ?? null
  }

  async list(filter?: AgentFilter): Promise<AgentDefinition[]> {
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
