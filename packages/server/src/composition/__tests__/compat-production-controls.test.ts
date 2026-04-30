import { describe, expect, it } from 'vitest'
import {
  InMemoryAgentStore,
  InMemoryRunStore,
  ModelRegistry,
  createEventBus,
} from '@dzupagent/core'
import type { AgentExecutionSpec } from '@dzupagent/core'

import { createForgeApp, type ForgeServerConfig } from '../../app.js'

const ECHO_AGENT: AgentExecutionSpec = {
  id: 'echo',
  name: 'Echo Agent',
  description: 'Echoes back input',
  instructions: 'Echo whatever the user says.',
  modelTier: 'chat',
  active: true,
}

function baseConfig(overrides: Partial<ForgeServerConfig> = {}): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    auth: {
      mode: 'api-key',
      validateKey: async (key) => key === 'admin'
        ? { id: 'admin-key', role: 'admin', rateLimitTier: 'standard' }
        : key === 'viewer'
          ? { id: 'viewer-key', role: 'viewer', rateLimitTier: 'standard' }
          : null,
    },
    rateLimit: { maxRequests: 1, windowMs: 60_000 },
    ...overrides,
  }
}

function a2aConfig(): NonNullable<ForgeServerConfig['a2a']> {
  return {
    agentCardConfig: {
      name: 'test-server',
      description: 'Test A2A server',
      baseUrl: 'http://localhost:4000',
      version: '1.0.0',
      agents: [{ name: 'test-agent', description: 'A test agent' }],
    },
  }
}

async function openAiAgentStore(): Promise<InMemoryAgentStore> {
  const agentStore = new InMemoryAgentStore()
  await agentStore.save(ECHO_AGENT)
  return agentStore
}

describe('compat route production controls', () => {
  it('rate limits /api/*, /a2a/*, and /v1/* when those route families are configured', async () => {
    const agentStore = await openAiAgentStore()
    const app = createForgeApp(baseConfig({
      agentStore,
      a2a: a2aConfig(),
      openai: {
        enabled: true,
        auth: {
          validateKey: async (key) => key === 'admin'
            ? { id: 'openai-admin-key', role: 'admin', rateLimitTier: 'standard' }
            : null,
        },
      },
    }))

    const apiFirst = await app.request('/api/agents', {
      headers: { Authorization: 'Bearer admin' },
    })
    const apiSecond = await app.request('/api/agents', {
      headers: { Authorization: 'Bearer admin' },
    })

    const a2aFirst = await app.request('/a2a/tasks', {
      headers: { Authorization: 'Bearer admin' },
    })
    const a2aSecond = await app.request('/a2a/tasks', {
      headers: { Authorization: 'Bearer admin' },
    })

    const v1First = await app.request('/v1/models', {
      headers: { Authorization: 'Bearer admin' },
    })
    const v1Second = await app.request('/v1/models', {
      headers: { Authorization: 'Bearer admin' },
    })

    expect(apiFirst.status).toBe(200)
    expect(apiSecond.status).toBe(429)
    expect(a2aFirst.status).toBe(200)
    expect(a2aSecond.status).toBe(429)
    expect(v1First.status).toBe(200)
    expect(v1Second.status).toBe(429)
  })

  it('applies RBAC to A2A task mutations after framework auth', async () => {
    const app = createForgeApp(baseConfig({
      a2a: a2aConfig(),
      rateLimit: { maxRequests: 100, windowMs: 60_000 },
    }))

    const res = await app.request('/a2a/tasks', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer viewer',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agentName: 'test-agent', input: { prompt: 'hello' } }),
    })

    expect(res.status).toBe(403)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('create:a2a')
  })

  it('applies RBAC to OpenAI-compatible execution when OpenAI auth provides key metadata', async () => {
    const agentStore = await openAiAgentStore()
    const app = createForgeApp(baseConfig({
      agentStore,
      rateLimit: { maxRequests: 100, windowMs: 60_000 },
      openai: {
        enabled: true,
        auth: {
          validateKey: async (key) => key === 'viewer'
            ? { id: 'openai-viewer-key', role: 'viewer' }
            : null,
        },
      },
    }))

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer viewer',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'echo',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(res.status).toBe(403)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('execute:openai')
  })
})
