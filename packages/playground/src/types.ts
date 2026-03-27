/**
 * Shared types for the DzipAgent Playground SPA.
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
