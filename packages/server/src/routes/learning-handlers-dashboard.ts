/**
 * Dashboard, overview, trend, and per-node summary handlers for the learning
 * routes. Registered onto an existing Hono instance by `createLearningRoutes`.
 */
import type { Hono } from "hono";
import { logRouteError } from "./route-error.js";
import type { MemoryServiceLike } from "@dzupagent/memory-ipc";
import type { AppEnv } from "../types.js";
import {
  parsePositiveInt,
  resolveTenantId,
  settledResults,
  tenantScope,
} from "./learning-schemas.js";

export interface DashboardHandlerDeps {
  memoryService: MemoryServiceLike;
  defaultTenantId: string;
}

export function registerDashboardHandlers(
  app: Hono<AppEnv>,
  deps: DashboardHandlerDeps
): void {
  const { memoryService, defaultTenantId } = deps;

  /**
   * Search, reporting whether the store was actually reachable.
   *
   * `searchWithStatus` is optional on the port, so fall back to plain
   * `search`. In that case reachability is genuinely unknown rather than
   * known-good, but plain `search` cannot tell us either way - so this
   * reports false and the dashboard is no worse off than before.
   */
  const searchWithStatus = (
    namespace: string,
    scope: Record<string, string>,
    query: string,
    limit: number,
  ): Promise<{ results: Record<string, unknown>[]; searchFailed: boolean }> =>
    memoryService.searchWithStatus
      ? memoryService.searchWithStatus(namespace, scope, query, limit)
      : memoryService
          .search(namespace, scope, query, limit)
          .then((results) => ({ results, searchFailed: false }));

  // ── GET /dashboard — full dashboard ──────────────────────────
  app.get("/dashboard", async (c) => {
    const tenantId = resolveTenantId(c, defaultTenantId);
    const scope = tenantScope(tenantId);

    try {
      const [
        lessons,
        rules,
        skills,
        trajectories,
        feedback,
        packsLoaded,
        errors,
      ] = await Promise.allSettled([
        searchWithStatus("lessons", scope, "", 1000),
        searchWithStatus("rules", scope, "", 1000),
        searchWithStatus("skills", scope, "", 1000),
        searchWithStatus("trajectories", scope, "", 1000),
        searchWithStatus("feedback", scope, "", 1000),
        searchWithStatus("packs_loaded", scope, "", 1000),
        searchWithStatus("errors", scope, "", 1000),
      ]);

      // A namespace whose store could not be read contributes 0 to its count.
      // Reporting that as fact would tell an operator the agent has learned
      // nothing at precisely the moment its memory is unreachable, so the
      // response declares the figures partial instead.
      const partial = [
        lessons,
        rules,
        skills,
        trajectories,
        feedback,
        packsLoaded,
        errors,
      ].some((r) => r.status === "rejected" || r.value.searchFailed);

      const lessonsArr = settledResults(lessons);
      const rulesArr = settledResults(rules);
      const skillsArr = settledResults(skills);
      const trajectoriesArr = settledResults(trajectories);
      const feedbackArr = settledResults(feedback);
      const packsArr = settledResults(packsLoaded);
      const errorsArr = settledResults(errors);

      // Compute quality trend from trajectories
      const qualityTrend = trajectoriesArr
        .filter((t) => typeof t["qualityScore"] === "number")
        .sort((a, b) => {
          const ta = typeof a["timestamp"] === "string" ? a["timestamp"] : "";
          const tb = typeof b["timestamp"] === "string" ? b["timestamp"] : "";
          return ta.localeCompare(tb);
        })
        .slice(-20)
        .map((t) => ({
          timestamp: t["timestamp"] ?? null,
          score: t["qualityScore"] ?? null,
          nodeId: t["nodeId"] ?? null,
        }));

      // Compute cost trend from trajectories
      const costTrend = trajectoriesArr
        .filter((t) => typeof t["costCents"] === "number")
        .sort((a, b) => {
          const ta = typeof a["timestamp"] === "string" ? a["timestamp"] : "";
          const tb = typeof b["timestamp"] === "string" ? b["timestamp"] : "";
          return ta.localeCompare(tb);
        })
        .slice(-20)
        .map((t) => ({
          timestamp: t["timestamp"] ?? null,
          costCents: t["costCents"] ?? null,
          nodeId: t["nodeId"] ?? null,
        }));

      // Feedback stats
      const approvedCount = feedbackArr.filter(
        (f) => f["approved"] === true
      ).length;
      const rejectedCount = feedbackArr.filter(
        (f) => f["approved"] === false
      ).length;

      return c.json({
        success: true,
        partial,
        data: {
          lessonCount: lessonsArr.length,
          ruleCount: rulesArr.length,
          skillCount: skillsArr.length,
          trajectoryCount: trajectoriesArr.length,
          feedbackCount: feedbackArr.length,
          packCount: packsArr.length,
          errorCount: errorsArr.length,
          lessons: lessonsArr.slice(0, 20),
          rules: rulesArr.slice(0, 20),
          skills: skillsArr.slice(0, 20),
          qualityTrend,
          costTrend,
          feedbackStats: {
            total: feedbackArr.length,
            approved: approvedCount,
            rejected: rejectedCount,
          },
        },
      });
    } catch (err) {
      const { safe } = logRouteError(c, "learning.dashboard", err, 500);
      return c.json({ success: false, error: safe }, 500);
    }
  });

  // ── GET /overview — lightweight overview ─────────────────────
  app.get("/overview", async (c) => {
    const tenantId = resolveTenantId(c, defaultTenantId);
    const scope = tenantScope(tenantId);

    try {
      const [lessons, rules, skills] = await Promise.allSettled([
        searchWithStatus("lessons", scope, "", 1000),
        searchWithStatus("rules", scope, "", 1000),
        searchWithStatus("skills", scope, "", 1000),
      ]);

      const partial = [lessons, rules, skills].some(
        (r) => r.status === "rejected" || r.value.searchFailed,
      );

      return c.json({
        success: true,
        partial,
        data: {
          lessonCount: settledResults(lessons).length,
          ruleCount: settledResults(rules).length,
          skillCount: settledResults(skills).length,
        },
      });
    } catch (err) {
      const { safe } = logRouteError(c, "learning.dashboard", err, 500);
      return c.json({ success: false, error: safe }, 500);
    }
  });

  // ── GET /trends/quality — quality trend ──────────────────────
  app.get("/trends/quality", async (c) => {
    const tenantId = resolveTenantId(c, defaultTenantId);
    const scope = tenantScope(tenantId);
    const limit = parsePositiveInt(c.req.query("limit"), 20);

    try {
      const trajectories = await memoryService.search(
        "trajectories",
        scope,
        "",
        10000
      );

      const trend = trajectories
        .filter((t) => typeof t["qualityScore"] === "number")
        .sort((a, b) => {
          const ta = typeof a["timestamp"] === "string" ? a["timestamp"] : "";
          const tb = typeof b["timestamp"] === "string" ? b["timestamp"] : "";
          return ta.localeCompare(tb);
        })
        .slice(-limit)
        .map((t) => ({
          timestamp: t["timestamp"] ?? null,
          score: t["qualityScore"] ?? null,
          nodeId: t["nodeId"] ?? null,
          runId: t["runId"] ?? null,
        }));

      return c.json({ success: true, data: trend });
    } catch (err) {
      const { safe } = logRouteError(c, "learning.dashboard", err, 500);
      return c.json({ success: false, error: safe }, 500);
    }
  });

  // ── GET /trends/cost — cost trend ────────────────────────────
  app.get("/trends/cost", async (c) => {
    const tenantId = resolveTenantId(c, defaultTenantId);
    const scope = tenantScope(tenantId);
    const limit = parsePositiveInt(c.req.query("limit"), 20);

    try {
      const trajectories = await memoryService.search(
        "trajectories",
        scope,
        "",
        10000
      );

      const trend = trajectories
        .filter((t) => typeof t["costCents"] === "number")
        .sort((a, b) => {
          const ta = typeof a["timestamp"] === "string" ? a["timestamp"] : "";
          const tb = typeof b["timestamp"] === "string" ? b["timestamp"] : "";
          return ta.localeCompare(tb);
        })
        .slice(-limit)
        .map((t) => ({
          timestamp: t["timestamp"] ?? null,
          costCents: t["costCents"] ?? null,
          nodeId: t["nodeId"] ?? null,
          runId: t["runId"] ?? null,
        }));

      return c.json({ success: true, data: trend });
    } catch (err) {
      const { safe } = logRouteError(c, "learning.dashboard", err, 500);
      return c.json({ success: false, error: safe }, 500);
    }
  });

  // ── GET /nodes — per-node performance summaries ──────────────
  app.get("/nodes", async (c) => {
    const tenantId = resolveTenantId(c, defaultTenantId);
    const scope = tenantScope(tenantId);

    try {
      const trajectories = await memoryService.search(
        "trajectories",
        scope,
        "",
        10000
      );

      // Group by nodeId
      const nodeMap = new Map<
        string,
        { scores: number[]; costs: number[]; count: number }
      >();

      for (const t of trajectories) {
        const nodeId =
          typeof t["nodeId"] === "string" ? t["nodeId"] : "unknown";
        let entry = nodeMap.get(nodeId);
        if (!entry) {
          entry = { scores: [], costs: [], count: 0 };
          nodeMap.set(nodeId, entry);
        }
        entry.count++;
        if (typeof t["qualityScore"] === "number") {
          entry.scores.push(t["qualityScore"]);
        }
        if (typeof t["costCents"] === "number") {
          entry.costs.push(t["costCents"]);
        }
      }

      const nodes = Array.from(nodeMap.entries()).map(([nodeId, entry]) => {
        const avgScore =
          entry.scores.length > 0
            ? entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length
            : null;
        const totalCost =
          entry.costs.length > 0 ? entry.costs.reduce((a, b) => a + b, 0) : 0;

        return {
          nodeId,
          runCount: entry.count,
          avgQualityScore:
            avgScore !== null ? Math.round(avgScore * 100) / 100 : null,
          totalCostCents: Math.round(totalCost * 100) / 100,
        };
      });

      return c.json({ success: true, data: nodes });
    } catch (err) {
      const { safe } = logRouteError(c, "learning.dashboard", err, 500);
      return c.json({ success: false, error: safe }, 500);
    }
  });
}
