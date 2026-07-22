/**
 * Mounts the optional REST surface that depends on capability config flags.
 * These route families are frozen as framework primitives or compatibility /
 * maintenance surfaces. New product-control-plane concepts such as workspaces,
 * projects, tasks, operator dashboards, or Codev-specific UX belong in the
 * consuming app and should integrate through `routePlugins` or app-owned Hono
 * composition instead of expanding this file.
 *
 * Each per-family mount helper (in `./optional-routes/`) is a pure side-effect
 * on the Hono app — no return values, no shared state with the rest of the
 * composition pipeline beyond `runtimeConfig`, the resolved `effectiveAuth`,
 * and `eventGateway`.
 *
 * Mount paths and ordering are preserved to match the legacy `app.ts`
 * sequence, since some hosts depend on the registration order
 * (Hono routes are first-match per method).
 */
import type { ServerRoutePlugin } from "../route-plugin.js";
import type { Hono } from "hono";
import type { AppEnv } from "../types.js";

import { mountRoutePlugins } from "./route-plugins.js";
import {
  createOptionalRouteFamilyPlugin,
  type OptionalRoutesContext,
} from "./optional-routes/context.js";
import {
  mountMemoryRoutes,
  mountEventRoutes,
  mountDeployRoutes,
  mountLearningRoutes,
  mountReflectionRoutes,
} from "./optional-routes/data-routes.js";
import {
  mountBenchmarkRoutes,
  mountEvalRoutes,
  mountPlaygroundRoute,
} from "./optional-routes/evaluation-routes.js";
import {
  mountTriggerScheduleRoutes,
  mountConfigStoreRoutes,
} from "./optional-routes/config-store-routes.js";
import {
  mountA2ARoutes,
  mountMailboxAndClusterRoutes,
} from "./optional-routes/messaging-routes.js";
import {
  mountOpenAICompatRoutes,
  mountScaleTargetRoute,
  mountPrometheusMetricsRoute,
} from "./optional-routes/compat-routes.js";

export type { OptionalRoutesContext };
export { mountPrometheusMetricsRoute };

export function mountOptionalRoutes(
  app: Hono<AppEnv>,
  ctx: OptionalRoutesContext
): void {
  mountRoutePlugins(app, buildOptionalRoutePlugins(ctx), ctx.runtimeConfig);
}

export function buildOptionalRoutePlugins(
  ctx: OptionalRoutesContext
): ServerRoutePlugin[] {
  const plugins: ServerRoutePlugin[] = [];

  if (ctx.runtimeConfig.memoryService || ctx.runtimeConfig.memoryHealth) {
    plugins.push(
      createOptionalRouteFamilyPlugin("memory", (app) =>
        mountMemoryRoutes(app, ctx)
      )
    );
  }

  plugins.push(
    createOptionalRouteFamilyPlugin("events", (app) =>
      mountEventRoutes(app, ctx)
    )
  );

  if (ctx.runtimeConfig.deploy) {
    plugins.push(
      createOptionalRouteFamilyPlugin("deploy", (app) =>
        mountDeployRoutes(app, ctx)
      )
    );
  }
  if (ctx.runtimeConfig.learning) {
    plugins.push(
      createOptionalRouteFamilyPlugin("learning", (app) =>
        mountLearningRoutes(app, ctx)
      )
    );
  }
  if (ctx.runtimeConfig.benchmark) {
    plugins.push(
      createOptionalRouteFamilyPlugin("benchmarks", (app) =>
        mountBenchmarkRoutes(app, ctx)
      )
    );
  }
  if (ctx.runtimeConfig.evals) {
    plugins.push(
      createOptionalRouteFamilyPlugin("evals", (app) =>
        mountEvalRoutes(app, ctx)
      )
    );
  }
  if (ctx.runtimeConfig.playground) {
    plugins.push(
      createOptionalRouteFamilyPlugin("playground", (app) =>
        mountPlaygroundRoute(app, ctx)
      )
    );
  }
  if (ctx.runtimeConfig.a2a) {
    plugins.push(
      createOptionalRouteFamilyPlugin("a2a", (app) => mountA2ARoutes(app, ctx))
    );
  }
  if (ctx.runtimeConfig.triggerStore || ctx.runtimeConfig.scheduleStore) {
    plugins.push(
      createOptionalRouteFamilyPlugin("automation", (app) =>
        mountTriggerScheduleRoutes(app, ctx)
      )
    );
  }
  if (
    ctx.runtimeConfig.promptStore ||
    ctx.runtimeConfig.personaStore ||
    ctx.runtimeConfig.presetRegistry ||
    ctx.runtimeConfig.catalogStore
  ) {
    plugins.push(
      createOptionalRouteFamilyPlugin("config-stores", (app) =>
        mountConfigStoreRoutes(app, ctx)
      )
    );
  }
  if (ctx.runtimeConfig.reflectionStore) {
    plugins.push(
      createOptionalRouteFamilyPlugin("reflections", (app) =>
        mountReflectionRoutes(app, ctx)
      )
    );
  }

  plugins.push(
    createOptionalRouteFamilyPlugin("mailbox-clusters", (app) =>
      mountMailboxAndClusterRoutes(app, ctx)
    )
  );

  if (ctx.runtimeConfig.openai?.enabled === true) {
    plugins.push(
      createOptionalRouteFamilyPlugin("openai-compat", (app) =>
        mountOpenAICompatRoutes(app, ctx)
      )
    );
  }

  if (ctx.runtimeConfig.runQueue) {
    plugins.push(
      createOptionalRouteFamilyPlugin("scale-target", (app) =>
        mountScaleTargetRoute(app, ctx)
      )
    );
  }

  return plugins;
}
