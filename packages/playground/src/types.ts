/**
 * Shared types for the DzupAgent Playground SPA.
 */

// ── Chat ─────────────────────────────────────────────────

/** Chat message roles */
export type MessageRole = 'user' | 'assistant' | 'system'

/** A single chat message */
export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: string
}

// ── WebSocket ────────────────────────────────────────────

/** WebSocket connection states */
export type WsConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error'

/** WebSocket incoming event envelope */
export interface WsEvent {
  id?: string
  version?: string
  type: string
  runId?: string
  agentId?: string
  timestamp?: string
  payload?: Record<string, unknown>
  [key: string]: unknown
}

export interface WsSubscriptionFilter {
  runId?: string
  agentId?: string
  eventTypes?: string[]
}

// ── Trace ────────────────────────────────────────────────

/** Trace event for the inspector timeline */
export interface TraceEvent {
  id: string
  type: 'llm' | 'tool' | 'memory' | 'guardrail' | 'system'
  name: string
  startedAt: string
  durationMs: number
  metadata?: Record<string, unknown>
}

// ── Memory ───────────────────────────────────────────────

/** Memory namespace summary */
export interface MemoryNamespace {
  name: string
  recordCount: number
}

/** A single memory record */
export interface MemoryRecord {
  key: string
  value: unknown
  namespace: string
  createdAt?: string
  updatedAt?: string
}

/** Memory frame schema column definition */
export interface MemorySchemaColumn {
  name: string
  type: string
  nullable: boolean
  description?: string
}

/** Memory export request */
export interface MemoryExportRequest {
  format: 'json' | 'arrow'
  namespace?: string
  scope?: Record<string, string>
}

/** Memory import request */
export interface MemoryImportRequest {
  format: 'json' | 'arrow'
  mergeStrategy: 'overwrite' | 'skip' | 'merge'
  data: unknown
}

// ── Agent ────────────────────────────────────────────────

/** Agent definition for the selector */
export interface AgentSummary {
  id: string
  name: string
  description?: string
  modelTier: string
  active: boolean
}

/** Full agent definition from GET /api/agents/:id */
export interface AgentDetail extends AgentSummary {
  instructions: string
  tools?: string[]
  guardrails?: Record<string, unknown>
  approval?: 'auto' | 'required' | 'conditional'
  metadata?: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
}

/** Agent config displayed in the config tab (alias for backward compat) */
export type AgentConfig = AgentDetail

/** Input for creating a new agent */
export interface AgentCreateInput {
  name: string
  instructions: string
  modelTier: string
  description?: string
  tools?: string[]
  guardrails?: Record<string, unknown>
  approval?: 'auto' | 'required' | 'conditional'
  metadata?: Record<string, unknown>
}

/** Input for updating an agent */
export type AgentUpdateInput = Partial<AgentCreateInput> & { active?: boolean }

// ── Runs ─────────────────────────────────────────────────

/** Run status */
export type RunStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected'

/** Run history entry */
export interface RunHistoryEntry {
  id: string
  agentId: string
  status: string
  startedAt: string
  completedAt?: string
  durationMs?: number
  output?: unknown
  error?: string
}

/** Run log entry */
export interface RunLogEntry {
  timestamp: string
  level: string
  message: string
  metadata?: Record<string, unknown>
}

/** Token usage summary from trace */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  estimatedCost?: number
}

/** Full run trace response */
export interface RunTrace {
  events: Array<{
    message: string
    phase?: string
    timestamp?: string
    durationMs?: number
    metadata?: Record<string, unknown>
  }>
  toolCalls?: Array<{
    name: string
    input?: unknown
    output?: unknown
    durationMs?: number
  }>
  usage?: TokenUsage
}

// ── Evals ───────────────────────────────────────────────

export type EvalRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface EvalScorerResult {
  score: number
  pass: boolean
  reasoning?: string
}

export interface EvalCaseResult {
  caseId: string
  scorerResults: Array<{
    scorerName: string
    result: EvalScorerResult
  }>
  aggregateScore: number
  pass: boolean
}

export interface EvalRunResult {
  suiteId: string
  timestamp: string
  results: EvalCaseResult[]
  aggregateScore: number
  passRate: number
}

export interface EvalSuiteSummary {
  name: string
  description?: string
  cases?: Array<{ id: string }>
  scorers?: Array<{ name: string }>
}

export interface EvalRunError {
  code: string
  message: string
}

export interface EvalRunRecovery {
  previousStatus: 'running'
  previousStartedAt?: string
  recoveredAt: string
  reason: 'process-restart'
}

export interface EvalRunAttemptRecord {
  attempt: number
  status: EvalRunStatus
  queuedAt: string
  startedAt?: string
  completedAt?: string
  result?: EvalRunResult
  error?: EvalRunError
  recovery?: EvalRunRecovery
}

export interface EvalRunRecord {
  id: string
  suiteId: string
  suite: EvalSuiteSummary
  status: EvalRunStatus
  createdAt: string
  queuedAt: string
  startedAt?: string
  completedAt?: string
  result?: EvalRunResult
  error?: EvalRunError
  recovery?: EvalRunRecovery
  attemptHistory?: EvalRunAttemptRecord[]
  metadata?: Record<string, unknown>
  attempts: number
}

export interface EvalRunListMeta {
  service: string
  mode: 'active' | 'read-only'
  writable: boolean
  filters: {
    suiteId?: string
    status?: EvalRunStatus
    limit: number
  }
}

export interface EvalRunListResponse {
  success: boolean
  data: EvalRunRecord[]
  count: number
  meta: EvalRunListMeta
}

export interface EvalRunResponse {
  success: boolean
  data: EvalRunRecord
}

export interface EvalHealth {
  service: string
  status: string
  mode: 'active' | 'read-only'
  writable: boolean
  endpoints: string[]
}

export interface EvalHealthResponse {
  success: boolean
  data: EvalHealth
}

export interface EvalQueueStats {
  pending: number
  active: number
  oldestPendingAgeMs: number | null
  enqueued: number
  started: number
  completed: number
  failed: number
  cancelled: number
  retried: number
  recovered: number
  requeued: number
}

export interface EvalQueueStatsResponse {
  success: boolean
  data: {
    service: string
    mode: 'active' | 'read-only'
    writable: boolean
    queue: EvalQueueStats
  }
}

// ── Benchmarks ───────────────────────────────────────────

export interface BenchmarkResult {
  suiteId: string
  timestamp: string
  scores: Record<string, number>
  passedBaseline: boolean
  regressions: string[]
}

export interface BenchmarkRunArtifact {
  suiteVersion?: string
  datasetHash?: string
  promptConfigVersion?: string
  promptVersion?: string
  configVersion?: string
  buildSha?: string
  modelProfile?: string
}

export interface BenchmarkRunRecord {
  id: string
  suiteId: string
  targetId: string
  result: BenchmarkResult
  createdAt: string
  strict: boolean
  metadata?: Record<string, unknown>
  artifact?: BenchmarkRunArtifact
}

export interface BenchmarkRunListQuery {
  suiteId?: string
  targetId?: string
  limit?: number
  cursor?: string
}

export interface BenchmarkRunListMeta {
  filters: {
    suiteId?: string
    targetId?: string
    limit: number
    cursor?: string
  }
  pagination?: {
    cursor?: string
    hasMore: boolean
    nextCursor: string | null
  }
  hasMore?: boolean
  nextCursor?: string | null
}

export interface BenchmarkRunListResponse {
  success: boolean
  data: BenchmarkRunRecord[]
  count: number
  meta: BenchmarkRunListMeta
}

export interface BenchmarkBaselineRecord {
  suiteId: string
  targetId: string
  runId: string
  result: BenchmarkResult
  updatedAt: string
}

export interface BenchmarkComparison {
  improved: string[]
  regressed: string[]
  unchanged: string[]
}

export interface BenchmarkCompareRecord {
  currentRun: BenchmarkRunRecord
  previousRun: BenchmarkRunRecord
  comparison: BenchmarkComparison
}

export interface BenchmarkRunCreateInput {
  suiteId: string
  targetId: string
  strict?: boolean
  metadata?: Record<string, unknown>
  artifact?: BenchmarkRunArtifact
}

export interface BenchmarkRunResponse {
  success: boolean
  data: BenchmarkRunRecord
}

export interface BenchmarkCompareResponse {
  success: boolean
  data: BenchmarkCompareRecord
}

export interface BenchmarkBaselineListResponse {
  success: boolean
  data: BenchmarkBaselineRecord[]
  count: number
}

export interface BenchmarkBaselineResponse {
  success: boolean
  data: BenchmarkBaselineRecord
}

// ── Health ───────────────────────────────────────────────

/** Health check response */
export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error'
  version?: string
  uptime?: number
}

/** Readiness probe response */
export interface HealthReady {
  ready: boolean
  checks: Record<string, { status: 'ok' | 'error'; message?: string }>
}

/** Metrics response (opaque shape) */
export type HealthMetrics = Record<string, unknown>

// ── Marketplace ─────────────────────────────────────

/** Agent category in the marketplace */
export type MarketplaceCategory =
  | 'observability'
  | 'memory'
  | 'security'
  | 'codegen'
  | 'integration'
  | 'testing'

/** A plugin available in the agent marketplace */
export interface MarketplaceAgent {
  id: string
  name: string
  description: string
  version: string
  author: string
  category: MarketplaceCategory
  tags: string[]
  installed: boolean
  verified: boolean
  downloadCount?: number
  rating?: number
  repository?: string
}

// ── API ──────────────────────────────────────────────────

/** Standard API response wrapper */
export interface ApiResponse<T> {
  data: T
  count?: number
}

/** Standard API error response */
export interface ApiError {
  error: {
    code: string
    message: string
  }
}
