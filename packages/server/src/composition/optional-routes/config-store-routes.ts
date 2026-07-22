/**
 * Config-store optional route families: triggers/schedules automation and the
 * prompt/persona/preset/marketplace config stores. Each helper is a pure
 * side-effect on the passed Hono app, gated per-store by `runtimeConfig`.
 */
import type { Hono } from "hono";
import type { AppEnv } from "../../types.js";
import type { OptionalRoutesContext } from "./context.js";

import { createTriggerRoutes } from "../../routes/triggers.js";
import { createScheduleRoutes } from "../../routes/schedules.js";
import { createPromptRoutes } from "../../routes/prompts.js";
import { createPersonaRoutes } from "../../routes/personas.js";
import { createPresetRoutes } from "../../routes/presets.js";
import { createMarketplaceRoutes } from "../../routes/marketplace.js";

export function mountTriggerScheduleRoutes(
  app: Hono<AppEnv>,
  { runtimeConfig }: OptionalRoutesContext
): void {
  if (runtimeConfig.triggerStore) {
    app.route(
      "/api/triggers",
      createTriggerRoutes({ triggerStore: runtimeConfig.triggerStore })
    );
  }
  if (runtimeConfig.scheduleStore) {
    app.route(
      "/api/schedules",
      createScheduleRoutes({
        scheduleStore: runtimeConfig.scheduleStore,
        onManualTrigger: runtimeConfig.onScheduleTrigger,
      })
    );
  }
}

export function mountConfigStoreRoutes(
  app: Hono<AppEnv>,
  { runtimeConfig }: OptionalRoutesContext
): void {
  if (runtimeConfig.promptStore) {
    app.route(
      "/api/prompts",
      createPromptRoutes({ promptStore: runtimeConfig.promptStore })
    );
  }
  if (runtimeConfig.personaStore) {
    app.route(
      "/api/personas",
      createPersonaRoutes({ personaStore: runtimeConfig.personaStore })
    );
  }
  if (runtimeConfig.presetRegistry) {
    app.route(
      "/api/presets",
      createPresetRoutes({ presetRegistry: runtimeConfig.presetRegistry })
    );
  }
  if (runtimeConfig.catalogStore) {
    app.route(
      "/api/marketplace",
      createMarketplaceRoutes({ catalogStore: runtimeConfig.catalogStore })
    );
  }
}
