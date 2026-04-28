import { describe, expect, it } from 'vitest'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'

import { createForgeApp } from '../../app.js'
import { InMemoryEventGateway } from '../../events/event-gateway.js'
import { buildOptionalRoutePlugins } from '../optional-routes.js'
import type { ForgeServerConfig } from '../types.js'

function baseConfig(overrides: Partial<ForgeServerConfig> = {}): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    ...overrides,
  }
}

describe('composition/optional-routes', () => {
  it('adapts legacy optional config into feature-family route plugins', () => {
    const config = baseConfig({
      memoryHealth: {
        retriever: { health: () => [] },
      },
    })

    const plugins = buildOptionalRoutePlugins({
      runtimeConfig: config,
      effectiveAuth: undefined,
      eventGateway: new InMemoryEventGateway(config.eventBus),
    })

    expect(plugins.map((plugin) => plugin.family)).toEqual([
      'memory',
      'events',
      'mailbox-clusters',
    ])
    expect(plugins.every((plugin) => plugin.prefix === '')).toBe(true)
  })

  it('keeps legacy optional config source-compatible through the plugin adapter', async () => {
    const app = createForgeApp(baseConfig({
      memoryHealth: {
        retriever: {
          health: () => [{
            source: 'test',
            successCount: 1,
            failureCount: 0,
            totalLatencyMs: 10,
            avgLatencyMs: 10,
            successRate: 1,
          }],
        },
      },
    }))

    const response = await app.request('/api/memory/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: {
        status: 'healthy',
        providers: [{ source: 'test' }],
      },
    })
  })
})
