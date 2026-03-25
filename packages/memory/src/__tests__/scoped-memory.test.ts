import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ScopedMemoryService,
  createAgentMemories,
  PolicyTemplates,
} from '../scoped-memory.js'
import type { MemoryAccessPolicy } from '../scoped-memory.js'
import type { MemoryService } from '../memory-service.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PutCall {
  ns: string
  scope: Record<string, string>
  key: string
  value: Record<string, unknown>
}

function createMockMemoryService(): {
  service: MemoryService
  putCalls: PutCall[]
} {
  const putCalls: PutCall[] = []

  const service = {
    put: vi.fn().mockImplementation(
      (ns: string, scope: Record<string, string>, key: string, value: Record<string, unknown>) => {
        putCalls.push({ ns, scope, key, value })
        return Promise.resolve()
      },
    ),
    get: vi.fn().mockResolvedValue([{ text: 'hello' }]),
    search: vi.fn().mockResolvedValue([{ text: 'found' }]),
    formatForPrompt: vi.fn().mockReturnValue('formatted'),
  } as unknown as MemoryService

  return { service, putCalls }
}

const SCOPE = { tenantId: 't1', projectId: 'p1' }

// ---------------------------------------------------------------------------
// ScopedMemoryService
// ---------------------------------------------------------------------------

describe('ScopedMemoryService', () => {
  let mock: ReturnType<typeof createMockMemoryService>

  beforeEach(() => {
    mock = createMockMemoryService()
  })

  describe('canAccess', () => {
    it('returns true for allowed read access', () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'agent-a',
        namespaces: { lessons: 'read' },
      })
      expect(scoped.canAccess('lessons', 'read')).toBe(true)
    })

    it('returns false for write when only read access', () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'agent-a',
        namespaces: { lessons: 'read' },
      })
      expect(scoped.canAccess('lessons', 'write')).toBe(false)
    })

    it('returns true for both read and write with read-write access', () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'agent-a',
        namespaces: { lessons: 'read-write' },
      })
      expect(scoped.canAccess('lessons', 'read')).toBe(true)
      expect(scoped.canAccess('lessons', 'write')).toBe(true)
    })

    it('uses defaultAccess for unlisted namespaces', () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'agent-a',
        namespaces: {},
        defaultAccess: 'read',
      })
      expect(scoped.canAccess('anything', 'read')).toBe(true)
      expect(scoped.canAccess('anything', 'write')).toBe(false)
    })

    it('defaults to none when no defaultAccess set', () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'agent-a',
        namespaces: {},
      })
      expect(scoped.canAccess('lessons', 'read')).toBe(false)
      expect(scoped.canAccess('lessons', 'write')).toBe(false)
    })

    it('write-only access allows write but not read', () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'agent-a',
        namespaces: { logs: 'write' },
      })
      expect(scoped.canAccess('logs', 'write')).toBe(true)
      expect(scoped.canAccess('logs', 'read')).toBe(false)
    })
  })

  describe('agentId', () => {
    it('exposes the agent ID from the policy', () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'planner',
        namespaces: {},
      })
      expect(scoped.agentId).toBe('planner')
    })
  })

  describe('put', () => {
    it('delegates to inner service when write access is granted', async () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'writer',
        namespaces: { decisions: 'read-write' },
      })

      await scoped.put('decisions', SCOPE, 'key1', { text: 'value' })

      expect(mock.putCalls).toHaveLength(1)
      expect(mock.putCalls[0].ns).toBe('decisions')
      expect(mock.putCalls[0].value).toMatchObject({ text: 'value', _agent: 'writer' })
    })

    it('enriches value with writeTags', async () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'writer',
        namespaces: { decisions: 'write' },
        writeTags: { role: 'planner', team: 'alpha' },
      })

      await scoped.put('decisions', SCOPE, 'key1', { text: 'hello' })

      expect(mock.putCalls).toHaveLength(1)
      const written = mock.putCalls[0].value
      expect(written['_agent']).toBe('writer')
      expect(written['_tag_role']).toBe('planner')
      expect(written['_tag_team']).toBe('alpha')
      expect(written['text']).toBe('hello')
    })

    it('silently skips write when access is denied (non-strict)', async () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'reader',
        namespaces: { decisions: 'read' },
      })

      await scoped.put('decisions', SCOPE, 'key1', { text: 'nope' })

      expect(mock.putCalls).toHaveLength(0)
      expect(scoped.getViolations()).toHaveLength(1)
      expect(scoped.getViolations()[0]).toMatchObject({
        agentId: 'reader',
        namespace: 'decisions',
        operation: 'write',
        requiredAccess: 'write',
        actualAccess: 'read',
      })
    })

    it('throws on write violation in strict mode', async () => {
      const scoped = new ScopedMemoryService(
        mock.service,
        { agentId: 'reader', namespaces: { decisions: 'read' } },
        { strict: true },
      )

      await expect(
        scoped.put('decisions', SCOPE, 'key1', { text: 'nope' }),
      ).rejects.toThrow(/access violation/)

      expect(mock.putCalls).toHaveLength(0)
    })
  })

  describe('get', () => {
    it('delegates to inner service when read access is granted', async () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'reader',
        namespaces: { lessons: 'read' },
      })

      const result = await scoped.get('lessons', SCOPE)
      expect(result).toEqual([{ text: 'hello' }])
      expect(mock.service.get).toHaveBeenCalledWith('lessons', SCOPE, undefined)
    })

    it('returns empty array when read access is denied', async () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'blocked',
        namespaces: { lessons: 'none' },
      })

      const result = await scoped.get('lessons', SCOPE)
      expect(result).toEqual([])
      expect(mock.service.get).not.toHaveBeenCalled()
    })

    it('passes key through to inner service', async () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'reader',
        namespaces: { lessons: 'read-write' },
      })

      await scoped.get('lessons', SCOPE, 'specific-key')
      expect(mock.service.get).toHaveBeenCalledWith('lessons', SCOPE, 'specific-key')
    })
  })

  describe('search', () => {
    it('delegates to inner service when read access is granted', async () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'searcher',
        namespaces: { lessons: 'read' },
      })

      const result = await scoped.search('lessons', SCOPE, 'query', 3)
      expect(result).toEqual([{ text: 'found' }])
      expect(mock.service.search).toHaveBeenCalledWith('lessons', SCOPE, 'query', 3)
    })

    it('returns empty array when read access is denied', async () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'blocked',
        namespaces: { lessons: 'write' },
      })

      const result = await scoped.search('lessons', SCOPE, 'query')
      expect(result).toEqual([])
      expect(mock.service.search).not.toHaveBeenCalled()
    })
  })

  describe('formatForPrompt', () => {
    it('delegates to inner service without access check', () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'agent',
        namespaces: {},
      })

      const result = scoped.formatForPrompt([{ text: 'hi' }], { header: '## Test' })
      expect(result).toBe('formatted')
      expect(mock.service.formatForPrompt).toHaveBeenCalledWith(
        [{ text: 'hi' }],
        { header: '## Test' },
      )
    })
  })

  describe('violations', () => {
    it('accumulates violations across operations', async () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'limited',
        namespaces: {},
        defaultAccess: 'none',
      })

      await scoped.put('ns1', SCOPE, 'k', { text: 'a' })
      await scoped.get('ns2', SCOPE)
      await scoped.search('ns3', SCOPE, 'q')

      expect(scoped.getViolations()).toHaveLength(3)
      expect(scoped.getViolations()[0].namespace).toBe('ns1')
      expect(scoped.getViolations()[1].namespace).toBe('ns2')
      expect(scoped.getViolations()[2].namespace).toBe('ns3')
    })

    it('clearViolations resets the list', async () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'limited',
        namespaces: {},
      })

      await scoped.get('ns', SCOPE)
      expect(scoped.getViolations()).toHaveLength(1)

      scoped.clearViolations()
      expect(scoped.getViolations()).toHaveLength(0)
    })

    it('getViolations returns a copy', async () => {
      const scoped = new ScopedMemoryService(mock.service, {
        agentId: 'a',
        namespaces: {},
      })

      await scoped.get('ns', SCOPE)
      const v1 = scoped.getViolations()
      await scoped.get('ns', SCOPE)
      const v2 = scoped.getViolations()

      // v1 should not have been mutated
      expect(v1).toHaveLength(1)
      expect(v2).toHaveLength(2)
    })
  })
})

// ---------------------------------------------------------------------------
// createAgentMemories
// ---------------------------------------------------------------------------

describe('createAgentMemories', () => {
  it('creates a map of scoped services keyed by agentId', () => {
    const { service } = createMockMemoryService()
    const policies: MemoryAccessPolicy[] = [
      { agentId: 'planner', namespaces: { plans: 'read-write' } },
      { agentId: 'executor', namespaces: { plans: 'read' } },
    ]

    const agents = createAgentMemories(service, policies)

    expect(agents.size).toBe(2)
    expect(agents.get('planner')).toBeInstanceOf(ScopedMemoryService)
    expect(agents.get('executor')).toBeInstanceOf(ScopedMemoryService)
    expect(agents.get('planner')?.agentId).toBe('planner')
    expect(agents.get('executor')?.agentId).toBe('executor')
  })

  it('passes strict option to all services', async () => {
    const { service } = createMockMemoryService()
    const policies: MemoryAccessPolicy[] = [
      { agentId: 'blocked', namespaces: {} },
    ]

    const agents = createAgentMemories(service, policies, { strict: true })
    const scoped = agents.get('blocked')!

    await expect(
      scoped.put('ns', SCOPE, 'k', { text: 'x' }),
    ).rejects.toThrow(/access violation/)
  })
})

// ---------------------------------------------------------------------------
// PolicyTemplates
// ---------------------------------------------------------------------------

describe('PolicyTemplates', () => {
  describe('fullAccess', () => {
    it('grants read-write to all namespaces by default', () => {
      const policy = PolicyTemplates.fullAccess('admin')
      expect(policy.agentId).toBe('admin')
      expect(policy.defaultAccess).toBe('read-write')
      expect(Object.keys(policy.namespaces)).toHaveLength(0)
    })

    it('allows read and write on any namespace', () => {
      const { service } = createMockMemoryService()
      const scoped = new ScopedMemoryService(service, PolicyTemplates.fullAccess('admin'))
      expect(scoped.canAccess('anything', 'read')).toBe(true)
      expect(scoped.canAccess('anything', 'write')).toBe(true)
    })
  })

  describe('readOnly', () => {
    it('grants read-only to all namespaces by default', () => {
      const policy = PolicyTemplates.readOnly('observer')
      expect(policy.agentId).toBe('observer')
      expect(policy.defaultAccess).toBe('read')
    })

    it('denies write on any namespace', () => {
      const { service } = createMockMemoryService()
      const scoped = new ScopedMemoryService(service, PolicyTemplates.readOnly('observer'))
      expect(scoped.canAccess('ns', 'read')).toBe(true)
      expect(scoped.canAccess('ns', 'write')).toBe(false)
    })
  })

  describe('isolatedWithSharedRead', () => {
    it('grants read-write to own and read to shared namespaces', () => {
      const policy = PolicyTemplates.isolatedWithSharedRead(
        'worker',
        ['worker-scratch'],
        ['shared-context'],
      )
      expect(policy.namespaces['worker-scratch']).toBe('read-write')
      expect(policy.namespaces['shared-context']).toBe('read')
      expect(policy.defaultAccess).toBe('none')
    })

    it('denies access to unlisted namespaces', () => {
      const { service } = createMockMemoryService()
      const policy = PolicyTemplates.isolatedWithSharedRead('w', ['own'], ['shared'])
      const scoped = new ScopedMemoryService(service, policy)
      expect(scoped.canAccess('unknown', 'read')).toBe(false)
      expect(scoped.canAccess('unknown', 'write')).toBe(false)
    })
  })

  describe('restricted', () => {
    it('applies the provided namespace map with none default', () => {
      const policy = PolicyTemplates.restricted('bot', {
        logs: 'write',
        config: 'read',
      })
      expect(policy.namespaces['logs']).toBe('write')
      expect(policy.namespaces['config']).toBe('read')
      expect(policy.defaultAccess).toBe('none')
    })
  })
})
