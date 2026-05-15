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

import type { DzupEventBus } from '@dzupagent/core/events'
import type { z } from 'zod'

import type { OrchestratorFacade } from '../facade/orchestrator-facade.js'
import { SlidingWindowRateLimiter } from './rate-limiter.js'
import type { AgentInput } from '../types.js'
import {
  RunRequestSchema,
  SupervisorRequestSchema,
  ParallelRequestSchema,
  BidRequestSchema,
  ApproveRequestSchema,
} from './request-schemas.js'
import {
  errorResponse,
  extractCorrelationId,
  jsonResponse,
  matchPathParam,
} from './http-helpers.js'
import { streamParallel, streamRun, streamSupervisor } from './http-streaming.js'
import type {
  AdapterApprovalGate,
  AdapterHttpConfig,
  ApprovalRequestBody,
  BidRequestBody,
  HealthResponse,
  HttpRequest,
  HttpResponse,
  HttpResult,
  HttpStreamResponse,
  ParallelRequestBody,
  RunRequestBody,
  SupervisorRequestBody,
} from './http-types.js'

// ---------------------------------------------------------------------------
// Re-exports for backward-compatible public API
// ---------------------------------------------------------------------------

export type {
  AdapterApprovalGate,
  AdapterHttpConfig,
  ApprovalRequestBody,
  BidRequestBody,
  HealthResponse,
  HttpRequest,
  HttpResponse,
  HttpResult,
  HttpStreamResponse,
  ParallelRequestBody,
  RunRequestBody,
  SupervisorRequestBody,
  TokenValidationResult,
} from './http-types.js'
export { isStreamResponse } from './http-types.js'
export { resolveRuntimeFallbackProviderId } from './http-helpers.js'

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
        policyConformanceMode: body.policyConformanceMode,
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
  // Streaming dispatchers
  // -------------------------------------------------------------------------

  private streamRun(
    input: AgentInput,
    body: RunRequestBody,
  ): HttpStreamResponse {
    return streamRun(
      { orchestrator: this.orchestrator, eventBus: this.eventBus },
      input,
      body,
    )
  }

  private streamSupervisor(body: SupervisorRequestBody): HttpStreamResponse {
    return streamSupervisor(
      { orchestrator: this.orchestrator, eventBus: this.eventBus },
      body,
    )
  }

  private streamParallel(body: ParallelRequestBody): HttpStreamResponse {
    return streamParallel(
      { orchestrator: this.orchestrator, eventBus: this.eventBus },
      body,
    )
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
