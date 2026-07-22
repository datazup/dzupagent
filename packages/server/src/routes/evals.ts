/**
 * Eval REST API routes — HTTP endpoints for queueing, listing, cancelling, and
 * retrying eval runs against an injected orchestrator.
 *
 * GET  /health              — service health + mode (active | read-only)
 * GET  /queue/stats         — orchestrator queue statistics
 * GET  /runs                — list runs (query: ?suiteId=&status=&limit=)
 * GET  /runs/:id            — fetch a single run (tenant-scoped)
 * POST /runs                — queue a run for a server-registered suite
 * POST /runs/:id/cancel     — cancel a non-terminal run
 * POST /runs/:id/retry      — retry a failed run
 *
 * This file is a thin composition root — implementations live in:
 *   - `./evals-helpers`  — pure validators, filter/meta builders, error
 *                          mapping, and the read-only orchestrator fallback
 *   - `./evals-handlers` — the Hono route handlers
 *   - `./evals-types`    — `EvalRouteConfig` / `EvalOrchestratorFactory`
 *
 * ARCH-M-06: decomposed from a former single-file god-module that fused
 * validation, error mapping, the read-only orchestrator, and route wiring. The
 * re-exports below preserve the original public import surface so callers (and
 * `eval-route-helpers.test.ts`) keep importing from `./routes/evals`.
 */
import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import type {
  EvalOrchestratorLike,
  EvalSuite,
} from "@dzupagent/eval-contracts";
import { InMemoryEvalRunStore } from "../persistence/eval-run-store.js";
import type {
  EvalOrchestratorFactory,
  EvalRouteConfig,
} from "./evals-types.js";
import {
  DEFAULT_SERVICE_NAME,
  ReadOnlyEvalOrchestrator,
  type EvalRunCreateRequest,
} from "./evals-helpers.js";
import { registerEvalHandlers } from "./evals-handlers.js";

// ── Re-exports preserving the original public surface ──────────────────────

export type {
  EvalOrchestratorFactory,
  EvalRouteConfig,
} from "./evals-types.js";

export {
  buildRunListFilter,
  buildRunListMeta,
  canCancelRun,
  canRetryRun,
  validateCreateRunMetadata,
  validateRunListQuery,
} from "./evals-helpers.js";

export function createEvalRoutes(config: EvalRouteConfig = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const serviceName = config.serviceName ?? DEFAULT_SERVICE_NAME;
  const store = config.store ?? new InMemoryEvalRunStore();

  // Require explicit opt-in to read-only mode when no execution capability is configured.
  if (
    !config.orchestrator &&
    !config.orchestratorFactory &&
    !config.executeTarget &&
    !config.allowReadOnlyMode
  ) {
    throw new Error(
      "Eval routes require an execution target or allowReadOnlyMode: true. " +
        "Provide evals.orchestrator, evals.orchestratorFactory, or set evals.allowReadOnlyMode to true."
    );
  }

  // MJ-CODE-01: the server route no longer ships an in-route executor. When a
  // host supplies an executeTarget without an orchestrator/factory, fail fast
  // and direct them to the canonical implementation. This guarantees one
  // lifecycle implementation (the one in @dzupagent/evals).
  if (
    config.executeTarget &&
    !config.orchestrator &&
    !config.orchestratorFactory
  ) {
    throw new Error(
      "evals.executeTarget was provided without an orchestrator or orchestratorFactory. " +
        "Inject an orchestrator (e.g. `(deps) => new EvalOrchestrator(deps)` from @dzupagent/evals) " +
        "so the canonical eval execution lifecycle is used. The server no longer ships a fallback executor."
    );
  }

  let orchestrator: EvalOrchestratorLike;
  if (config.orchestrator) {
    orchestrator = config.orchestrator;
  } else if (config.orchestratorFactory) {
    const deps: Parameters<EvalOrchestratorFactory>[0] = { store };
    if (config.executeTarget) deps.executeTarget = config.executeTarget;
    if (config.allowReadOnlyMode !== undefined)
      deps.allowReadOnlyMode = config.allowReadOnlyMode;
    if (config.metrics) deps.metrics = config.metrics;
    orchestrator = config.orchestratorFactory(deps);
  } else {
    orchestrator = new ReadOnlyEvalOrchestrator(store);
  }

  const mode: "active" | "read-only" = orchestrator.canExecute()
    ? "active"
    : "read-only";

  function resolveSuite(body: EvalRunCreateRequest): EvalSuite | null {
    if (body.suiteId) {
      const resolved = config.suites?.[body.suiteId];
      return resolved ?? null;
    }

    if (body.suite !== undefined) {
      throw new Error(
        "Inline suite payloads are not supported over HTTP; provide suiteId for a server-registered suite"
      );
    }

    return null;
  }

  registerEvalHandlers(app, { orchestrator, serviceName, mode, resolveSuite });

  return app;
}
