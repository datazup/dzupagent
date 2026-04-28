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

function createTestConfig(overrides: Partial<ForgeServerConfig> = {}): ForgeServerConfig {
  return {
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    ...overrides,
  }
}

describe('composition/openai-compat routes', () => {
  it('does not mount /v1 routes by default', async () => {
    const app = createForgeApp(createTestConfig())

    const res = await app.request('/v1/models')

    expect(res.status).toBe(404)
  })

  it('mounts /v1 routes when openai.enabled is true', async () => {
    const agentStore = new InMemoryAgentStore()
    await agentStore.save(ECHO_AGENT)
    const app = createForgeApp(createTestConfig({
      agentStore,
      openai: { enabled: true, auth: { enabled: false } },
    }))

    const res = await app.request('/v1/models')

    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toContain('echo')
  })

  it('keeps enabled OpenAI routes fail-closed when auth is not configured', async () => {
    const app = createForgeApp(createTestConfig({
      openai: { enabled: true },
    }))

    const res = await app.request('/v1/models')

    expect(res.status).toBe(401)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('invalid_api_key')
  })
})
