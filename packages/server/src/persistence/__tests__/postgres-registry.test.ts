import { describe, expect, it } from 'vitest'
import type { ForgeCapability } from '@dzupagent/core'
import type { AgentRow } from '../postgres-registry.js'
import { InMemoryRegistryStore, PostgresRegistry } from '../postgres-registry.js'
import type { RegisterAgentInput } from '@dzupagent/core'

function makeCapability(name: string): ForgeCapability {
  return {
    name,
    version: '1.0.0',
    description: `Capability ${name}`,
  }
}

function makeInput(overrides: Partial<RegisterAgentInput> = {}): RegisterAgentInput {
  return {
    name: 'test-agent',
    description: 'Test agent description',
    protocols: ['a2a'],
    capabilities: [makeCapability('code.review')],
    ...overrides,
  }
}

function makeRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'row-1',
    name: 'row-agent',
    description: 'Row agent description',
    endpoint: 'https://example.com',
    protocols: ['a2a'],
    capabilities: [makeCapability('code.review')],
    authentication_type: 'bearer',
    authentication_config: { issuer: 'https://issuer.example.com', scope: 'registry:write' },
    version: '1.0.0',
    sla: { maxLatencyMs: 500 },
    health_status: 'unknown',
    health_data: null,
    metadata: { team: 'platform' },
    registered_at: '2026-04-02T00:00:00.000Z',
    last_updated_at: '2026-04-02T00:00:00.000Z',
    ttl_ms: 60_000,
    identity: {
      id: 'identity-1',
      uri: 'forge://example/row-agent',
      displayName: 'Row Agent',
    },
    uri: 'forge://example/row-agent',
    ...overrides,
  }
}

describe('PostgresRegistry', () => {
  it('preserves authentication type and config through register/get', async () => {
    const store = new InMemoryRegistryStore()
    const registry = new PostgresRegistry({ store })

    const created = await registry.register(makeInput({
      authentication: {
        type: 'bearer',
        config: {
          issuer: 'https://issuer.example.com',
          scope: 'registry:write',
        },
      },
    }))

    const loaded = await registry.getAgent(created.id)

    expect(loaded).toBeDefined()
    expect(loaded?.authentication).toEqual({
      type: 'bearer',
      config: {
        issuer: 'https://issuer.example.com',
        scope: 'registry:write',
      },
    })
  })

  it('updates authentication and identity fields', async () => {
    const store = new InMemoryRegistryStore()
    const registry = new PostgresRegistry({ store })

    const created = await registry.register(makeInput({
      authentication: {
        type: 'bearer',
        config: { scope: 'read' },
      },
    }))

    const updated = await registry.update(created.id, {
      authentication: {
        type: 'api-key',
        config: { keyId: 'key-123', scope: 'write' },
      },
      identity: {
        id: 'identity-2',
        uri: 'forge://example/updated-agent',
        displayName: 'Updated Agent',
      },
    })

    const loaded = await registry.getAgent(created.id)

    expect(updated.authentication).toEqual({
      type: 'api-key',
      config: { keyId: 'key-123', scope: 'write' },
    })
    expect(updated.identity).toEqual({
      id: 'identity-2',
      uri: 'forge://example/updated-agent',
      displayName: 'Updated Agent',
    })
    expect(loaded?.authentication).toEqual(updated.authentication)
    expect(loaded?.identity).toEqual(updated.identity)
  })

  it('ignores unknown authentication types from stored rows safely', async () => {
    const store = new InMemoryRegistryStore()
    await store.insert(makeRow({
      authentication_type: 'unsupported-auth-type',
      authentication_config: { should: 'be ignored' },
    }))

    const registry = new PostgresRegistry({ store })
    const agent = await registry.getAgent('row-1')

    expect(agent).toBeDefined()
    expect(agent?.name).toBe('row-agent')
    expect(agent?.authentication).toBeUndefined()
  })
})
