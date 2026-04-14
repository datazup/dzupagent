import type { RunStore, RunRecord, StoredRunEvent, RunFilters } from './run-store.js'

/**
 * In-memory run store for development and testing.
 * Data is lost on process restart.
 */
export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, RunRecord>()
  private readonly events = new Map<string, StoredRunEvent[]>()

  async createRun(run: RunRecord): Promise<string> {
    const id = run.id || crypto.randomUUID()
    this.runs.set(id, { ...run, id })
    this.events.set(id, [])
    return id
  }

  async updateRun(runId: string, update: Partial<RunRecord>): Promise<void> {
    const existing = this.runs.get(runId)
    if (!existing) return
    this.runs.set(runId, { ...existing, ...update, id: runId })
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.runs.get(runId)
  }

  async listRuns(filters?: RunFilters): Promise<RunRecord[]> {
    let result = [...this.runs.values()]
    if (filters?.status) result = result.filter(r => r.status === filters.status)
    if (filters?.providerId) result = result.filter(r => r.providerId === filters.providerId)
    if (filters?.since) result = result.filter(r => r.createdAt >= filters.since!)
    if (filters?.until) result = result.filter(r => r.createdAt <= filters.until!)
    if (filters?.tags?.length) {
      const tags = new Set(filters.tags)
      result = result.filter(r => r.tags?.some(t => tags.has(t)))
    }
    if (filters?.correlationId) result = result.filter(r => r.correlationId === filters.correlationId)
    // Sort by createdAt descending
    result.sort((a, b) => b.createdAt - a.createdAt)
    if (filters?.offset) result = result.slice(filters.offset)
    if (filters?.limit) result = result.slice(0, filters.limit)
    return result
  }

  async storeEvent(runId: string, event: StoredRunEvent): Promise<void> {
    const events = this.events.get(runId) ?? []
    events.push(event)
    this.events.set(runId, events)
  }

  async getEvents(runId: string, options?: { limit?: number; offset?: number }): Promise<StoredRunEvent[]> {
    let events = this.events.get(runId) ?? []
    if (options?.offset) events = events.slice(options.offset)
    if (options?.limit) events = events.slice(0, options.limit)
    return events
  }

  async deleteRun(runId: string): Promise<boolean> {
    const existed = this.runs.has(runId)
    this.runs.delete(runId)
    this.events.delete(runId)
    return existed
  }

  /** Get total number of runs (for testing) */
  get size(): number {
    return this.runs.size
  }

  /** Clear all data */
  clear(): void {
    this.runs.clear()
    this.events.clear()
  }
}
