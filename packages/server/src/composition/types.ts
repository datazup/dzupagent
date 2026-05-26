/**
 * Re-export barrel + aggregate config interfaces for the Hono app factory.
 * Focused concerns live in sibling modules: control-plane-types,
 * runtime-types, and plugin-types.
 */
export * from './control-plane-types.js'
export * from './runtime-types.js'
export * from './plugin-types.js'

import type { ServerRoutePlugin } from './plugin-types.js'
import type {
  ForgeCoreConfig,
  ForgeRuntimeConfig,
  ForgeMemoryRouteFamilyConfig,
  ForgeEvaluationRouteFamilyConfig,
  ForgeAdapterRouteFamilyConfig,
} from './runtime-types.js'
import type {
  ForgeCompatibilityRouteFamilyConfig,
  ForgeSecurityConfig,
  ForgeTransportConfig,
} from './plugin-types.js'
import type {
  ForgeAutomationRouteFamilyConfig,
  ForgeControlPlaneRouteFamilyConfig,
} from './control-plane-types.js'

/** Feature-family aggregate; prefer `routePlugins` or app-level Hono for new product routes. */
export interface ForgeRouteFamiliesConfig
  extends ForgeMemoryRouteFamilyConfig,
    ForgeCompatibilityRouteFamilyConfig,
    ForgeEvaluationRouteFamilyConfig,
    ForgeAdapterRouteFamilyConfig,
    ForgeAutomationRouteFamilyConfig,
    ForgeControlPlaneRouteFamilyConfig {}

/**
 * Integrations and feature toggles that mount additional routes.
 * @deprecated Use `ForgeServerConfig` or `ForgeRouteFamiliesConfig`. Legacy alias; no workspace consumers.
 */
export interface ForgeIntegrationsConfig extends ForgeRouteFamiliesConfig {
  /** Server-owned extension seam; prefer `routePlugins` for new product routes. */
  routePlugins?: ServerRoutePlugin<ForgeServerConfig>[]
}

/**
 * Narrow host-runtime config for new `createForgeApp` hosts.
 * Excludes frozen compatibility route-family fields; use `routePlugins` for app routes.
 */
export interface ForgeHostRuntimeConfig
  extends ForgeCoreConfig,
    ForgeTransportConfig,
    ForgeRuntimeConfig,
    ForgeSecurityConfig {
  routePlugins?: ForgeIntegrationsConfig['routePlugins']
}

/** Aggregate config accepted by `createForgeApp`. Sub-interfaces allow composition helpers to request narrow slices. */
export interface ForgeServerConfig
  extends ForgeCoreConfig,
    ForgeTransportConfig,
    ForgeRuntimeConfig,
    ForgeIntegrationsConfig,
    ForgeSecurityConfig {}
