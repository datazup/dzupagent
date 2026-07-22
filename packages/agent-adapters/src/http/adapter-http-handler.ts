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
 *
 * This module is a thin composition root: request parsing, auth, per-route
 * handlers, validation and error mapping live in sibling leaf modules
 * (adapter-http-handler-*.ts). See DZUPAGENT-ARCH-M-06.
 */

import type { DzupEventBus } from "@dzupagent/core/events";

import type { OrchestratorFacade } from "../facade/orchestrator-facade.js";
import { SlidingWindowRateLimiter } from "./rate-limiter.js";
import {
  RunRequestSchema,
  SupervisorRequestSchema,
  ParallelRequestSchema,
  BidRequestSchema,
  ApproveRequestSchema,
} from "./request-schemas.js";
import {
  errorResponse,
  extractCorrelationId,
  jsonResponse,
  matchPathParam,
} from "./http-helpers.js";
import { checkAuth } from "./adapter-http-handler-auth.js";
import {
  validateBody,
  type HandlerContext,
} from "./adapter-http-handler-context.js";
import {
  handleApproval,
  handleBid,
  handleCostReport,
  handleDetailedHealth,
  handleHealth,
  handleParallel,
  handleRun,
  handleSupervisor,
} from "./adapter-http-handler-routes.js";
import type {
  AdapterApprovalGate,
  AdapterHttpConfig,
  ApprovalRequestBody,
  BidRequestBody,
  HttpRequest,
  HttpResponse,
  HttpResult,
  ParallelRequestBody,
  RunRequestBody,
  SupervisorRequestBody,
} from "./http-types.js";

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
} from "./http-types.js";
export { isStreamResponse } from "./http-types.js";
export { resolveRuntimeFallbackProviderId } from "./http-helpers.js";

// ---------------------------------------------------------------------------
// AdapterHttpHandler
// ---------------------------------------------------------------------------

export class AdapterHttpHandler implements HandlerContext {
  readonly orchestrator: OrchestratorFacade;
  readonly approvalGate: AdapterApprovalGate | undefined;
  readonly eventBus: DzupEventBus | undefined;
  readonly config: AdapterHttpConfig;
  readonly validateApiKey:
    | ((key: string) => boolean | Promise<boolean>)
    | undefined;
  private readonly rateLimiter?: SlidingWindowRateLimiter;

  constructor(config: AdapterHttpConfig) {
    this.orchestrator = config.orchestrator;
    this.approvalGate = config.approvalGate;
    this.eventBus = config.eventBus;
    this.config = config;
    this.validateApiKey = config.validateApiKey;
    if (config.rateLimit) {
      this.rateLimiter = new SlidingWindowRateLimiter(config.rateLimit);
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
    const authResult = await checkAuth(this, request);
    if (authResult) return authResult;

    // --- Rate limit check ---
    if (this.rateLimiter) {
      const clientKey =
        request.headers?.["x-api-key"] ??
        request.headers?.["authorization"] ??
        request.headers?.["x-forwarded-for"] ??
        "*";
      if (!this.rateLimiter.check(clientKey)) {
        return jsonResponse(429, { error: "Too many requests" });
      }
    }

    // --- Extract correlation ID from request headers ---
    const correlationId = extractCorrelationId(request.headers);

    const method = request.method.toUpperCase();
    const path = request.path;

    // --- Route matching ---
    if (method === "POST" && path === "/run") {
      const validation = validateBody(request.body, RunRequestSchema);
      if ("error" in validation) return validation.error;
      return this.handleRun(validation.body, correlationId);
    }

    if (method === "POST" && path === "/supervisor") {
      const validation = validateBody(request.body, SupervisorRequestSchema);
      if ("error" in validation) return validation.error;
      return this.handleSupervisor(validation.body, correlationId);
    }

    if (method === "POST" && path === "/parallel") {
      const validation = validateBody(request.body, ParallelRequestSchema);
      if ("error" in validation) return validation.error;
      return this.handleParallel(validation.body, correlationId);
    }

    if (method === "POST" && path === "/bid") {
      const validation = validateBody(request.body, BidRequestSchema);
      if ("error" in validation) return validation.error;
      return this.handleBid(validation.body, correlationId);
    }

    if (method === "POST") {
      const requestId = matchPathParam(path, "/approve");
      if (requestId !== undefined) {
        const validation = validateBody(request.body, ApproveRequestSchema);
        if ("error" in validation) return validation.error;
        return this.handleApproval(requestId, validation.body);
      }
    }

    if (method === "GET" && path === "/health") {
      return this.handleHealth();
    }

    if (method === "GET" && path === "/health/detailed") {
      return this.handleDetailedHealth();
    }

    if (method === "GET" && path === "/cost") {
      return this.handleCostReport();
    }

    return errorResponse(
      404,
      `Route not found: ${method} ${path}`,
      "NOT_FOUND"
    );
  }

  // -------------------------------------------------------------------------
  // Individual route handlers (thin delegations to leaf modules)
  // -------------------------------------------------------------------------

  /** POST /run -- execute with auto-routing */
  handleRun(body: RunRequestBody, correlationId?: string): Promise<HttpResult> {
    return handleRun(this, body, correlationId);
  }

  /** POST /supervisor -- supervisor pattern */
  handleSupervisor(
    body: SupervisorRequestBody,
    correlationId?: string
  ): Promise<HttpResult> {
    return handleSupervisor(this, body, correlationId);
  }

  /** POST /parallel -- parallel execution */
  handleParallel(
    body: ParallelRequestBody,
    correlationId?: string
  ): Promise<HttpResult> {
    return handleParallel(this, body, correlationId);
  }

  /** POST /bid -- contract-net bidding */
  handleBid(body: BidRequestBody, correlationId?: string): Promise<HttpResult> {
    return handleBid(this, body, correlationId);
  }

  /** POST /approve/:requestId -- approve/reject a pending request */
  handleApproval(
    requestId: string,
    body: ApprovalRequestBody
  ): Promise<HttpResponse> {
    return handleApproval(this, requestId, body);
  }

  /** GET /health -- adapter health status */
  handleHealth(): Promise<HttpResponse> {
    return handleHealth(this);
  }

  /** GET /health/detailed -- detailed adapter health with circuit breaker state */
  handleDetailedHealth(): Promise<HttpResponse> {
    return handleDetailedHealth(this);
  }

  /** GET /cost -- cost report */
  handleCostReport(): HttpResponse {
    return handleCostReport(this);
  }
}
