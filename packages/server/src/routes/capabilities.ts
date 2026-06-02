/**
 * Skill capability matrix routes (UCL FR-6).
 *
 * GET /:skillId — Returns a SkillCapabilityMatrix describing per-provider
 * capability coverage for the given skill bundle. The matrix is built on
 * demand from the configured AdapterSkillRegistry.
 *
 * Uses the shared `{ data }` / NOT_FOUND envelope helpers (CODE-L-02).
 */
import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import type { AdapterSkillRegistry } from "@dzupagent/agent-adapters/skills";
import { SkillCapabilityMatrixBuilder } from "@dzupagent/agent-adapters/skills";
import { data, notFound } from "./crud-helpers.js";

export interface CapabilityRouteConfig {
  skillRegistry: AdapterSkillRegistry;
}

export function createCapabilityRoutes(
  config: CapabilityRouteConfig
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/:skillId", (c) => {
    const skillId = c.req.param("skillId");
    const bundle = config.skillRegistry.getBundle(skillId);
    if (!bundle) return notFound(c, `Skill '${skillId}' not found`);
    const builder = new SkillCapabilityMatrixBuilder(config.skillRegistry);
    const matrix = builder.buildForSkill(bundle);
    return data(c, matrix);
  });

  return app;
}
