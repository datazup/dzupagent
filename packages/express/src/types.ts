import type { Request, Response, NextFunction } from 'express'
import type { DzipAgent, GenerateResult } from '@dzipagent/agent'

/**
 * A single SSE event to be written to the response stream.
 */
export interface SSEEvent {
  /** Event type sent as the SSE event field (e.g. 'chunk', 'tool_call', 'done') */
  type: string
  /** Event payload serialized as JSON in the SSE data field */
  data: unknown
  /** Optional SSE event id */
  id?: string
}

/**
 * Result collected from streaming a DzipAgent to completion.
 */
export interface AgentResult {
  /** Full accumulated text content */
  content: string
  /** Token usage if reported by the agent */
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
  /** Estimated cost in USD if reported */
  cost?: number
  /** Number of tool calls made during the stream */
  toolCalls: number
  /** Wall-clock duration in milliseconds */
  durationMs: number
}

/**
 * Configuration for SSE streaming behavior.
 */
export interface SSEHandlerConfig {
  /** Custom event formatter (default: standard SSE format) */
  formatEvent?: (event: SSEEvent) => string
  /** Additional headers to set on the SSE response */
  headers?: Record<string, string>
  /** Called when the client disconnects before the stream completes */
  onDisconnect?: (req: Request) => void
  /** Called when the stream completes successfully */
  onComplete?: (result: AgentResult, req: Request) => void | Promise<void>
  /** Called on stream error */
  onError?: (error: Error, req: Request, res: Response) => void
  /** Keep-alive interval in milliseconds (default: 15000) */
  keepAliveMs?: number
}

/**
 * Request body for the /chat and /chat/sync endpoints.
 */
export interface ChatRequestBody {
  /** The user's message */
  message: string
  /** Which agent to use (default: first in config) */
  agentName?: string
  /** Conversation ID for multi-turn context */
  conversationId?: string
  /** Model override */
  model?: string
  /** Extra configurable params passed to the agent */
  configurable?: Record<string, unknown>
}

/**
 * Configuration for the Express router factory.
 */
export interface AgentRouterConfig {
  /** Map of agent name to DzipAgent instance */
  agents: Record<string, DzipAgent>
  /** Express auth middleware to apply to all routes */
  auth?: (req: Request, res: Response, next: NextFunction) => void
  /** SSE streaming configuration */
  sse?: SSEHandlerConfig
  /** Lifecycle hooks */
  hooks?: {
    /** Called before the agent starts processing */
    beforeAgent?: (req: Request, agentName: string) => Promise<void> | void
    /** Called after the agent finishes (for both stream and sync) */
    afterAgent?: (req: Request, agentName: string, result: AgentResult | GenerateResult) => Promise<void> | void
    /** Called on errors */
    onError?: (req: Request, error: Error) => Promise<void> | void
  }
  /** Base path prefix (default: '/') */
  basePath?: string
}
