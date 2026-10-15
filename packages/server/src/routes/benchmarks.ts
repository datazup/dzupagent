import { Hono } from "hono";
import type { Context } from "hono";
import { logRouteError, mapErrorToStatus } from "./route-error.js";
import type { AppEnv } from "../types.js";
import type {
  BenchmarkOrchestratorLike,
  BenchmarkRunArtifactRecord,
  BenchmarkRunStore,
} from "@dzupagent/eval-contracts";
import { InMemoryBenchmarkRunStore } from "../persistence/benchmark-run-store.js";
import type {
  BenchmarkOrchestratorFactory,
  BenchmarkRouteConfig,
} from "./benchmarks-types.js";
import { getRequestingTenantId } from "./tenant-scope.js";
import { TenantScopedBenchmarkOrchestrator } from "./benchmark-tenant-scope.js";

export type {
  BenchmarkOrchestratorFactory,
  BenchmarkRouteConfig,
} from "./benchmarks-types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;

function parseLimit(raw: string | undefined): {
  limit: number;
  invalid: boolean;
} {
  if (raw === undefined) {
    return { limit: DEFAULT_LIMIT, invalid: false };
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { limit: DEFAULT_LIMIT, invalid: true };
  }

  return {
    limit: Math.min(MAX_LIMIT, parsed),
    invalid: false,
  };
}

interface BenchmarkRunCursor {
  createdAt: string;
  id: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isPlainObject(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function parseArtifact(raw: unknown): {
  artifact?: BenchmarkRunArtifactRecord;
  invalid: boolean;
} {
  if (raw === undefined) {
    return { artifact: undefined, invalid: false };
  }

  if (!isStringRecord(raw)) {
    return { artifact: undefined, invalid: true };
  }

  const artifact = raw as Record<string, string>;
  const requiredKeys: Array<keyof BenchmarkRunArtifactRecord> = [
    "suiteVersion",
    "datasetHash",
    "promptConfigVersion",
    "buildSha",
    "modelProfile",
  ];

  if (
    !requiredKeys.every(
      (key) =>
        typeof artifact[key] === "string" && artifact[key].trim().length > 0,
    )
  ) {
    return { artifact: undefined, invalid: true };
  }

  const typedArtifact = artifact as unknown as BenchmarkRunArtifactRecord;
  return {
    artifact: typedArtifact,
    invalid: false,
  };
}

function parseCursor(raw: string | undefined): {
  cursor: string | undefined;
  invalid: boolean;
} {
  if (raw === undefined) {
    return { cursor: undefined, invalid: false };
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as unknown;
    if (!isPlainObject(parsed)) {
      return { cursor: undefined, invalid: true };
    }

    const cursor = parsed as Partial<BenchmarkRunCursor>;
    if (typeof cursor.createdAt !== "string" || typeof cursor.id !== "string") {
      return { cursor: undefined, invalid: true };
    }

    return { cursor: raw, invalid: false };
  } catch {
    return { cursor: undefined, invalid: true };
  }
}

/**
 * DZUPAGENT-ERR-H-68: error response for a benchmark write route. Only a typed
 * client error (a ClientSafeError / `code` such as `*_NOT_FOUND`, `*_INVALID`,
 * or a NotFound/Validation/BadRequest/Conflict prefix) keeps a 4xx and the
 * route's failure code; anything unclassified — a store outage, a thrown
 * driver error — is a 5xx with an internal code. The client always receives
 * the sanitized message (ERR-M-02).
 */
function benchmarkErrorResponse(
  c: Context<AppEnv>,
  error: unknown,
  failureCode: string,
): Response {
  const status = mapErrorToStatus(error, 500);
  const logged = logRouteError(c, "benchmarks", error, status);
  const code =
    status === 503
      ? "SERVICE_UNAVAILABLE"
      : status >= 500
        ? "INTERNAL_ERROR"
        : failureCode;
  return c.json({ error: { code, message: logged.safe } }, status);
}

/** Parsed JSON object body, or `undefined` for a malformed or non-object body. */
async function readJsonBody<T extends object>(
  c: Context<AppEnv>,
): Promise<T | undefined> {
  try {
    const body = await c.req.json<unknown>();
    return body !== null && typeof body === "object" ? (body as T) : undefined;
  } catch {
    return undefined;
  }
}

function buildValidationErrorBody(message: string) {
  return { error: { code: "VALIDATION_ERROR", message } };
}

function buildValidationError(message: string) {
  return { code: "VALIDATION_ERROR", message };
}

function parseStrict(raw: unknown): { strict?: boolean; invalid: boolean } {
  if (raw === undefined) {
    return { strict: undefined, invalid: false };
  }

  if (typeof raw !== "boolean") {
    return { strict: undefined, invalid: true };
  }

  return { strict: raw, invalid: false };
}

/**
 * Fallback orchestrator used when the host doesn't supply a concrete one.
 * Write endpoints throw 503; read endpoints proxy directly to the store.
 */
/** Typed so `mapErrorToStatus` answers 503 rather than a client-error status. */
function orchestratorUnavailable(): Error {
  return Object.assign(
    new Error("Benchmark orchestrator is not configured on this server"),
    { code: "BENCHMARK_ORCHESTRATOR_UNAVAILABLE" },
  );
}

class ReadOnlyBenchmarkOrchestrator implements BenchmarkOrchestratorLike {
  constructor(private readonly store: BenchmarkRunStore) {}

  async runSuite(): Promise<never> {
    throw orchestratorUnavailable();
  }

  async getRun(runId: string) {
    return this.store.getRun(runId);
  }

  async listRuns(filter?: Parameters<BenchmarkRunStore["listRuns"]>[0]) {
    return this.store.listRuns(filter);
  }

  async compareRuns(): Promise<never> {
    throw orchestratorUnavailable();
  }

  async setBaseline(): Promise<never> {
    throw orchestratorUnavailable();
  }

  async getBaseline(suiteId: string, targetId: string) {
    return this.store.getBaseline(suiteId, targetId);
  }

  async listBaselines(filter?: { suiteId?: string; targetId?: string }) {
    return this.store.listBaselines(filter);
  }
}

export function createBenchmarkRoutes(
  config: BenchmarkRouteConfig,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const store = config.store ?? new InMemoryBenchmarkRunStore();
  const suites = config.suites ?? {};

  let orchestrator: BenchmarkOrchestratorLike;
  if (config.orchestrator) {
    orchestrator = config.orchestrator;
  } else if (config.orchestratorFactory) {
    const factoryDeps: Parameters<BenchmarkOrchestratorFactory>[0] = {
      suites,
      executeTarget: config.executeTarget,
      store,
    };
    if (config.allowNonStrictExecution !== undefined) {
      factoryDeps.allowNonStrictExecution = config.allowNonStrictExecution;
    }
    orchestrator = config.orchestratorFactory(factoryDeps);
  } else {
    orchestrator = new ReadOnlyBenchmarkOrchestrator(store);
  }

  function scopedOrchestrator(
    c: Context<AppEnv>,
  ): TenantScopedBenchmarkOrchestrator {
    return new TenantScopedBenchmarkOrchestrator({
      orchestrator,
      store,
      tenantId: getRequestingTenantId(c),
    });
  }

  app.get("/runs", async (c) => {
    const suiteId = c.req.query("suiteId") || undefined;
    const targetId = c.req.query("targetId") || undefined;
    const rawLimit = c.req.query("limit") || undefined;
    const rawCursor = c.req.query("cursor") || undefined;
    const { limit, invalid } = parseLimit(rawLimit);
    const { cursor, invalid: invalidCursor } = parseCursor(rawCursor);

    if (invalid || invalidCursor) {
      return c.json(
        {
          success: false,
          error: buildValidationError(
            invalid
              ? "limit must be a positive integer"
              : "cursor must be a valid pagination cursor",
          ),
        },
        400,
      );
    }

    const scoped = scopedOrchestrator(c);
    const page = await scoped.listRuns({ suiteId, targetId, limit, cursor });
    return c.json({
      success: true,
      data: page.data,
      count: page.data.length,
      meta: {
        service: "benchmarks",
        filters: {
          ...(suiteId ? { suiteId } : {}),
          ...(targetId ? { targetId } : {}),
          limit,
        },
        pagination: {
          ...(cursor ? { cursor } : {}),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        },
      },
    });
  });

  app.post("/runs", async (c) => {
    try {
      const body = await readJsonBody<{
        suiteId: string;
        targetId: string;
        strict?: unknown;
        metadata?: Record<string, unknown>;
        artifact?: unknown;
      }>(c);
      if (!body) return c.json(buildValidationErrorBody("Invalid JSON body"), 400);
      if (!body.suiteId || !body.targetId) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "suiteId and targetId are required",
            },
          },
          400,
        );
      }

      const { artifact, invalid } = parseArtifact(body.artifact);
      if (invalid) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message:
                "artifact must include suiteVersion, datasetHash, promptConfigVersion, buildSha, and modelProfile",
            },
          },
          400,
        );
      }

      const strict = parseStrict(body.strict);
      if (strict.invalid) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "strict must be a boolean when provided",
            },
          },
          400,
        );
      }

      const scoped = scopedOrchestrator(c);
      const run = await scoped.runSuite({
        suiteId: body.suiteId,
        targetId: body.targetId,
        strict: strict.strict,
        metadata: body.metadata,
        ...(artifact ? { artifact } : {}),
      });

      return c.json({ data: run }, 201);
    } catch (error) {
      return benchmarkErrorResponse(c, error, "BENCHMARK_RUN_FAILED");
    }
  });

  app.get("/runs/:id", async (c) => {
    const scoped = scopedOrchestrator(c);
    const run = await scoped.getRun(c.req.param("id"));
    if (!run) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Benchmark run not found" } },
        404,
      );
    }
    return c.json({ data: run });
  });

  app.post("/compare", async (c) => {
    try {
      const body = await readJsonBody<{
        currentRunId: string;
        previousRunId?: string;
      }>(c);
      if (!body) return c.json(buildValidationErrorBody("Invalid JSON body"), 400);
      if (!body.currentRunId) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "currentRunId is required",
            },
          },
          400,
        );
      }

      const scoped = scopedOrchestrator(c);

      if (body.previousRunId) {
        const compared = await scoped.compareRuns(
          body.currentRunId,
          body.previousRunId,
        );
        return c.json({ data: compared });
      }

      const currentRun = await scoped.getRun(body.currentRunId);
      if (!currentRun) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Current run not found" } },
          404,
        );
      }
      const baseline = await scoped.getBaseline(
        currentRun.suiteId,
        currentRun.targetId,
      );
      if (!baseline) {
        return c.json(
          {
            error: {
              code: "NOT_FOUND",
              message: "No baseline found for suite/target",
            },
          },
          404,
        );
      }
      const compared = await scoped.compareRuns(currentRun.id, baseline.runId);
      return c.json({ data: compared });
    } catch (error) {
      return benchmarkErrorResponse(c, error, "BENCHMARK_COMPARE_FAILED");
    }
  });

  app.get("/baselines", async (c) => {
    const suiteId = c.req.query("suiteId");
    const targetId = c.req.query("targetId");
    const scoped = scopedOrchestrator(c);
    const baselines = await scoped.listBaselines({
      suiteId: suiteId ?? undefined,
      targetId: targetId ?? undefined,
    });
    return c.json({ data: baselines, count: baselines.length });
  });

  app.put("/baselines/:suiteId", async (c) => {
    try {
      const suiteId = c.req.param("suiteId");
      const body = await readJsonBody<{ targetId: string; runId: string }>(c);
      if (!body) return c.json(buildValidationErrorBody("Invalid JSON body"), 400);
      if (!suiteId || !body.targetId || !body.runId) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "suiteId, targetId and runId are required",
            },
          },
          400,
        );
      }
      const scoped = scopedOrchestrator(c);
      const baseline = await scoped.setBaseline({
        suiteId,
        targetId: body.targetId,
        runId: body.runId,
      });
      return c.json({ data: baseline });
    } catch (error) {
      return benchmarkErrorResponse(c, error, "BASELINE_UPDATE_FAILED");
    }
  });

  return app;
}
