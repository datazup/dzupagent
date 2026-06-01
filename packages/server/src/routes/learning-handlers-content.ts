/**
 * Lesson and rule listing handlers plus the `/ingest` endpoint that persists
 * learning patterns for the self-learning pipeline. Registered onto an
 * existing Hono instance by `createLearningRoutes`.
 */
import type { Hono } from "hono";
import { logRouteError } from "./route-error.js";
import type { MemoryServiceLike } from "@dzupagent/memory-ipc";
import type { AppEnv } from "../types.js";
import {
  IngestSchema,
  isLearningPattern,
  parsePositiveInt,
  resolveTenantId,
  storeLearningPattern,
  tenantScope,
} from "./learning-schemas.js";

export interface ContentHandlerDeps {
  memoryService: MemoryServiceLike;
  defaultTenantId: string;
  ingestThreshold: number;
  ingestTtlMs: number;
}

export function registerContentHandlers(
  app: Hono<AppEnv>,
  deps: ContentHandlerDeps
): void {
  const { memoryService, defaultTenantId, ingestThreshold, ingestTtlMs } = deps;

  // ── GET /lessons — get top lessons ───────────────────────────
  app.get("/lessons", async (c) => {
    const tenantId = resolveTenantId(c, defaultTenantId);
    const scope = tenantScope(tenantId);
    const limit = parsePositiveInt(c.req.query("limit"), 10);
    const nodeId = c.req.query("nodeId");
    const taskType = c.req.query("taskType");

    try {
      const lessons = await memoryService.search("lessons", scope, "", 10000);

      let filtered = lessons;
      if (nodeId) {
        filtered = filtered.filter((l) => l["nodeId"] === nodeId);
      }
      if (taskType) {
        filtered = filtered.filter((l) => l["taskType"] === taskType);
      }

      // Sort by importance descending (if available)
      filtered.sort((a, b) => {
        const ia = typeof a["importance"] === "number" ? a["importance"] : 0;
        const ib = typeof b["importance"] === "number" ? b["importance"] : 0;
        return ib - ia;
      });

      return c.json({ success: true, data: filtered.slice(0, limit) });
    } catch (err) {
      const { safe } = logRouteError(c, "learning.content", err, 500);
      return c.json({ success: false, error: safe }, 500);
    }
  });

  // ── GET /rules — get top rules ───────────────────────────────
  app.get("/rules", async (c) => {
    const tenantId = resolveTenantId(c, defaultTenantId);
    const scope = tenantScope(tenantId);
    const limit = parsePositiveInt(c.req.query("limit"), 10);

    try {
      const rules = await memoryService.search("rules", scope, "", 10000);

      // Sort by priority descending (if available)
      rules.sort((a, b) => {
        const pa = typeof a["priority"] === "number" ? a["priority"] : 0;
        const pb = typeof b["priority"] === "number" ? b["priority"] : 0;
        return pb - pa;
      });

      return c.json({ success: true, data: rules.slice(0, limit) });
    } catch (err) {
      const { safe } = logRouteError(c, "learning.content", err, 500);
      return c.json({ success: false, error: safe }, 500);
    }
  });

  // ── POST /ingest — persist learning patterns (Step 3) ────────
  app.post("/ingest", async (c) => {
    const tenantId = resolveTenantId(c, defaultTenantId);
    const scope = tenantScope(tenantId);

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ success: false, error: "invalid JSON body" }, 400);
    }
    const parsed = IngestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const field = first?.path.join(".") ?? "body";
      return c.json(
        { success: false, error: `${field}: ${first?.message ?? "invalid"}` },
        400
      );
    }
    const body = parsed.data;

    const provenance: { runId: string; score: number; agentId?: string } = {
      runId: body.runId,
      score: body.score,
      ...(body.agentId !== undefined ? { agentId: body.agentId } : {}),
    };

    let stored = 0;
    let skipped = 0;
    const storedKeys: string[] = [];
    const failures: string[] = [];

    for (const raw of body.patterns) {
      if (!isLearningPattern(raw)) {
        skipped++;
        continue;
      }
      if (raw.confidence < ingestThreshold) {
        skipped++;
        continue;
      }
      try {
        const key = await storeLearningPattern(
          memoryService,
          scope,
          raw,
          provenance,
          ingestTtlMs
        );
        stored++;
        storedKeys.push(key);
      } catch (err) {
        // Per-item failure reason is returned to the client; sanitize so a
        // failing store does not leak internal/DB error text.
        const { safe } = logRouteError(c, "learning.content.ingest", err, 200);
        failures.push(safe);
      }
    }

    if (failures.length > 0 && stored === 0) {
      return c.json(
        {
          success: false,
          error: `memory service failed for all patterns: ${failures[0]}`,
          stored,
          skipped,
        },
        500
      );
    }

    return c.json({
      success: true,
      stored,
      skipped,
      keys: storedKeys,
      ...(failures.length > 0 ? { warnings: failures } : {}),
    });
  });
}
