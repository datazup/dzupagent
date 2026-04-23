import type { Request, Response, NextFunction } from 'express'
import type { DzupAgent, GenerateResult } from '@dzupagent/agent'
import type {
  MCPRequest,
  MCPRequestId,
  MCPResponse,
  MCPToolDescriptor,
  MCPResource,
  MCPResourceTemplate,
} from '@dzupagent/core'

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
 * Result collected from streaming a DzupAgent to completion.
 */
export interface AgentResult {
  /** Full accumulated text content */
  content: string
  /** Token usage if reported by the agent */
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined
  /** Estimated cost in USD if reported */
  cost?: number | undefined
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
  /** Map of agent name to DzupAgent instance */
  agents: Record<string, DzupAgent>
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

/**
 * Minimal MCP server surface expected by the shared Express MCP router.
 */
export interface MCPRequestHandler {
  handleRequest(request: MCPRequest): Promise<MCPResponse | null>
  listTools(): MCPToolDescriptor[]
  listResources?(): MCPResource[]
  listResourceTemplates?(): MCPResourceTemplate[]
}

export type MCPRequestHandlerResolver =
  | MCPRequestHandler
  | ((req: Request) => MCPRequestHandler | Promise<MCPRequestHandler>)

export interface MCPAuthFailurePayload {
  error: string
  message: string
  timestamp: string
}

export interface MCPAuthFailureContext {
  req: Request
  res: Response
  reason: 'missing_credentials' | 'invalid_credentials'
}

export type MCPRequestContextResolver<TContext> = (
  credential: string,
  req: Request,
) => Promise<TContext | null | undefined> | TContext | null | undefined

export type MCPRequestContextAssigner<TContext> = (req: Request, context: TContext) => void

export type MCPRequestContextFailureHandler = (
  context: MCPAuthFailureContext,
) => void | Promise<void>

export interface MCPRequestContextAuthConfig<TContext> {
  resolveContext: MCPRequestContextResolver<TContext>
  assign?: MCPRequestContextAssigner<TContext>
  credentialHeader?: string
  allowBearerAuth?: boolean
  missingCredentialMessage?: string
  invalidCredentialMessage?: string
  onAuthFailure?: MCPRequestContextFailureHandler
}

/**
 * Configuration for the Express MCP router factory.
 */
export interface MCPRouterConfig {
  /** MCP server instance or request-scoped compatible handler */
  server: MCPRequestHandlerResolver
  /** Express auth middleware to apply to all MCP routes */
  auth?: (req: Request, res: Response, next: NextFunction) => void
  /** Base path for the JSON-RPC endpoint and helper routes. Default: '/mcp' */
  basePath?: string
  /** Optional route toggles for metadata/listing endpoints */
  expose?: {
    tools?: boolean
    resources?: boolean
    resourceTemplates?: boolean
  }
  /** Lifecycle hooks */
  hooks?: {
    beforeRequest?: (req: Request, request: MCPRequest) => Promise<void> | void
    afterRequest?: (
      req: Request,
      request: MCPRequest,
      response: MCPResponse | null,
    ) => Promise<void> | void
    onError?: (
      req: Request,
      error: Error,
      requestId: MCPRequestId,
    ) => Promise<void> | void
  }
}
