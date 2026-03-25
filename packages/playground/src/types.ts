/**
 * Shared types for the ForgeAgent Playground SPA.
 */

/** Chat message roles */
export type MessageRole = 'user' | 'assistant' | 'system'

/** A single chat message */
export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  timestamp: string
}

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

/** Trace event for the inspector timeline */
export interface TraceEvent {
  id: string
  type: 'llm' | 'tool' | 'memory' | 'guardrail' | 'system'
  name: string
  startedAt: string
  durationMs: number
  metadata?: Record<string, unknown>
}

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

/** Agent definition for the selector */
export interface AgentSummary {
  id: string
  name: string
  description?: string
  modelTier: string
  active: boolean
}

/** Agent config displayed in the config tab */
export interface AgentConfig {
  id: string
  name: string
  instructions: string
  modelTier: string
  tools?: string[]
  guardrails?: Record<string, unknown>
  approval?: 'auto' | 'required' | 'conditional'
  metadata?: Record<string, unknown>
}

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
