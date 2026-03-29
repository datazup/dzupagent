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

import type { DzipEventBus } from '@dzipagent/core'

import type { OrchestratorFacade } from '../facade/orchestrator-facade.js'
import { StreamingHandler } from '../streaming/streaming-handler.js'
import type { AdapterProviderId, AgentCompletedEvent, AgentEvent, AgentInput } from '../types.js'

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
  tags?: string[]
  preferredProvider?: AdapterProviderId
  workingDirectory?: string
  systemPrompt?: string
  maxTurns?: number
  stream?: boolean
}

export interface SupervisorRequestBody {
  goal: string
  maxConcurrentDelegations?: number
  stream?: boolean
}

export interface ParallelRequestBody {
  prompt: string
  providers?: AdapterProviderId[]
  strategy?: 'first-wins' | 'all' | 'best-of-n'
  stream?: boolean
}

export interface BidRequestBody {
  prompt: string
  tags?: string[]
}

export interface ApprovalRequestBody {
  approved: boolean
  approvedBy?: string
  reason?: string
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down'
  adapters: Record<string, { healthy: boolean; circuitState?: string }>
  costReport?: unknown
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
// Configuration
// ---------------------------------------------------------------------------

export interface AdapterHttpConfig {
  /** The orchestrator facade to expose */
  orchestrator: OrchestratorFacade
  /** Optional approval gate for guarded endpoints */
  approvalGate?: AdapterApprovalGate
  /** Event bus */
  eventBus?: DzipEventBus
  /** API key validation function. If provided, all requests must pass. */
  validateApiKey?: (key: string) => boolean | Promise<boolean>
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

/** Type guard: is this result a streaming response? */
export function isStreamResponse(result: HttpResult): result is HttpStreamResponse {
  return 'stream' in result
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

// ---------------------------------------------------------------------------
// AdapterHttpHandler
// ---------------------------------------------------------------------------

export class AdapterHttpHandler {
  private readonly orchestrator: OrchestratorFacade
  private readonly approvalGate: AdapterApprovalGate | undefined
  private readonly eventBus: DzipEventBus | undefined
  private readonly validateApiKey:
    | ((key: string) => boolean | Promise<boolean>)
    | undefined

  constructor(config: AdapterHttpConfig) {
    this.orchestrator = config.orchestrator
    this.approvalGate = config.approvalGate
    this.eventBus = config.eventBus
    this.validateApiKey = config.validateApiKey
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

    const method = request.method.toUpperCase()
    const path = request.path

    // --- Route matching ---
    if (method === 'POST' && path === '/run') {
      const validation = this.validateBody<RunRequestBody>(request.body, ['prompt'])
      if ('error' in validation) return validation.error
      return this.handleRun(validation.body)
    }

    if (method === 'POST' && path === '/supervisor') {
      const validation = this.validateBody<SupervisorRequestBody>(request.body, ['goal'])
      if ('error' in validation) return validation.error
      return this.handleSupervisor(validation.body)
    }

    if (method === 'POST' && path === '/parallel') {
      const validation = this.validateBody<ParallelRequestBody>(request.body, ['prompt'])
      if ('error' in validation) return validation.error
      return this.handleParallel(validation.body)
    }

    if (method === 'POST' && path === '/bid') {
      const validation = this.validateBody<BidRequestBody>(request.body, ['prompt'])
      if ('error' in validation) return validation.error
      return this.handleBid(validation.body)
    }

    if (method === 'POST') {
      const requestId = matchPathParam(path, '/approve')
      if (requestId !== undefined) {
        const validation = this.validateBody<ApprovalRequestBody>(request.body, ['approved'])
        if ('error' in validation) return validation.error
        return this.handleApproval(requestId, validation.body)
      }
    }

    if (method === 'GET' && path === '/health') {
      return this.handleHealth()
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
  async handleRun(body: RunRequestBody): Promise<HttpResult> {
    const input: AgentInput = {
      prompt: body.prompt,
      workingDirectory: body.workingDirectory,
      systemPrompt: body.systemPrompt,
      maxTurns: body.maxTurns,
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
  async handleSupervisor(body: SupervisorRequestBody): Promise<HttpResult> {
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
  async handleParallel(body: ParallelRequestBody): Promise<HttpResult> {
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
  async handleBid(body: BidRequestBody): Promise<HttpResult> {
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
          providerId: 'claude',
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
          providerId: 'claude',
          sessionId: 'supervisor',
          result: JSON.stringify(result),
          durationMs: result.totalDurationMs,
          timestamp: Date.now(),
        }
        yield completedEvent
      } catch (err) {
        const failEvent: AgentEvent = {
          type: 'adapter:failed',
          providerId: 'claude',
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
          providerId: 'claude',
          sessionId: 'parallel',
          result: JSON.stringify(result),
          durationMs: result.totalDurationMs,
          timestamp: Date.now(),
        }
        yield completedEvent
      } catch (err) {
        const failEvent: AgentEvent = {
          type: 'adapter:failed',
          providerId: 'claude',
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
    if (!this.validateApiKey) return undefined

    const authHeader = request.headers['authorization'] ?? request.headers['Authorization']
    if (!authHeader) {
      return errorResponse(401, 'Missing Authorization header', 'UNAUTHORIZED')
    }

    const match = /^Bearer\s+(.+)$/i.exec(authHeader)
    if (!match?.[1]) {
      return errorResponse(401, 'Invalid Authorization header format. Expected: Bearer <key>', 'UNAUTHORIZED')
    }

    const isValid = await this.validateApiKey(match[1])
    if (!isValid) {
      return errorResponse(401, 'Invalid API key', 'UNAUTHORIZED')
    }

    return undefined
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  private validateBody<T>(
    body: unknown,
    requiredFields: string[],
  ): { body: T } | { error: HttpResponse } {
    if (!body || typeof body !== 'object') {
      return {
        error: errorResponse(400, 'Request body must be a JSON object', 'INVALID_BODY'),
      }
    }

    const record = body as Record<string, unknown>
    const missing = requiredFields.filter((f) => !(f in record) || record[f] === undefined || record[f] === '')

    if (missing.length > 0) {
      return {
        error: errorResponse(
          400,
          `Missing required fields: ${missing.join(', ')}`,
          'MISSING_FIELDS',
        ),
      }
    }

    return { body: body as T }
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
