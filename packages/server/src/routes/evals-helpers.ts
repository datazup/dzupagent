/**
 * Pure validators, filter/meta builders, error mapping, and the read-only
 * orchestrator fallback used by the eval REST routes.
 *
 * CODE-M-05: each handler in `createEvalRoutes` previously inlined its body
 * validation, filter construction, and response mapping. Those pure steps live
 * here as module-level functions so they can be unit-tested in isolation,
 * without standing up a Hono app or a store. The route wiring
 * (`./evals-handlers`) calls them; observable HTTP behaviour (status codes,
 * response shapes, checks) is unchanged.
 *
 * ARCH-M-06: extracted from the former single-file `./evals` god-module so the
 * route file becomes a thin composition root. `./evals` re-exports the pure
 * helpers below to preserve the original public import surface.
 */
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { mapErrorToStatus, sanitizeError } from "./route-error.js";
import type {
  EvalOrchestratorLike,
  EvalRunStatus,
  EvalRunStore,
} from "@dzupagent/eval-contracts";

export interface EvalRunCreateRequest {
  suite?: unknown;
  suiteId?: string;
  metadata?: Record<string, unknown>;
}

export interface EvalRunListMeta {
  service: string;
  mode: "active" | "read-only";
  writable: boolean;
  filters: {
    suiteId?: string;
    status?: EvalRunStatus;
    limit: number;
  };
}

export const DEFAULT_SERVICE_NAME = "evals";
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 250;
export const AVAILABLE_ENDPOINTS = [
  "/api/evals/health",
  "/api/evals/queue/stats",
  "/api/evals/runs",
  "/api/evals/runs/:id",
  "/api/evals/runs/:id/cancel",
  "/api/evals/runs/:id/retry",
] as const;

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

export function parseRunStatus(raw: string | undefined): EvalRunStatus | null {
  if (!raw) return null;
  switch (raw) {
    case "queued":
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
      return raw;
    default:
      return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildValidationError(message: string) {
  return { code: "VALIDATION_ERROR", message };
}

export function buildNotFoundError(message: string) {
  return { code: "NOT_FOUND", message };
}

/**
 * SEC-M-06: returns true when a fetched run belongs to a *different* tenant than
 * the requester and must therefore be hidden (treated as not-found, returning
 * 404 rather than 403 to avoid run-id / tenant enumeration).
 *
 * - When the request carries no authenticated tenant (`requesterTenantId` is
 *   undefined — e.g. `auth.mode="none"` legacy mode), there is no tenant
 *   boundary to enforce, so nothing is treated as cross-tenant.
 * - A run with no `tenantId` (legacy / untenanted) is NOT cross-tenant on a
 *   direct-id fetch, preserving backward compatibility for pre-existing runs.
 *
 * Enumeration via `GET /runs` is independently scoped by the store-level tenant
 * filter, which excludes untenanted runs when an authenticated tenant filter is
 * active.
 */
export function isCrossTenantRun(
  run: { tenantId?: string | undefined },
  requesterTenantId: string | undefined
): boolean {
  if (requesterTenantId === undefined) return false;
  return run.tenantId !== undefined && run.tenantId !== requesterTenantId;
}

export function buildExecutionUnavailableError(message: string) {
  return { code: "EVAL_EXECUTION_UNAVAILABLE", message };
}

export function buildInvalidStateError(message: string) {
  return { code: "INVALID_STATE", message };
}

/** Discriminated result of a request-body validator. */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

/**
 * Validates the `GET /runs` query string. Returns the parsed filter inputs, or
 * an error when `status` is present but not a recognized run status.
 */
export function validateRunListQuery(query: {
  suiteId?: string;
  status?: string;
  limit?: string;
}): ValidationResult<{
  suiteId: string | undefined;
  status: EvalRunStatus | null;
  limit: number;
}> {
  const suiteId = query.suiteId || undefined;
  const status = parseRunStatus(query.status || undefined);
  const limit = parseLimit(query.limit || undefined);

  if (query.status && status === null) {
    return {
      ok: false,
      error: buildValidationError(
        "status must be one of queued, running, completed, failed, or cancelled"
      ),
    };
  }

  return { ok: true, value: { suiteId, status, limit } };
}

/**
 * Builds the store-level `listRuns` filter. SEC-M-06: the tenant filter is only
 * applied when the requester carries an authenticated tenant; otherwise it is
 * omitted so legacy un-scoped listing behaviour is preserved.
 */
export function buildRunListFilter(inputs: {
  suiteId: string | undefined;
  status: EvalRunStatus | null;
  limit: number;
  requesterTenantId: string | undefined;
}): {
  suiteId: string | undefined;
  status?: EvalRunStatus;
  limit: number;
  tenantId?: string;
} {
  return {
    suiteId: inputs.suiteId,
    status: inputs.status ?? undefined,
    limit: inputs.limit,
    ...(inputs.requesterTenantId !== undefined
      ? { tenantId: inputs.requesterTenantId }
      : {}),
  };
}

/** Builds the `meta` block returned by `GET /runs`. */
export function buildRunListMeta(inputs: {
  service: string;
  mode: "active" | "read-only";
  writable: boolean;
  suiteId: string | undefined;
  status: EvalRunStatus | null;
  limit: number;
}): EvalRunListMeta {
  return {
    service: inputs.service,
    mode: inputs.mode,
    writable: inputs.writable,
    filters: {
      ...(inputs.suiteId ? { suiteId: inputs.suiteId } : {}),
      ...(inputs.status ? { status: inputs.status } : {}),
      limit: inputs.limit,
    },
  };
}

/**
 * Validates the `POST /runs` body's `metadata` field. `resolveSuite` is kept as
 * a closure inside `createEvalRoutes` because it reads the injected `suites`
 * registry; this validator covers the pure, registry-independent metadata rule.
 */
export function validateCreateRunMetadata(
  body: EvalRunCreateRequest
): ValidationResult<Record<string, unknown> | undefined> {
  if (body.metadata !== undefined && !isPlainObject(body.metadata)) {
    return {
      ok: false,
      error: buildValidationError(
        "metadata must be a plain object when provided"
      ),
    };
  }
  return { ok: true, value: body.metadata };
}

/**
 * State predicate: a run may be cancelled unless it has reached a terminal
 * state (`completed`, `failed`, or `cancelled`).
 */
export function canCancelRun(status: EvalRunStatus): boolean {
  return (
    status !== "completed" && status !== "failed" && status !== "cancelled"
  );
}

/** State predicate: only `failed` runs may be retried. */
export function canRetryRun(status: EvalRunStatus): boolean {
  return status === "failed";
}

export interface EvalRouteErrorResponse {
  status: ContentfulStatusCode;
  error: { code: string; message: string };
}

function isExecutionUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "EvalExecutionUnavailableError") return true;
  const code = (error as { code?: unknown }).code;
  return code === "EVAL_EXECUTION_UNAVAILABLE";
}

function isInvalidStateError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "EvalRunInvalidStateError") return true;
  const code = (error as { code?: unknown }).code;
  return code === "INVALID_STATE";
}

export function mapEvalRouteError(error: unknown): EvalRouteErrorResponse {
  if (isExecutionUnavailableError(error)) {
    return {
      status: 503,
      error: buildExecutionUnavailableError((error as Error).message),
    };
  }

  if (isInvalidStateError(error)) {
    return {
      status: 400,
      error: buildInvalidStateError((error as Error).message),
    };
  }

  // ERR-M-04: derive not-found via the shared status mapper rather than an
  // inline English substring match. A non-404 error returns the 500 fallback,
  // which never equals 404, so it correctly falls through to the 500 branch.
  if (error instanceof Error && mapErrorToStatus(error, 500) === 404) {
    return {
      status: 404,
      error: buildNotFoundError(error.message),
    };
  }

  return {
    status: 500,
    error: {
      code: "EVAL_RUN_FAILED",
      // Sanitize: never forward raw internal/DB error text to the client on
      // the catch-all 500 branch. The 503/400/404 branches above use
      // deliberately-shaped, client-safe messages.
      message: sanitizeError(error).safe,
    },
  };
}

/**
 * Minimal no-op orchestrator used when the host neither provides an injected
 * orchestrator nor an orchestrator factory. This keeps the eval routes mounted
 * in read-only mode so `/health`, `/queue/stats`, `/runs`, `/runs/:id` still
 * respond (empty/read-only) without requiring `@dzupagent/evals`.
 *
 * IMPORTANT (MJ-CODE-01): the route deliberately does NOT ship a writable
 * default executor. The single canonical eval execution lifecycle —
 * including queue/lease/retry/recovery/attempt-history semantics — lives in
 * `@dzupagent/evals` (`EvalOrchestrator`). Hosts wanting eval execution must
 * inject either `orchestrator` or `orchestratorFactory`; we never duplicate
 * the state machine here.
 */
export class ReadOnlyEvalOrchestrator implements EvalOrchestratorLike {
  constructor(private readonly store: EvalRunStore) {}

  canExecute(): boolean {
    return false;
  }

  async queueRun(): Promise<never> {
    const err = new Error(
      "Eval execution target is not configured. This server is running in read-only mode."
    );
    (err as Error & { code?: string }).code = "EVAL_EXECUTION_UNAVAILABLE";
    err.name = "EvalExecutionUnavailableError";
    throw err;
  }

  async cancelRun(): Promise<never> {
    const err = new Error("Eval orchestrator is read-only");
    (err as Error & { code?: string }).code = "INVALID_STATE";
    err.name = "EvalRunInvalidStateError";
    throw err;
  }

  async retryRun(): Promise<never> {
    const err = new Error("Eval orchestrator is read-only");
    (err as Error & { code?: string }).code = "INVALID_STATE";
    err.name = "EvalRunInvalidStateError";
    throw err;
  }

  async getRun(runId: string) {
    return this.store.getRun(runId);
  }

  async listRuns(filter?: Parameters<EvalRunStore["listRuns"]>[0]) {
    return this.store.listRuns(filter);
  }

  async getQueueStats() {
    return {
      pending: 0,
      active: 0,
      oldestPendingAgeMs: null,
      enqueued: 0,
      started: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      retried: 0,
      recovered: 0,
      requeued: 0,
    };
  }
}
