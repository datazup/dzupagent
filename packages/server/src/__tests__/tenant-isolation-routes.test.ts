import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import { InMemoryMailboxStore } from '@dzupagent/agent'
import { createAgentDefinitionRoutes } from '../routes/agents.js'
import { createClusterRoutes } from '../routes/clusters.js'
import { createMarketplaceRoutes } from '../routes/marketplace.js'
import { createPersonaRoutes } from '../routes/personas.js'
import { createPromptRoutes } from '../routes/prompts.js'
import { createScheduleRoutes } from '../routes/schedules.js'
import { createTriggerRoutes } from '../routes/triggers.js'
import { InMemoryCatalogStore } from '../marketplace/catalog-store.js'
import { InMemoryClusterStore } from '../persistence/drizzle-cluster-store.js'
import { InMemoryPersonaStore } from '../personas/persona-store.js'
import { InMemoryPromptStore } from '../prompts/prompt-store.js'
import { InMemoryScheduleStore } from '../schedules/schedule-store.js'
import { InMemoryTriggerStore } from '../triggers/trigger-store.js'
import type { ForgeServerConfig } from '../app.js'
import type { AppEnv } from '../types.js'

const tenantA = 'tenant-a'
const tenantB = 'tenant-b'

function installTenantHeader(app: Hono<AppEnv>): void {
  app.use('*', async (c, next) => {
    const tenantId = c.req.header('x-test-tenant')
    if (tenantId) {
      c.set('apiKey', { id: `key-${tenantId}`, tenantId })
    }
    await next()
  })
}

function jsonRequest(method: string, tenantId: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-test-tenant': tenantId,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }
}

describe('tenant isolation on CRUD route families', () => {
  it('scopes agent definitions by authenticated tenant', async () => {
    const config = {
      runStore: new InMemoryRunStore(),
      agentStore: new InMemoryAgentStore(),
      eventBus: createEventBus(),
      modelRegistry: new ModelRegistry(),
    } satisfies ForgeServerConfig
    const app = new Hono<AppEnv>()
    installTenantHeader(app)
    app.route('/api/agent-definitions', createAgentDefinitionRoutes(config))

    const create = await app.request('/api/agent-definitions', jsonRequest('POST', tenantA, {
      id: 'agent-a',
      name: 'Agent A',
      instructions: 'Work for tenant A',
      modelTier: 'chat',
    }))
    expect(create.status).toBe(201)

    const listA = await app.request('/api/agent-definitions', jsonRequest('GET', tenantA))
    expect(((await listA.json()) as { data: unknown[] }).data).toHaveLength(1)

    const listB = await app.request('/api/agent-definitions', jsonRequest('GET', tenantB))
    expect(((await listB.json()) as { data: unknown[] }).data).toHaveLength(0)

    const getB = await app.request('/api/agent-definitions/agent-a', jsonRequest('GET', tenantB))
    expect(getB.status).toBe(404)
  })

  it('scopes trigger configs by authenticated tenant', async () => {
    const app = new Hono<AppEnv>()
    installTenantHeader(app)
    app.route('/api/triggers', createTriggerRoutes({ triggerStore: new InMemoryTriggerStore() }))

    await app.request('/api/triggers', jsonRequest('POST', tenantA, {
      id: 'trigger-a',
      type: 'cron',
      agentId: 'agent-a',
    }))

    const listB = await app.request('/api/triggers', jsonRequest('GET', tenantB))
    expect(((await listB.json()) as { triggers: unknown[] }).triggers).toHaveLength(0)

    const getB = await app.request('/api/triggers/trigger-a', jsonRequest('GET', tenantB))
    expect(getB.status).toBe(404)
  })

  it('scopes schedule configs by authenticated tenant', async () => {
    const app = new Hono<AppEnv>()
    installTenantHeader(app)
    app.route('/api/schedules', createScheduleRoutes({ scheduleStore: new InMemoryScheduleStore() }))

    await app.request('/api/schedules', jsonRequest('POST', tenantA, {
      id: 'schedule-a',
      name: 'Tenant A schedule',
      cronExpression: '* * * * *',
      workflowText: 'run',
    }))

    const listB = await app.request('/api/schedules', jsonRequest('GET', tenantB))
    expect(((await listB.json()) as { schedules: unknown[] }).schedules).toHaveLength(0)

    const getB = await app.request('/api/schedules/schedule-a', jsonRequest('GET', tenantB))
    expect(getB.status).toBe(404)
  })

  it('scopes personas and prompts by authenticated tenant', async () => {
    const personas = new Hono<AppEnv>()
    installTenantHeader(personas)
    personas.route('/api/personas', createPersonaRoutes({ personaStore: new InMemoryPersonaStore() }))

    await personas.request('/api/personas', jsonRequest('POST', tenantA, {
      id: 'persona-a',
      name: 'Tenant A persona',
      instructions: 'A only',
    }))

    const personasB = await personas.request('/api/personas', jsonRequest('GET', tenantB))
    expect(((await personasB.json()) as { personas: unknown[] }).personas).toHaveLength(0)

    const prompts = new Hono<AppEnv>()
    installTenantHeader(prompts)
    prompts.route('/api/prompts', createPromptRoutes({ promptStore: new InMemoryPromptStore() }))

    await prompts.request('/api/prompts', jsonRequest('POST', tenantA, {
      id: 'prompt-a',
      promptId: 'shared-prompt',
      name: 'Tenant A prompt',
      type: 'system',
      content: 'A only',
    }))

    const promptsB = await prompts.request('/api/prompts', jsonRequest('GET', tenantB))
    expect(((await promptsB.json()) as { prompts: unknown[] }).prompts).toHaveLength(0)

    const getPromptB = await prompts.request('/api/prompts/prompt-a', jsonRequest('GET', tenantB))
    expect(getPromptB.status).toBe(404)
  })

  it('scopes marketplace catalog and clusters by authenticated tenant', async () => {
    const catalogStore = new InMemoryCatalogStore()
    await catalogStore.create({
      id: 'catalog-a',
      slug: 'tenant-a-agent',
      name: 'Tenant A Agent',
      description: null,
      version: '1.0.0',
      tags: [],
      author: null,
      readme: null,
      publishedAt: null,
      isPublic: true,
      tenantId: tenantA,
    })

    const marketplace = new Hono<AppEnv>()
    installTenantHeader(marketplace)
    marketplace.route('/api/marketplace', createMarketplaceRoutes({ catalogStore }))

    const moveAttempt = await marketplace.request('/api/marketplace/catalog/catalog-a', jsonRequest('PATCH', tenantA, {
      name: 'Still Tenant A Agent',
      tenantId: tenantB,
    }))
    expect(moveAttempt.status).toBe(400)

    const catalogB = await marketplace.request('/api/marketplace/catalog', jsonRequest('GET', tenantB))
    expect(((await catalogB.json()) as { data: unknown[] }).data).toHaveLength(0)

    const catalogA = await marketplace.request('/api/marketplace/catalog', jsonRequest('GET', tenantA))
    expect(((await catalogA.json()) as { data: unknown[] }).data).toHaveLength(1)

    const clusters = new Hono<AppEnv>()
    installTenantHeader(clusters)
    clusters.route('/api/clusters', createClusterRoutes({
      clusterStore: new InMemoryClusterStore(),
      mailboxStore: new InMemoryMailboxStore(),
    }))

    await clusters.request('/api/clusters', jsonRequest('POST', tenantA, { clusterId: 'cluster-a' }))

    const getClusterB = await clusters.request('/api/clusters/cluster-a', jsonRequest('GET', tenantB))
    expect(getClusterB.status).toBe(404)
  })
})
