/**
 * Agent definition management routes.
 *
 * Canonical path:
 * GET    /api/agent-definitions      — List agent definitions
 * POST   /api/agent-definitions      — Create agent definition
 * GET    /api/agent-definitions/:id  — Get agent definition by ID
 * PATCH  /api/agent-definitions/:id  — Update agent definition
 * DELETE /api/agent-definitions/:id  — Soft-delete agent definition
 *
 * Compatibility alias:
 * - `/api/agents/*`
 *
 * CRUD mechanics (tenant resolution, body validation, `{ data }` / NOT_FOUND
 * envelopes) go through `./crud-helpers.js` (CODE-L-02). The response shapes
 * are byte-for-byte identical to the previous hand-written handlers.
 */
import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import type { ForgeServerConfig } from "../composition/types.js";
import { AgentDefinitionService } from "../services/agent-definition-service.js";
import {
  AgentCreateSchema,
  AgentUpdateSchema,
  parseIntBounded,
} from "./schemas.js";
import { tenantOf, data, notFound, body } from "./crud-helpers.js";

export function createAgentDefinitionRoutes(
  config: ForgeServerConfig
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const service = new AgentDefinitionService({ agentStore: config.agentStore });

  // GET /api/agent-definitions — List agent definitions
  app.get("/", async (c) => {
    const active = c.req.query("active");
    const limit = parseIntBounded(c.req.query("limit"), 100, 1, 500);
    const tenantId = tenantOf(c);

    const agents = await service.list({
      active: active !== undefined ? active === "true" : undefined,
      limit,
      tenantId,
    });

    return c.json({ data: agents, count: agents.length });
  });

  // POST /api/agent-definitions — Create agent definition
  app.post("/", async (c) => {
    const parsed = await body(c, AgentCreateSchema);
    if (!parsed.ok) return parsed.response;
    const tenantId = tenantOf(c);

    const saved = await service.create({ ...parsed.value, tenantId });
    return data(c, saved, 201);
  });

  // GET /api/agent-definitions/:id — Get agent definition
  app.get("/:id", async (c) => {
    const agent = await service.get(c.req.param("id"), tenantOf(c));
    if (!agent) return notFound(c, "Agent not found");
    return data(c, agent);
  });

  // PATCH /api/agent-definitions/:id — Update agent definition
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const tenantId = tenantOf(c);
    const parsed = await body(c, AgentUpdateSchema);
    if (!parsed.ok) return parsed.response;

    const updated = await service.update(id, parsed.value, tenantId);
    if (!updated) return notFound(c, "Agent not found");
    return data(c, updated);
  });

  // DELETE /api/agent-definitions/:id — Soft-delete agent definition
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const deleted = await service.delete(id, tenantOf(c));
    if (!deleted) return notFound(c, "Agent not found");
    return data(c, { id, deleted: true });
  });

  return app;
}

/** @deprecated Use `createAgentDefinitionRoutes`. */
export const createAgentRoutes = createAgentDefinitionRoutes;
