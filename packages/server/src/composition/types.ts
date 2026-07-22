/**
 * Type definitions for the Hono app factory. Split out of `app.ts` so the
 * composition root can stay focused on orchestration. The aggregate
 * {@link ForgeServerConfig} interface is re-exported (along with its
 * dependent option types) from `app.ts` to preserve the public surface.
 *
 * Internally, the configuration is decomposed into focused per-concern modules
 * (transport, persistence, runtime, integrations, security, etc.) so that
 * helper modules under `composition/` can ask for narrow slices when the full
 * config is unnecessary. This module is a thin barrel that re-exports the exact
 * public type surface from those per-concern modules and defines only the two
 * aggregate interfaces that compose them.
 */
export type { ForgeCoreConfig } from "./config-core.js";
export type {
  ForgeTransportConfig,
  SecurityHeadersConfig,
  JsonBodyLimitConfig,
} from "./config-transport.js";
export type {
  ConsolidationConfig,
  ForgeRuntimeConfig,
} from "./config-runtime.js";
export type { ForgeSecurityConfig } from "./config-security.js";
export type {
  MailDeliveryConfig,
  PromptFeedbackLoopLike,
  LearningEventProcessorLike,
} from "./config-control-plane.js";
export type {
  ForgeMemoryRouteFamilyConfig,
  ForgeCompatibilityRouteFamilyConfig,
  ForgeEvaluationRouteFamilyConfig,
  ForgeAdapterRouteFamilyConfig,
  ForgeAutomationRouteFamilyConfig,
  ForgeControlPlaneRouteFamilyConfig,
  ForgeRouteFamiliesConfig,
  ForgeIntegrationsConfig,
} from "./config-route-families.js";

import type { ForgeCoreConfig } from "./config-core.js";
import type { ForgeTransportConfig } from "./config-transport.js";
import type { ForgeRuntimeConfig } from "./config-runtime.js";
import type { ForgeSecurityConfig } from "./config-security.js";
import type { ForgeIntegrationsConfig } from "./config-route-families.js";

/**
 * Narrow host-runtime config for new `createForgeApp` hosts.
 *
 * Use this type when a host only needs the framework runtime, transport,
 * security, and route-plugin seam. It intentionally excludes the frozen
 * compatibility route-family fields exposed by {@link ForgeServerConfig};
 * app/product routes should keep their own app-owned config and mount through
 * `routePlugins` or app-level Hono composition.
 */
export interface ForgeHostRuntimeConfig
  extends ForgeCoreConfig,
    ForgeTransportConfig,
    ForgeRuntimeConfig,
    ForgeSecurityConfig {
  /**
   * Host-supplied route plugins for app-owned or integration-owned routes.
   * New product-specific route families should use this seam instead of
   * adding fields to `ForgeServerConfig`.
   */
  routePlugins?: ForgeIntegrationsConfig["routePlugins"];
}

/**
 * Aggregate config object accepted by `createForgeApp`. Decomposed into focused
 * sub-interfaces so individual composition helpers can ask for narrow slices.
 */
export interface ForgeServerConfig
  extends ForgeCoreConfig,
    ForgeTransportConfig,
    ForgeRuntimeConfig,
    ForgeIntegrationsConfig,
    ForgeSecurityConfig {}
