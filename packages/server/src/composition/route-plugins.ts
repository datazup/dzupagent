/**
 * Built-in route plugins (MCP, skills, workflows, compile) plus the host
 * plugin runner. The legacy `app.ts` mounted these after most other routes
 * so that user-supplied plugins can override built-ins where appropriate.
 */
import type { Hono } from 'hono'

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
  app: Hono,
  plugins: readonly ServerRoutePlugin<ForgeServerConfig>[],
  serverConfig: ForgeServerConfig,
): void {
  const context: ServerRoutePluginContext<ForgeServerConfig> = { serverConfig }
  for (const plugin of plugins) {
    if (plugin.prefix !== '' && !plugin.prefix.startsWith('/')) {
      console.warn(
        `[ForgeServer] Skipping route plugin with invalid prefix "${plugin.prefix}". Prefix must start with '/'.`,
      )
      continue
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
  app: Hono,
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
