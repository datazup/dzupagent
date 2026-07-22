/**
 * Eval REST route handlers, registered onto an existing Hono instance by
 * `createEvalRoutes` (`./evals`).
 *
 * ARCH-M-06: extracted from the former single-file `./evals` god-module. This
 * module owns the HTTP request/response wiring; pure validation, filter/meta
 * building, and error mapping live in `./evals-helpers`. The composition root
 * in `./evals` resolves the orchestrator/mode and passes them here as deps, so
 * observable HTTP behaviour (routes, status codes, response shapes) is
 * unchanged.
 */
import type { Hono } from "hono";
import { logRouteError } from "./route-error.js";
import type { AppEnv } from "../types.js";
import type {
  EvalOrchestratorLike,
  EvalSuite,
} from "@dzupagent/eval-contracts";
import { getOptionalRequestingTenantId } from "./tenant-scope.js";
import {
  AVAILABLE_ENDPOINTS,
  buildExecutionUnavailableError,
  buildInvalidStateError,
  buildNotFoundError,
  buildRunListFilter,
  buildRunListMeta,
  buildValidationError,
  canCancelRun,
  canRetryRun,
  isCrossTenantRun,
  mapEvalRouteError,
  validateCreateRunMetadata,
  validateRunListQuery,
  type EvalRunCreateRequest,
} from "./evals-helpers.js";

export interface EvalHandlerDeps {
  orchestrator: EvalOrchestratorLike;
  serviceName: string;
  mode: "active" | "read-only";
  /**
   * Resolves an inline `POST /runs` body to a server-registered suite. Kept as
   * a closure by the composition root because it reads the injected `suites`
   * registry. Returns null when no suite is resolvable; throws a validation
   * error message for unsupported inline suite payloads.
   */
  resolveSuite: (body: EvalRunCreateRequest) => EvalSuite | null;
}

export function registerEvalHandlers(
  app: Hono<AppEnv>,
  deps: EvalHandlerDeps
): void {
  const { orchestrator, serviceName, mode, resolveSuite } = deps;

  app.get("/health", (c) => {
    return c.json({
      success: true,
      data: {
        service: serviceName,
        status: "ready",
        mode,
        writable: orchestrator.canExecute(),
        endpoints: [...AVAILABLE_ENDPOINTS],
      },
    });
  });

  app.get("/queue/stats", async (c) => {
    const stats = await orchestrator.getQueueStats();
    return c.json({
      success: true,
      data: {
        service: serviceName,
        mode,
        writable: orchestrator.canExecute(),
        queue: stats,
      },
    });
  });

  app.get("/runs", async (c) => {
    const validated = validateRunListQuery({
      suiteId: c.req.query("suiteId"),
      status: c.req.query("status"),
      limit: c.req.query("limit"),
    });

    if (!validated.ok) {
      return c.json({ success: false, error: validated.error }, 400);
    }

    const { suiteId, status, limit } = validated.value;

    // SEC-M-06: scope list results to the authenticated tenant (default-deny).
    // When an apiKey is present, runs owned by other tenants — and legacy runs
    // with no tenantId — are excluded. When the request is unauthenticated
    // (`auth.mode="none"` legacy mode) the filter is omitted so existing
    // un-scoped listing behaviour is preserved.
    const requesterTenantId = getOptionalRequestingTenantId(c);
    const runs = await orchestrator.listRuns(
      buildRunListFilter({ suiteId, status, limit, requesterTenantId })
    );
    const meta = buildRunListMeta({
      service: serviceName,
      mode,
      writable: orchestrator.canExecute(),
      suiteId,
      status,
      limit,
    });

    return c.json({
      success: true,
      data: runs,
      count: runs.length,
      meta,
    });
  });

  app.get("/runs/:id", async (c) => {
    const run = await orchestrator.getRun(c.req.param("id"));
    // SEC-M-06: a missing run AND a cross-tenant run both return 404 (not 403)
    // so callers cannot enumerate other tenants' run ids via status probing.
    if (!run || isCrossTenantRun(run, getOptionalRequestingTenantId(c))) {
      return c.json(
        {
          success: false,
          error: buildNotFoundError("Eval run not found"),
        },
        404
      );
    }

    return c.json({ success: true, data: run });
  });

  app.post("/runs", async (c) => {
    let body: EvalRunCreateRequest;
    try {
      body = await c.req.json<EvalRunCreateRequest>();
    } catch {
      return c.json(
        {
          success: false,
          error: buildValidationError("Request body must be valid JSON"),
        },
        400
      );
    }

    const metadataResult = validateCreateRunMetadata(body);
    if (!metadataResult.ok) {
      return c.json({ success: false, error: metadataResult.error }, 400);
    }

    let suite: EvalSuite | null;
    try {
      suite = resolveSuite(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json(
        { success: false, error: buildValidationError(message) },
        400
      );
    }

    if (!suite) {
      if (body.suiteId) {
        return c.json(
          {
            success: false,
            error: buildNotFoundError(`Eval suite "${body.suiteId}" not found`),
          },
          404
        );
      }

      return c.json(
        {
          success: false,
          error: buildValidationError("suite or suiteId is required"),
        },
        400
      );
    }

    if (!orchestrator.canExecute()) {
      return c.json(
        {
          success: false,
          error: buildExecutionUnavailableError(
            "Eval execution target is not configured. This server is running in read-only mode."
          ),
        },
        503
      );
    }

    try {
      const run = await orchestrator.queueRun({
        suite,
        metadata: body.metadata,
      });
      return c.json({ success: true, data: run }, 202);
    } catch (error) {
      const mapped = mapEvalRouteError(error);
      logRouteError(c, "evals", error, mapped.status);
      return c.json(
        {
          success: false,
          error: mapped.error,
        },
        mapped.status
      );
    }
  });

  app.post("/runs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const run = await orchestrator.getRun(id);
    // SEC-M-06: deny + 404 for missing or cross-tenant runs BEFORE any state
    // check or mutation, so another tenant's run stays untouched and its
    // existence/state is not leaked via a 400/409 response.
    if (!run || isCrossTenantRun(run, getOptionalRequestingTenantId(c))) {
      return c.json(
        {
          success: false,
          error: buildNotFoundError("Eval run not found"),
        },
        404
      );
    }

    if (!canCancelRun(run.status)) {
      return c.json(
        {
          success: false,
          error: buildInvalidStateError(
            `Cannot cancel eval run in ${run.status} state`
          ),
        },
        400
      );
    }

    try {
      const cancelled = await orchestrator.cancelRun(id);
      return c.json({ success: true, data: cancelled });
    } catch (error) {
      const mapped = mapEvalRouteError(error);
      logRouteError(c, "evals", error, mapped.status);
      return c.json(
        {
          success: false,
          error: mapped.error,
        },
        mapped.status
      );
    }
  });

  app.post("/runs/:id/retry", async (c) => {
    const id = c.req.param("id");
    const run = await orchestrator.getRun(id);
    // SEC-M-06: deny + 404 for missing or cross-tenant runs BEFORE any state
    // check or mutation, so another tenant's run stays untouched.
    if (!run || isCrossTenantRun(run, getOptionalRequestingTenantId(c))) {
      return c.json(
        {
          success: false,
          error: buildNotFoundError("Eval run not found"),
        },
        404
      );
    }

    if (!canRetryRun(run.status)) {
      return c.json(
        {
          success: false,
          error: buildInvalidStateError(
            `Cannot retry eval run in ${run.status} state`
          ),
        },
        400
      );
    }

    try {
      const retried = await orchestrator.retryRun(id);
      return c.json({ success: true, data: retried }, 202);
    } catch (error) {
      const mapped = mapEvalRouteError(error);
      logRouteError(c, "evals", error, mapped.status);
      return c.json(
        {
          success: false,
          error: mapped.error,
        },
        mapped.status
      );
    }
  });
}
