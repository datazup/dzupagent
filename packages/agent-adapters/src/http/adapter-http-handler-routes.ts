/**
 * Individual route handlers for AdapterHttpHandler.
 *
 * Extracted from adapter-http-handler.ts as part of the god-module
 * decomposition (DZUPAGENT-ARCH-M-06). Each function operates on a
 * HandlerContext, keeping the composition root thin. Behavior is unchanged.
 */

import { errorResponse, jsonResponse } from "./http-helpers.js";
import {
  streamParallel,
  streamRun,
  streamSupervisor,
} from "./http-streaming.js";
import type { AgentInput } from "../types.js";
import {
  handleError,
  type HandlerContext,
} from "./adapter-http-handler-context.js";
import type {
  ApprovalRequestBody,
  BidRequestBody,
  HealthResponse,
  HttpResponse,
  HttpResult,
  HttpStreamResponse,
  ParallelRequestBody,
  RunRequestBody,
  SupervisorRequestBody,
} from "./http-types.js";

// ---------------------------------------------------------------------------
// Streaming dispatchers
// ---------------------------------------------------------------------------

function dispatchStreamRun(
  ctx: HandlerContext,
  input: AgentInput,
  body: RunRequestBody
): HttpStreamResponse {
  return streamRun(
    { orchestrator: ctx.orchestrator, eventBus: ctx.eventBus },
    input,
    body
  );
}

function dispatchStreamSupervisor(
  ctx: HandlerContext,
  body: SupervisorRequestBody
): HttpStreamResponse {
  return streamSupervisor(
    { orchestrator: ctx.orchestrator, eventBus: ctx.eventBus },
    body
  );
}

function dispatchStreamParallel(
  ctx: HandlerContext,
  body: ParallelRequestBody
): HttpStreamResponse {
  return streamParallel(
    { orchestrator: ctx.orchestrator, eventBus: ctx.eventBus },
    body
  );
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** POST /run -- execute with auto-routing */
export async function handleRun(
  ctx: HandlerContext,
  body: RunRequestBody,
  correlationId?: string
): Promise<HttpResult> {
  const input: AgentInput = {
    prompt: body.prompt,
    workingDirectory: body.workingDirectory,
    systemPrompt: body.systemPrompt,
    maxTurns: body.maxTurns,
    correlationId,
  };

  if (body.stream) {
    return dispatchStreamRun(ctx, input, body);
  }

  try {
    const result = await ctx.orchestrator.run(body.prompt, {
      tags: body.tags,
      preferredProvider: body.preferredProvider,
      workingDirectory: body.workingDirectory,
      systemPrompt: body.systemPrompt,
      maxTurns: body.maxTurns,
      policyConformanceMode: body.policyConformanceMode,
    });

    return jsonResponse(200, result);
  } catch (err) {
    return handleError(ctx, err, "run");
  }
}

/** POST /supervisor -- supervisor pattern */
export async function handleSupervisor(
  ctx: HandlerContext,
  body: SupervisorRequestBody,
  _correlationId?: string
): Promise<HttpResult> {
  if (body.stream) {
    return dispatchStreamSupervisor(ctx, body);
  }

  try {
    const result = await ctx.orchestrator.supervisor(body.goal, {
      maxConcurrentDelegations: body.maxConcurrentDelegations,
    });

    return jsonResponse(200, result);
  } catch (err) {
    return handleError(ctx, err, "supervisor");
  }
}

/** POST /parallel -- parallel execution */
export async function handleParallel(
  ctx: HandlerContext,
  body: ParallelRequestBody,
  _correlationId?: string
): Promise<HttpResult> {
  if (body.stream) {
    return dispatchStreamParallel(ctx, body);
  }

  try {
    const mergeStrategy = body.strategy ?? "all";

    const result = await ctx.orchestrator.parallel(body.prompt, {
      providers: body.providers,
      mergeStrategy,
    });

    return jsonResponse(200, result);
  } catch (err) {
    return handleError(ctx, err, "parallel");
  }
}

/** POST /bid -- contract-net bidding */
export async function handleBid(
  ctx: HandlerContext,
  body: BidRequestBody,
  _correlationId?: string
): Promise<HttpResult> {
  try {
    const result = await ctx.orchestrator.bid(body.prompt);
    return jsonResponse(200, result);
  } catch (err) {
    return handleError(ctx, err, "bid");
  }
}

/** POST /approve/:requestId -- approve/reject a pending request */
export async function handleApproval(
  ctx: HandlerContext,
  requestId: string,
  body: ApprovalRequestBody
): Promise<HttpResponse> {
  if (!ctx.approvalGate) {
    return errorResponse(
      501,
      "Approval gate not configured",
      "NO_APPROVAL_GATE"
    );
  }

  try {
    let found: boolean;
    if (body.approved) {
      found = await ctx.approvalGate.grant(
        requestId,
        body.approvedBy,
        body.reason
      );
    } else {
      found = await ctx.approvalGate.reject(requestId, body.reason);
    }

    if (!found) {
      return errorResponse(
        404,
        `Pending request not found: ${requestId}`,
        "REQUEST_NOT_FOUND"
      );
    }

    return jsonResponse(200, {
      requestId,
      status: body.approved ? "approved" : "rejected",
    });
  } catch (err) {
    return handleError(ctx, err, "approval") as HttpResponse;
  }
}

/** GET /health -- adapter health status */
export async function handleHealth(ctx: HandlerContext): Promise<HttpResponse> {
  try {
    const healthStatuses = await ctx.orchestrator.registry.getHealthStatus();
    const costReport = ctx.orchestrator.getCostReport();

    const adapters: HealthResponse["adapters"] = {};
    let allHealthy = true;
    let anyHealthy = false;

    for (const [id, hs] of Object.entries(healthStatuses)) {
      adapters[id] = { healthy: hs.healthy };
      if (hs.healthy) {
        anyHealthy = true;
      } else {
        allHealthy = false;
      }
    }

    const adapterCount = Object.keys(adapters).length;
    let overallStatus: HealthResponse["status"];
    if (adapterCount === 0 || !anyHealthy) {
      overallStatus = "down";
    } else if (allHealthy) {
      overallStatus = "ok";
    } else {
      overallStatus = "degraded";
    }

    const response: HealthResponse = {
      status: overallStatus,
      adapters,
      costReport,
    };

    return jsonResponse(200, response);
  } catch (err) {
    return handleError(ctx, err, "health") as HttpResponse;
  }
}

/** GET /health/detailed -- detailed adapter health with circuit breaker state */
export async function handleDetailedHealth(
  ctx: HandlerContext
): Promise<HttpResponse> {
  const registry = ctx.orchestrator.registry;
  if ("getDetailedHealth" in registry) {
    try {
      const health = await (
        registry as { getDetailedHealth(): Promise<unknown> }
      ).getDetailedHealth();
      return jsonResponse(200, health);
    } catch (err) {
      return handleError(ctx, err, "health/detailed") as HttpResponse;
    }
  }
  // Fallback to basic health
  return handleHealth(ctx);
}

/** GET /cost -- cost report */
export function handleCostReport(ctx: HandlerContext): HttpResponse {
  const report = ctx.orchestrator.getCostReport();
  if (!report) {
    return errorResponse(
      404,
      "Cost tracking not enabled",
      "COST_TRACKING_DISABLED"
    );
  }
  return jsonResponse(200, report);
}
