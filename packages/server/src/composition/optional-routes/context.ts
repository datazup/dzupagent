/**
 * Shared context + plugin-factory helper for the optional REST surface.
 *
 * These are the only pieces of shared state that the per-family mount helpers
 * (under `./optional-routes/`) depend on: `runtimeConfig`, the resolved
 * `effectiveAuth`, and `eventGateway`. Each family mount helper is a pure
 * side-effect on the Hono app — no return values.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../types.js";

import type { ForgeServerConfig } from "../types.js";
import type { EventGateway } from "../../events/event-gateway.js";
import type { AuthConfig } from "../../middleware/auth.js";
import type { ServerRoutePlugin } from "../../route-plugin.js";

export interface OptionalRoutesContext {
  runtimeConfig: ForgeServerConfig;
  effectiveAuth: AuthConfig | undefined;
  eventGateway: EventGateway;
}

export function createOptionalRouteFamilyPlugin(
  name: string,
  mount: (app: Hono<AppEnv>) => void
): ServerRoutePlugin {
  return {
    family: name,
    prefix: "",
    createRoutes: () => {
      const familyApp = new Hono<AppEnv>();
      mount(familyApp);
      return familyApp;
    },
  };
}
