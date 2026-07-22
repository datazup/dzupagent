/**
 * Data-plane optional route families: memory, events, deploy, learning, and
 * reflections. Each helper is a pure side-effect on the passed Hono app and is
 * gated by the corresponding `runtimeConfig` capability flag.
 */
import type { Hono } from "hono";
import type { AppEnv } from "../../types.js";
import type { OptionalRoutesContext } from "./context.js";

import { createMemoryRoutes } from "../../routes/memory.js";
import { createMemoryBrowseRoutes } from "../../routes/memory-browse.js";
import { createMemoryHealthRoutes } from "../../routes/memory-health.js";
import { createEventRoutes } from "../../routes/events.js";
import { createDeployRoutes } from "../../routes/deploy.js";
import { createLearningRoutes } from "../../routes/learning.js";
import { createReflectionRoutes } from "../../routes/reflections.js";

export function mountMemoryRoutes(
  app: Hono<AppEnv>,
  { runtimeConfig }: OptionalRoutesContext
): void {
  if (runtimeConfig.memoryService) {
    app.route(
      "/api/memory",
      createMemoryRoutes({ memoryService: runtimeConfig.memoryService })
    );
    app.route(
      "/api/memory-browse",
      createMemoryBrowseRoutes({ memoryService: runtimeConfig.memoryService })
    );
  }
  if (runtimeConfig.memoryHealth) {
    app.route(
      "/api/memory",
      createMemoryHealthRoutes(runtimeConfig.memoryHealth)
    );
  }
}

export function mountEventRoutes(
  app: Hono<AppEnv>,
  { eventGateway }: OptionalRoutesContext
): void {
  app.route("/api/events", createEventRoutes({ eventGateway }));
}

export function mountDeployRoutes(
  app: Hono<AppEnv>,
  { runtimeConfig }: OptionalRoutesContext
): void {
  if (runtimeConfig.deploy) {
    app.route("/api/deploy", createDeployRoutes(runtimeConfig.deploy));
  }
}

export function mountLearningRoutes(
  app: Hono<AppEnv>,
  { runtimeConfig }: OptionalRoutesContext
): void {
  if (runtimeConfig.learning) {
    app.route("/api/learning", createLearningRoutes(runtimeConfig.learning));
  }
}

export function mountReflectionRoutes(
  app: Hono<AppEnv>,
  { runtimeConfig }: OptionalRoutesContext
): void {
  if (runtimeConfig.reflectionStore) {
    app.route(
      "/api/reflections",
      createReflectionRoutes({
        reflectionStore: runtimeConfig.reflectionStore,
        // SEC-M-03 sibling sweep: pass the runStore so the list/pattern
        // endpoints can scope reflections to the requesting tenant/owner.
        runStore: runtimeConfig.runStore,
      })
    );
  }
}
