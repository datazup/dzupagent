/**
 * Cost showback routes (Stage 4-E).
 *
 * - GET /admin/tenants/:tenantId/cost — per-tenant cost summary.
 * - GET /admin/tenants/cost          — cost summaries for all tenants.
 *
 * Both accept `?since=<ISO>` and `?statuses=completed,failed` query params,
 * delegating aggregation to the injected {@link CostAttributor}.
 */
import { Hono } from "hono";

import type { AppEnv } from "../types.js";
import type {
  CostAttributor,
  CostAttributorQuery,
} from "../services/cost-attributor.js";

export interface CostAttributorRouteConfig {
  costAttributor: CostAttributor;
}

/** Parse `since` + `statuses` query params into a {@link CostAttributorQuery}. */
function parseQuery(url: URL): CostAttributorQuery {
  const query: CostAttributorQuery = {};
  const since = url.searchParams.get("since");
  if (since) {
    query.since = since;
  }
  const statuses = url.searchParams.get("statuses");
  if (statuses) {
    const parsed = statuses
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parsed.length > 0) {
      query.statuses = parsed;
    }
  }
  return query;
}

export function createCostAttributorRoutes(
  config: CostAttributorRouteConfig
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Specific route registered before the param route so `/cost` is not
  // captured by `/:tenantId`.
  app.get("/cost", async (c) => {
    const query = parseQuery(new URL(c.req.url));
    const summaries = await config.costAttributor.getAllTenantCosts(query);
    return c.json({ data: summaries });
  });

  app.get("/:tenantId/cost", async (c) => {
    const tenantId = c.req.param("tenantId");
    const query = parseQuery(new URL(c.req.url));
    const summary = await config.costAttributor.getTenantCost(tenantId, query);
    return c.json({ data: summary });
  });

  return app;
}
