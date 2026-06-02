/**
 * Deploy confidence and history routes.
 *
 * GET  /api/deploy/confidence    — Compute and return current confidence score + gate decision
 * POST /api/deploy/record        — Record a deployment
 * GET  /api/deploy/history       — List recent deployments
 * PATCH /api/deploy/:id/outcome  — Update deployment outcome
 */
import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import type { DeploymentOutcome } from "../deploy/deployment-history-store.js";
import type { SignalComputationConfig } from "../deploy/signal-checkers.js";
import { computeAllSignals } from "../deploy/signal-checkers.js";
import type { GateDecision } from "../deploy/confidence-types.js";
import type { DeployRouteConfig } from "./deploy-types.js";
import { getOptionalRequestingTenantId } from "./tenant-scope.js";

export type { DeployRouteConfig } from "./deploy-types.js";

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_OUTCOMES: DeploymentOutcome[] = [
  "success",
  "failure",
  "rolled_back",
];
const VALID_GATE_DECISIONS: GateDecision[] = [
  "auto_deploy",
  "deploy_with_warnings",
  "require_approval",
  "block",
];

function isValidOutcome(value: string): value is DeploymentOutcome {
  return VALID_OUTCOMES.includes(value as DeploymentOutcome);
}

function isValidGateDecision(value: string): value is GateDecision {
  return VALID_GATE_DECISIONS.includes(value as GateDecision);
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createDeployRoutes(config: DeployRouteConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { historyStore } = config;
  const defaultEnv = config.defaultEnvironment ?? "production";

  // GET /api/deploy/confidence — compute confidence score
  app.get("/confidence", async (c) => {
    const environment = c.req.query("environment") ?? defaultEnv;
    const projectId = c.req.query("projectId") ?? undefined;
    const testCoverage = c.req.query("testCoverage")
      ? parseFloat(c.req.query("testCoverage")!)
      : undefined;

    const signalConfig: SignalComputationConfig = {
      confidenceConfig: {
        environment,
        thresholds: config.confidenceThresholds,
      },
      agentConfig: config.agentConfig,
      projectId,
      rollbackChecker: config.rollbackChecker,
      historyStore,
      testCoverage,
    };

    const result = await computeAllSignals(signalConfig);

    return c.json({
      data: {
        overallScore: result.confidence.overallScore,
        decision: result.confidence.decision,
        environment: result.confidence.environment,
        signals: result.confidence.signals.map((s) => ({
          name: s.name,
          score: s.score,
          weight: s.weight,
          source: s.source,
          stale: s.stale,
          details: s.details,
        })),
        explanation: result.confidence.explanation,
        computedAt: result.confidence.computedAt.toISOString(),
        recoveryConfigured: result.recoveryConfigured,
        rollbackAvailable: result.rollbackAvailable,
        historicalRate: result.historicalRate,
      },
    });
  });

  // POST /api/deploy/record — record a deployment
  app.post("/record", async (c) => {
    const body = await c.req.json<{
      id: string;
      confidenceScore: number;
      gateDecision: string;
      signalsSnapshot?: Record<string, unknown>[];
      deployedBy?: string;
      environment?: string;
      rollbackAvailable?: boolean;
      notes?: string;
    }>();

    // Validate required fields
    if (!body.id || typeof body.id !== "string") {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "id is required and must be a string",
          },
        },
        400
      );
    }

    if (
      typeof body.confidenceScore !== "number" ||
      body.confidenceScore < 0 ||
      body.confidenceScore > 100
    ) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "confidenceScore must be a number between 0 and 100",
          },
        },
        400
      );
    }

    if (!body.gateDecision || !isValidGateDecision(body.gateDecision)) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: `gateDecision must be one of: ${VALID_GATE_DECISIONS.join(
              ", "
            )}`,
          },
        },
        400
      );
    }

    const environment = body.environment ?? defaultEnv;

    // SEC-M-06: stamp the authenticated tenant so the record is scoped on read.
    // When unauthenticated (`auth.mode="none"`), no tenant is stamped.
    const recordTenantId = getOptionalRequestingTenantId(c);
    const record = await historyStore.record({
      id: body.id,
      confidenceScore: body.confidenceScore,
      gateDecision: body.gateDecision,
      signalsSnapshot: body.signalsSnapshot,
      deployedBy: body.deployedBy,
      environment,
      rollbackAvailable: body.rollbackAvailable,
      notes: body.notes,
      ...(recordTenantId !== undefined ? { tenantId: recordTenantId } : {}),
    });

    return c.json({ data: serializeRecord(record) }, 201);
  });

  // GET /api/deploy/history — list recent deployments
  app.get("/history", async (c) => {
    const limit = parseInt(c.req.query("limit") ?? "20", 10);
    const environment = c.req.query("environment") ?? undefined;

    const clampedLimit = Math.min(Math.max(1, limit), 100);
    // SEC-M-06: scope history to the authenticated tenant (default-deny). When
    // unauthenticated the filter is omitted so legacy un-scoped listing works.
    const records = await historyStore.getRecent(
      clampedLimit,
      environment,
      getOptionalRequestingTenantId(c)
    );

    return c.json({
      data: records.map(serializeRecord),
      total: records.length,
    });
  });

  // PATCH /api/deploy/:id/outcome — update deployment outcome
  app.patch("/:id/outcome", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ outcome: string }>();

    if (!body.outcome || !isValidOutcome(body.outcome)) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: `outcome must be one of: ${VALID_OUTCOMES.join(", ")}`,
          },
        },
        400
      );
    }

    // SEC-M-06: a cross-tenant id yields null (no mutation) → 404 below. When
    // unauthenticated the tenant guard is skipped (legacy mode).
    const updated = await historyStore.markOutcome(
      id,
      body.outcome,
      getOptionalRequestingTenantId(c)
    );

    if (!updated) {
      return c.json(
        { error: { code: "NOT_FOUND", message: `Deployment ${id} not found` } },
        404
      );
    }

    return c.json({ data: serializeRecord(updated) });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Serialization helper
// ---------------------------------------------------------------------------

function serializeRecord(record: {
  id: string;
  confidenceScore: number;
  gateDecision: string;
  signalsSnapshot: Record<string, unknown>[] | null;
  deployedAt: Date;
  deployedBy: string | null;
  environment: string;
  rollbackAvailable: boolean;
  outcome: string | null;
  completedAt: Date | null;
  notes: string | null;
}): Record<string, unknown> {
  return {
    id: record.id,
    confidenceScore: record.confidenceScore,
    gateDecision: record.gateDecision,
    signalsSnapshot: record.signalsSnapshot,
    deployedAt: record.deployedAt.toISOString(),
    deployedBy: record.deployedBy,
    environment: record.environment,
    rollbackAvailable: record.rollbackAvailable,
    outcome: record.outcome,
    completedAt: record.completedAt?.toISOString() ?? null,
    notes: record.notes,
  };
}
