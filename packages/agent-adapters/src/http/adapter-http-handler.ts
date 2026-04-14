/**
 * AdapterHttpHandler -- framework-agnostic HTTP handler that exposes
 * OrchestratorFacade endpoints.
 *
 * Does NOT depend on Express, Hono, or any HTTP framework. Instead it
 * defines a minimal HttpRequest/HttpResponse contract that any framework
 * adapter can map to.
 *
 * Routes:
 *   POST /run          — execute with auto-routing
 *   POST /supervisor   — supervisor pattern
 *   POST /parallel     — parallel execution
 *   POST /bid          — contract-net bidding
 *   POST /approve/:id  — approve/reject a pending request
 *   GET  /health       — adapter health status
 *   GET  /cost         — cost report
 */

import type { DzupEventBus } from '@dzupagent/core'
import type { z } from 'zod'

import type { OrchestratorFacade } from '../facade/orchestrator-facade.js'
import type { RateLimitConfig } from './rate-limiter.js'
import { SlidingWindowRateLimiter } from './rate-limiter.js'
import { StreamingHandler } from '../streaming/streaming-handler.js'
import type { AdapterProviderId, AgentCompletedEvent, AgentEvent, AgentInput } from '../types.js'
import { resolveFallbackProviderId } from '../utils/provider-helpers.js'
import {
  RunRequestSchema,
  SupervisorRequestSchema,
  ParallelRequestSchema,
  BidRequestSchema,
  ApproveRequestSchema,
} from './request-schemas.js'

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
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body,
  }
}

function errorResponse(status: number, message: string, code?: string): HttpResponse {
  return jsonResponse(status, { error: message, code })
}

function collectProviderIds(
  entries:
    | Array<{ providerId?: AdapterProviderId | null }>
    | undefined,
): AdapterProviderId[] {
  if (!entries) return []

  const providerIds: AdapterProviderId[] = []
  for (const entry of entries) {
    const providerId = entry.providerId
    if (providerId) {
      providerIds.push(providerId)
    }
  }

  return providerIds
}

/** Type guard: is this result a streaming response? */
export function isStreamResponse(result: HttpResult): result is HttpStreamResponse {
  return 'stream' in result
}

/**
 * Extract a correlation ID from standard HTTP headers.
 *
 * Checks (in priority order):
 *  1. `x-correlation-id`
 *  2. `x-request-id`
 *  3. W3C `traceparent` trace-id segment
 */
function extractCorrelationId(
  headers: Record<string, string | undefined>,
): string | undefined {
  const explicit = headers['x-correlation-id'] ?? headers['x-request-id']
  if (explicit) return explicit

  const traceparent = headers['traceparent']
  if (traceparent) {
    // W3C traceparent format: version-traceId-parentId-flags
    const segments = traceparent.split('-')
    if (segments.length >= 2 && segments[1]!.length > 0) {
      return segments[1]
    }
  }

  return undefined
}

/**
 * Extract a path parameter from a pattern like "/approve/:id".
 * Returns the captured segment or undefined.
 */
function matchPathParam(
  actualPath: string,
  prefix: string,
): string | undefined {
  const normalised = actualPath.startsWith('/') ? actualPath : `/${actualPath}`
  if (!normalised.startsWith(prefix)) return undefined
  const rest = normalised.slice(prefix.length)
  // Must have exactly one segment remaining (e.g. "/abc123")
  if (!rest.startsWith('/') || rest.indexOf('/', 1) !== -1) return undefined
  const param = rest.slice(1)
  return param.length > 0 ? param : undefined
}

export function resolveRuntimeFallbackProviderId(
  registry: { listAdapters(): AdapterProviderId[] },
  preferredProvider?: AdapterProviderId,
  providers?: AdapterProviderId[],
): AdapterProviderId {
  return preferredProvider
    ?? providers?.[0]
    ?? resolveFallbackProviderId(registry.listAdapters())
    ?? ('unknown' as AdapterProviderId)
}

function resolveStreamCompletionProviderId(
  registry: { listAdapters(): AdapterProviderId[] },
  completion: {
    providerId?: AdapterProviderId | null
    selectedResult?: { providerId?: AdapterProviderId | null }
    subtaskResults?: Array<{ providerId?: AdapterProviderId | null }>
  },
  fallbackProviders?: AdapterProviderId[],
): AdapterProviderId {
  const actualProviderId =
    completion.selectedResult?.providerId
    ?? completion.providerId

  const providers = fallbackProviders ?? collectProviderIds(completion.subtaskResults)

  return resolveRuntimeFallbackProviderId(
    registry,
    actualProviderId ?? undefined,
    providers,
  )
}

// ---------------------------------------------------------------------------
// AdapterHttpHandler
// ---------------------------------------------------------------------------

export class AdapterHttpHandler {
  private readonly orchestrator: OrchestratorFacade
  private readonly approvalGate: AdapterApprovalGate | undefined
  private readonly eventBus: DzupEventBus | undefined
  private readonly config: AdapterHttpConfig
  private readonly validateApiKey:
    | ((key: string) => boolean | Promise<boolean>)
    | undefined
  private readonly rateLimiter?: SlidingWindowRateLimiter

  constructor(config: AdapterHttpConfig) {
    this.orchestrator = config.orchestrator
    this.approvalGate = config.approvalGate
    this.eventBus = config.eventBus
    this.config = config
    this.validateApiKey = config.validateApiKey
    if (config.rateLimit) {
      this.rateLimiter = new SlidingWindowRateLimiter(config.rateLimit)
    }
  }

  // -------------------------------------------------------------------------
  // Main router
  // -------------------------------------------------------------------------

  /**
   * Route a request to the appropriate handler.
   * Returns HttpResult (either JSON response or SSE stream).
   */
  async handle(request: HttpRequest): Promise<HttpResult> {
    // --- Auth check ---
    const authResult = await this.checkAuth(request)
    if (authResult) return authResult

    // --- Rate limit check ---
    if (this.rateLimiter) {
      const clientKey = request.headers?.['x-api-key']
        ?? request.headers?.['authorization']
        ?? request.headers?.['x-forwarded-for']
        ?? '*'
      if (!this.rateLimiter.check(clientKey)) {
        return jsonResponse(429, { error: 'Too many requests' })
      }
    }

    // --- Extract correlation ID from request headers ---
    const correlationId = extractCorrelationId(request.headers)

    const method = request.method.toUpperCase()
    const path = request.path

    // --- Route matching ---
    if (method === 'POST' && path === '/run') {
      const validation = this.validateBody(request.body, RunRequestSchema)
      if ('error' in validation) return validation.error
      return this.handleRun(validation.body, correlationId)
    }

    if (method === 'POST' && path === '/supervisor') {
      const validation = this.validateBody(request.body, SupervisorRequestSchema)
      if ('error' in validation) return validation.error
      return this.handleSupervisor(validation.body, correlationId)
    }

    if (method === 'POST' && path === '/parallel') {
      const validation = this.validateBody(request.body, ParallelRequestSchema)
      if ('error' in validation) return validation.error
      return this.handleParallel(validation.body, correlationId)
    }

    if (method === 'POST' && path === '/bid') {
      const validation = this.validateBody(request.body, BidRequestSchema)
      if ('error' in validation) return validation.error
      return this.handleBid(validation.body, correlationId)
    }

    if (method === 'POST') {
      const requestId = matchPathParam(path, '/approve')
      if (requestId !== undefined) {
        const validation = this.validateBody(request.body, ApproveRequestSchema)
        if ('error' in validation) return validation.error
        return this.handleApproval(requestId, validation.body)
      }
    }

    if (method === 'GET' && path === '/health') {
      return this.handleHealth()
    }

    if (method === 'GET' && path === '/health/detailed') {
      return this.handleDetailedHealth()
    }

    if (method === 'GET' && path === '/cost') {
      return this.handleCostReport()
    }

    return errorResponse(404, `Route not found: ${method} ${path}`, 'NOT_FOUND')
  }

  // -------------------------------------------------------------------------
  // Individual route handlers
  // -------------------------------------------------------------------------

  /** POST /run -- execute with auto-routing */
  async handleRun(body: RunRequestBody, correlationId?: string): Promise<HttpResult> {
    const input: AgentInput = {
      prompt: body.prompt,
      workingDirectory: body.workingDirectory,
      systemPrompt: body.systemPrompt,
      maxTurns: body.maxTurns,
      correlationId,
    }

    if (body.stream) {
      return this.streamRun(input, body)
    }

    try {
      const result = await this.orchestrator.run(body.prompt, {
        tags: body.tags,
        preferredProvider: body.preferredProvider,
        workingDirectory: body.workingDirectory,
        systemPrompt: body.systemPrompt,
        maxTurns: body.maxTurns,
      })

      return jsonResponse(200, result)
    } catch (err) {
      return this.handleError(err, 'run')
    }
  }

  /** POST /supervisor -- supervisor pattern */
  async handleSupervisor(body: SupervisorRequestBody, _correlationId?: string): Promise<HttpResult> {
    if (body.stream) {
      return this.streamSupervisor(body)
    }

    try {
      const result = await this.orchestrator.supervisor(body.goal, {
        maxConcurrentDelegations: body.maxConcurrentDelegations,
      })

      return jsonResponse(200, result)
    } catch (err) {
      return this.handleError(err, 'supervisor')
    }
  }

  /** POST /parallel -- parallel execution */
  async handleParallel(body: ParallelRequestBody, _correlationId?: string): Promise<HttpResult> {
    if (body.stream) {
      return this.streamParallel(body)
    }

    try {
      const mergeStrategy = body.strategy ?? 'all'

      const result = await this.orchestrator.parallel(body.prompt, {
        providers: body.providers,
        mergeStrategy,
      })

      return jsonResponse(200, result)
    } catch (err) {
      return this.handleError(err, 'parallel')
    }
  }

  /** POST /bid -- contract-net bidding */
  async handleBid(body: BidRequestBody, _correlationId?: string): Promise<HttpResult> {
    try {
      const result = await this.orchestrator.bid(body.prompt)
      return jsonResponse(200, result)
    } catch (err) {
      return this.handleError(err, 'bid')
    }
  }

  /** POST /approve/:requestId -- approve/reject a pending request */
  async handleApproval(
    requestId: string,
    body: ApprovalRequestBody,
  ): Promise<HttpResponse> {
    if (!this.approvalGate) {
      return errorResponse(501, 'Approval gate not configured', 'NO_APPROVAL_GATE')
    }

    try {
      let found: boolean
      if (body.approved) {
        found = await this.approvalGate.grant(requestId, body.approvedBy, body.reason)
      } else {
        found = await this.approvalGate.reject(requestId, body.reason)
      }

      if (!found) {
        return errorResponse(
          404,
          `Pending request not found: ${requestId}`,
          'REQUEST_NOT_FOUND',
        )
      }

      return jsonResponse(200, {
        requestId,
        status: body.approved ? 'approved' : 'rejected',
      })
    } catch (err) {
      return this.handleError(err, 'approval') as HttpResponse
    }
  }

  /** GET /health -- adapter health status */
  async handleHealth(): Promise<HttpResponse> {
    try {
      const healthStatuses = await this.orchestrator.registry.getHealthStatus()
      const costReport = this.orchestrator.getCostReport()

      const adapters: HealthResponse['adapters'] = {}
      let allHealthy = true
      let anyHealthy = false

      for (const [id, hs] of Object.entries(healthStatuses)) {
        adapters[id] = { healthy: hs.healthy }
        if (hs.healthy) {
          anyHealthy = true
        } else {
          allHealthy = false
        }
      }

      const adapterCount = Object.keys(adapters).length
      let overallStatus: HealthResponse['status']
      if (adapterCount === 0 || !anyHealthy) {
        overallStatus = 'down'
      } else if (allHealthy) {
        overallStatus = 'ok'
      } else {
        overallStatus = 'degraded'
      }

      const response: HealthResponse = {
        status: overallStatus,
        adapters,
        costReport,
      }

      return jsonResponse(200, response)
    } catch (err) {
      return this.handleError(err, 'health') as HttpResponse
    }
  }

  /** GET /health/detailed -- detailed adapter health with circuit breaker state */
  async handleDetailedHealth(): Promise<HttpResponse> {
    const registry = this.orchestrator.registry
    if ('getDetailedHealth' in registry) {
      try {
        const health = await (registry as { getDetailedHealth(): Promise<unknown> }).getDetailedHealth()
        return jsonResponse(200, health)
      } catch (err) {
        return this.handleError(err, 'health/detailed') as HttpResponse
      }
    }
    // Fallback to basic health
    return this.handleHealth()
  }

  /** GET /cost -- cost report */
  handleCostReport(): HttpResponse {
    const report = this.orchestrator.getCostReport()
    if (!report) {
      return errorResponse(404, 'Cost tracking not enabled', 'COST_TRACKING_DISABLED')
    }
    return jsonResponse(200, report)
  }

  // -------------------------------------------------------------------------
  // Streaming helpers
  // -------------------------------------------------------------------------

  private streamRun(
    input: AgentInput,
    body: RunRequestBody,
  ): HttpStreamResponse {
    const orchestrator = this.orchestrator
    const eventBus = this.eventBus

    async function* generateEvents(): AsyncGenerator<AgentEvent, void, undefined> {
      try {
        // Use chat() which returns an AsyncGenerator of events
        const stream = orchestrator.chat(input.prompt, {
          provider: body.preferredProvider,
          workingDirectory: body.workingDirectory,
          systemPrompt: body.systemPrompt,
        })

        yield* stream
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        if (eventBus) {
          try {
            eventBus.emit({
              type: 'agent:stream_delta',
              agentId: 'http-handler',
              runId: 'stream-run',
              content: `[error] ${errorMessage}`,
            })
          } catch {
            // Event bus failure is non-fatal
          }
        }
        const failEvent: AgentEvent = {
          type: 'adapter:failed',
          providerId: resolveRuntimeFallbackProviderId(orchestrator.registry, body.preferredProvider),
          error: errorMessage,
          timestamp: Date.now(),
        }
        yield failEvent
      }
    }

    return this.toStreamResponse(generateEvents())
  }

  private streamSupervisor(body: SupervisorRequestBody): HttpStreamResponse {
    const orchestrator = this.orchestrator

    async function* generateEvents(): AsyncGenerator<AgentEvent, void, undefined> {
      try {
        const result = await orchestrator.supervisor(body.goal, {
          maxConcurrentDelegations: body.maxConcurrentDelegations,
        })

        const completedEvent: AgentCompletedEvent = {
          type: 'adapter:completed',
          providerId: resolveStreamCompletionProviderId(
            orchestrator.registry,
            result,
            collectProviderIds(result.subtaskResults),
          ),
          sessionId: 'supervisor',
          result: JSON.stringify(result),
          durationMs: result.totalDurationMs,
          timestamp: Date.now(),
        }
        yield completedEvent
      } catch (err) {
        const failEvent: AgentEvent = {
          type: 'adapter:failed',
          providerId: resolveRuntimeFallbackProviderId(orchestrator.registry),
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        }
        yield failEvent
      }
    }

    return this.toStreamResponse(generateEvents())
  }

  private streamParallel(body: ParallelRequestBody): HttpStreamResponse {
    const orchestrator = this.orchestrator

    async function* generateEvents(): AsyncGenerator<AgentEvent, void, undefined> {
      try {
        const mergeStrategy = body.strategy ?? 'all'

        const result = await orchestrator.parallel(body.prompt, {
          providers: body.providers,
          mergeStrategy,
        })

        const completedEvent: AgentCompletedEvent = {
          type: 'adapter:completed',
          providerId: resolveStreamCompletionProviderId(
            orchestrator.registry,
            result,
            collectProviderIds(result.allResults),
          ),
          sessionId: 'parallel',
          result: JSON.stringify(result),
          durationMs: result.totalDurationMs,
          timestamp: Date.now(),
        }
        yield completedEvent
      } catch (err) {
        const failEvent: AgentEvent = {
          type: 'adapter:failed',
          providerId: resolveRuntimeFallbackProviderId(orchestrator.registry, undefined, body.providers),
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        }
        yield failEvent
      }
    }

    return this.toStreamResponse(generateEvents())
  }

  private toStreamResponse(
    events: AsyncGenerator<AgentEvent, void, undefined>,
  ): HttpStreamResponse {
    const handler = new StreamingHandler({
      format: 'sse',
      includeToolCalls: true,
      trackProgress: true,
      eventBus: this.eventBus,
    })

    return {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      },
      stream: handler.serialize(events),
    }
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  private async checkAuth(request: HttpRequest): Promise<HttpResponse | undefined> {
    // Check if this is a public endpoint
    if (this.config.publicEndpoints?.includes(request.path)) {
      return undefined
    }

    // If no auth configured, pass through
    if (!this.validateApiKey && !this.config.tokenValidator) {
      return undefined
    }

    const authHeader = request.headers['authorization'] ?? request.headers['Authorization']
    if (!authHeader) {
      return errorResponse(401, 'Missing Authorization header', 'AUTH_REQUIRED')
    }

    const match = /^Bearer\s+(.+)$/i.exec(authHeader)
    if (!match?.[1]) {
      return errorResponse(401, 'Invalid Authorization format. Expected: Bearer <token>', 'AUTH_INVALID_FORMAT')
    }

    const token = match[1]

    // Custom token validator takes precedence
    if (this.config.tokenValidator) {
      try {
        const result = await this.config.tokenValidator(token)
        if (!result.valid) {
          return errorResponse(401, 'Token validation failed', 'AUTH_TOKEN_INVALID')
        }
        return undefined
      } catch {
        return errorResponse(500, 'Token validation error', 'AUTH_VALIDATION_ERROR')
      }
    }

    // Legacy simple API key check
    if (this.validateApiKey) {
      const isValid = await this.validateApiKey(token)
      if (!isValid) {
        return errorResponse(401, 'Invalid API key', 'AUTH_INVALID_KEY')
      }
    }

    return undefined
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  private validateBody<T>(
    body: unknown,
    schema: z.ZodType<T>,
  ): { body: T } | { error: HttpResponse } {
    const result = schema.safeParse(body)
    if (!result.success) {
      return {
        error: jsonResponse(400, {
          error: 'Validation failed',
          details: result.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        }),
      }
    }
    return { body: result.data }
  }

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  private handleError(err: unknown, operation: string): HttpResponse {
    const message = err instanceof Error ? err.message : String(err)

    if (this.eventBus) {
      try {
        this.eventBus.emit({
          type: 'agent:stream_delta',
          agentId: 'http-handler',
          runId: operation,
          content: `[error] ${message}`,
        })
      } catch {
        // Event bus failure is non-fatal
      }
    }

    return errorResponse(500, `Operation "${operation}" failed: ${message}`, 'INTERNAL_ERROR')
  }
}
