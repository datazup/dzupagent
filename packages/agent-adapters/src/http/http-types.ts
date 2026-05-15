/**
 * HTTP types for the AdapterHttpHandler.
 *
 * Framework-agnostic request/response contracts, request body shapes,
 * approval-gate interface, token validation, and the AdapterHttpConfig
 * consumed by AdapterHttpHandler.
 */

import type { DzupEventBus } from '@dzupagent/core/events'

import type { OrchestratorFacade } from '../facade/orchestrator-facade.js'
import type {
  AdapterProviderId,
  AgentPolicyConformanceMode,
} from '../types.js'
import type { RateLimitConfig } from './rate-limiter.js'

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

/** Framework-agnostic request */
export interface HttpRequest {
  method: string
  path: string
  body: unknown
  headers: Record<string, string | undefined>
  query?: Record<string, string | undefined>
}

/** Framework-agnostic JSON response */
export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

/** SSE streaming response */
export interface HttpStreamResponse {
  status: number
  headers: Record<string, string>
  stream: AsyncGenerator<string, void, undefined>
}

export type HttpResult = HttpResponse | HttpStreamResponse

// ---------------------------------------------------------------------------
// Request body types
// ---------------------------------------------------------------------------

export interface RunRequestBody {
  prompt: string
  tags?: string[] | undefined
  preferredProvider?: AdapterProviderId | undefined
  workingDirectory?: string | undefined
  systemPrompt?: string | undefined
  maxTurns?: number | undefined
  policyConformanceMode?: AgentPolicyConformanceMode | undefined
  stream?: boolean | undefined
}

export interface SupervisorRequestBody {
  goal: string
  maxConcurrentDelegations?: number | undefined
  stream?: boolean | undefined
}

export interface ParallelRequestBody {
  prompt: string
  providers?: AdapterProviderId[] | undefined
  strategy?: 'first-wins' | 'all' | 'best-of-n' | undefined
  stream?: boolean | undefined
}

export interface BidRequestBody {
  prompt: string
  tags?: string[] | undefined
}

export interface ApprovalRequestBody {
  approved: boolean
  approvedBy?: string | undefined
  reason?: string | undefined
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down'
  adapters: Record<string, { healthy: boolean; circuitState?: string }>
  costReport?: unknown | undefined
}

// ---------------------------------------------------------------------------
// Approval gate interface
// ---------------------------------------------------------------------------

/** Pluggable approval gate for guarded endpoints */
export interface AdapterApprovalGate {
  /** Grant approval for a pending request */
  grant(requestId: string, approvedBy?: string, reason?: string): Promise<boolean>
  /** Reject a pending request */
  reject(requestId: string, reason?: string): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

export interface TokenValidationResult {
  valid: boolean
  identity?: string | undefined
  scopes?: string[] | undefined
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AdapterHttpConfig {
  /** The orchestrator facade to expose */
  orchestrator: OrchestratorFacade
  /** Optional approval gate for guarded endpoints */
  approvalGate?: AdapterApprovalGate | undefined
  /** Event bus */
  eventBus?: DzupEventBus | undefined
  /** API key validation function. If provided, all requests must pass. */
  validateApiKey?: (key: string) => boolean | Promise<boolean>
  /** Custom async token validator. Takes precedence over validateApiKey. */
  tokenValidator?: (token: string) => Promise<TokenValidationResult>
  /** Endpoints that don't require auth (e.g., '/health') */
  publicEndpoints?: string[] | undefined
  /** Rate limit configuration. If set, enables rate limiting. */
  rateLimit?: Partial<RateLimitConfig> | undefined
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Type guard: is this result a streaming response? */
export function isStreamResponse(result: HttpResult): result is HttpStreamResponse {
  return 'stream' in result
}
