/**
 * A server route plugin that mounts domain-specific routes
 * without requiring the server to have compile-time knowledge of domain types.
 *
 * `createRoutes()` returns a {@link ServerRouteMountable} (a Hono sub-app),
 * typed as `unknown` to avoid coupling consumers to a specific Hono
 * version/installation. The server casts it internally when calling
 * `app.route()`.
 *
 * RF-8 (ARCH-M-05): the plugin context is a NARROW seam. Plugins receive only
 * the small set of host capabilities they legitimately need — the event bus,
 * auth config, metrics collector, and a declared-services capability map — and
 * NOT the full mutable server config. This prevents plugins from reaching into
 * arbitrary host internals ("kitchen-sink" access) and keeps the host free to
 * evolve `ForgeServerConfig` without breaking plugins.
 */
import type { DzupEventBus } from "@dzupagent/core/events";
import type { MetricsCollector } from "@dzupagent/core/utils";

import type { AuthConfig } from "./middleware/auth.js";

/**
 * The value a route plugin's `createRoutes()` returns: a mountable router.
 *
 * Kept as `unknown` at the type level so the package does not pin a specific
 * Hono version; the host narrows it to `Parameters<typeof app.route>[1]` at the
 * single mount site. This alias documents intent and gives the seam a named
 * return contract.
 */
export type ServerRouteMountable = unknown;

/**
 * Capability map describing which optional host services are wired, exposed to
 * plugins so they can branch on availability WITHOUT holding a reference to the
 * full server config. Add new flags here as new optional host capabilities are
 * surfaced to plugins.
 */
export interface ServerDeclaredServices {
  /** True when an auth config is wired on the host. */
  readonly auth: boolean;
  /** True when a metrics collector is wired on the host. */
  readonly metrics: boolean;
}

/**
 * Narrow host capabilities handed to a route plugin at mount time.
 *
 * Deliberately does NOT expose the full `ForgeServerConfig`: only the bus,
 * auth, metrics, and declared-services map. Plugins that need a domain service
 * should receive it via their own factory closure (as the built-in plugins do),
 * not by reaching through this context.
 */
export interface ServerRoutePluginContext {
  /** The host event bus for decoupled cross-component communication. */
  readonly eventBus: DzupEventBus;
  /** The resolved auth config, if the host wired one. */
  readonly auth?: AuthConfig;
  /** The metrics collector, if the host wired one. */
  readonly metrics?: MetricsCollector;
  /** Capability map of which optional host services are available. */
  readonly declaredServices: ServerDeclaredServices;
}

export interface ServerRoutePlugin {
  /** Optional stable family label for diagnostics and composition tests. */
  readonly family?: string;
  /** URL prefix (e.g., '/api/workflows'); use '' only for root-level framework compatibility routes. */
  readonly prefix: string;
  /**
   * Factory that creates the Hono sub-app/router. Receives ONLY the narrow
   * {@link ServerRoutePluginContext} — never the full server config. Returns
   * unknown to avoid Hono version coupling.
   */
  createRoutes(context: ServerRoutePluginContext): ServerRouteMountable;
  /**
   * Optional: called after routes are mounted, for integration hooks that wire
   * the plugin into host lifecycle (e.g. event-bus + model-registry plugin
   * registration, shutdown cleanup).
   *
   * `onMount` is the deliberate, narrowly-scoped escape hatch: its first
   * argument is the mounted host config (`MountedServerConfig`, opaque here to
   * keep `@dzupagent/server`'s public surface free of `ForgeServerConfig`'s
   * internals), and its second argument is the same narrow context as
   * `createRoutes`. Prefer the narrow context; reach into `mountedConfig` only
   * for lifecycle wiring that genuinely needs broader host services.
   */
  onMount?(
    mountedConfig: MountedServerConfig,
    context: ServerRoutePluginContext
  ): void;
}

/**
 * Opaque handle to the mounted host config passed to `onMount`. Typed as the
 * structural `object` top type rather than `ForgeServerConfig` so the public
 * route-plugin surface does NOT re-export the full server config shape (RF-8 /
 * ARCH-M-05). Integration hooks narrow it to the concrete fields they need.
 */
export type MountedServerConfig = object;
