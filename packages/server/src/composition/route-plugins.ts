/**
 * Built-in route plugins (MCP, skills, workflows, compile) plus the host
 * plugin runner. The legacy `app.ts` mounted these after most other routes
 * so that user-supplied plugins can override built-ins where appropriate.
 */
import type { Hono } from 'hono'
import type { AppEnv } from '../types.js'

import type { ForgeServerConfig } from './types.js'
import type { EventGateway } from '../events/event-gateway.js'
import type { ServerRoutePlugin, ServerRoutePluginContext } from '../route-plugin.js'
import { createMcpRoutes } from '../routes/mcp.js'
import { createSkillRoutes } from '../routes/skills.js'
import { createWorkflowRoutes } from '../routes/workflows.js'
import { createCompileRoutes, type CompileRouteConfig } from '../routes/compile.js'

export function buildBuiltInRoutePlugins(
  config: ForgeServerConfig,
  eventGateway: EventGateway,
): ServerRoutePlugin<ForgeServerConfig>[] {
  const plugins: ServerRoutePlugin<ForgeServerConfig>[] = []
  const effectiveCompileConfig: CompileRouteConfig | undefined =
    config.compile?.personaResolver || !config.personaStore
      ? {
          ...(config.compile ?? {}),
          eventGateway,
        }
      : {
          ...(config.compile ?? {}),
          personaStore: config.personaStore,
          eventGateway,
        }

  if (config.mcpManager) {
    plugins.push({
      prefix: '/api/mcp',
      createRoutes: () => createMcpRoutes({
        mcpManager: config.mcpManager,
        ...(config.mcpAllowedExecutables !== undefined
          ? { mcpAllowedExecutables: config.mcpAllowedExecutables }
          : {}),
        ...(config.mcpAllowedHttpHosts !== undefined
          ? { mcpAllowedHttpHosts: config.mcpAllowedHttpHosts }
          : {}),
      }),
    })
  }

  if (config.skillRegistry) {
    plugins.push({
      prefix: '/api/skills',
      createRoutes: () => createSkillRoutes({ skillRegistry: config.skillRegistry }),
    })
  }

  if (config.coreSkillRegistry || config.skillStepResolver) {
    plugins.push({
      prefix: '/api/workflows',
      createRoutes: () => createWorkflowRoutes({
        skillRegistry: config.coreSkillRegistry,
        workflowRegistry: config.workflowRegistry,
        resolver: config.skillStepResolver,
        eventBus: config.eventBus,
        compile: effectiveCompileConfig,
      }),
    })
  }

  // Flow compiler route is always available — it has no hard dependencies.
  // A no-op tool resolver is used when `config.compile` is omitted; callers
  // can wire a domain catalog via `config.compile.toolResolver`.
  plugins.push({
    prefix: '/api/workflows',
    createRoutes: () => createCompileRoutes(effectiveCompileConfig ?? {}),
  })

  return plugins
}

export function mountRoutePlugins(
  app: Hono<AppEnv>,
  plugins: readonly ServerRoutePlugin<ForgeServerConfig>[],
  serverConfig: ForgeServerConfig,
): void {
  const context: ServerRoutePluginContext<ForgeServerConfig> = { serverConfig }
  for (const plugin of plugins) {
    // Reject syntactically invalid prefixes.
    if (plugin.prefix !== '' && !plugin.prefix.startsWith('/')) {
      console.warn(
        `[ForgeServer] Skipping route plugin with invalid prefix "${plugin.prefix}". Prefix must start with '/'.`,
      )
      continue
    }

    // AUTH BOUNDARY ENFORCEMENT
    // Plugins whose prefix does not start with '/api/' would be mounted
    // outside the authentication middleware scope, allowing requests to reach
    // those routes without a valid session.  Require plugins to explicitly opt
    // out with `auth: 'bypass'` when this is intentional (e.g. health checks).
    const authMode = plugin.auth ?? 'required'
    if (authMode === 'required' && !plugin.prefix.startsWith('/api/') && plugin.prefix !== '') {
      throw new Error(
        `[ForgeServer] Route plugin with prefix "${plugin.prefix}" is outside the /api/ auth boundary. ` +
        `Set auth: 'bypass' on the plugin to explicitly allow unauthenticated access, ` +
        `or change the prefix to start with '/api/'.`,
      )
    }

    const subApp = plugin.createRoutes(context) as Parameters<typeof app.route>[1]
    app.route(plugin.prefix, subApp)
    plugin.onMount?.(serverConfig, context)
  }
}

/**
 * Compose built-in plugins with any host-provided plugins and mount them on
 * `app`. Mirrors the legacy ordering where built-ins run first, followed by
 * `config.routePlugins` in the order they were supplied.
 */
export function mountAllRoutePlugins(
  app: Hono<AppEnv>,
  runtimeConfig: ForgeServerConfig,
  eventGateway: EventGateway,
): void {
  const allRoutePlugins = [
    ...buildBuiltInRoutePlugins(runtimeConfig, eventGateway),
    ...(runtimeConfig.routePlugins ?? []),
  ]
  if (allRoutePlugins.length) {
    mountRoutePlugins(app, allRoutePlugins, runtimeConfig)
  }
}
