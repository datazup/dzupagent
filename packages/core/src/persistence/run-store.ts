/**
 * Shared run persistence interface for DzupAgent.
 * Both @dzupagent/agent-adapters and @dzupagent/server can implement this.
 */

/** Status of a run */
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/** A single execution run record */
export interface RunRecord {
  id: string
  workflowId?: string
  providerId: string
  model?: string
  status: RunStatus
  prompt: string
  systemPrompt?: string
  result?: string
  error?: string
  inputTokens?: number
  outputTokens?: number
  costCents?: number
  durationMs?: number
  tags?: string[]
  correlationId?: string
  createdAt: number
  completedAt?: number
}

/** A stored event within a run */
export interface StoredRunEvent {
  id: string
  runId: string
  type: string
  data: unknown
  timestamp: number
}

/** Query filters for listing runs */
export interface RunFilters {
  status?: RunStatus
  providerId?: string
  since?: number
  until?: number
  tags?: string[]
  correlationId?: string
  limit?: number
  offset?: number
}

/** Persistent storage backend for execution runs */
export interface RunStore {
  createRun(run: RunRecord): Promise<string>
  updateRun(runId: string, update: Partial<RunRecord>): Promise<void>
  getRun(runId: string): Promise<RunRecord | undefined>
  listRuns(filters?: RunFilters): Promise<RunRecord[]>
  storeEvent(runId: string, event: StoredRunEvent): Promise<void>
  getEvents(runId: string, options?: { limit?: number; offset?: number }): Promise<StoredRunEvent[]>
  deleteRun(runId: string): Promise<boolean>
}
