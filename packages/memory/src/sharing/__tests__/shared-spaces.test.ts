import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemorySpaceManager } from '../memory-space-manager.js'
import type { SharedMemoryEvent } from '../types.js'
import type { MemoryService } from '../../memory-service.js'
import type { MemoryStoreCapabilities } from '../../store-capabilities.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PutCall {
  ns: string
  scope: Record<string, string>
  key: string
  value: Record<string, unknown>
}

interface DeleteCall {
  ns: string
  scope: Record<string, string>
  key: string
}

type RecordStore = Map<string, Map<string, Record<string, unknown>>>

function createMockMemoryService(options?: { failingDeleteKeys?: string[] }): {
  service: MemoryService
  putCalls: PutCall[]
  deleteCalls: DeleteCall[]
  records: RecordStore
  capabilities: MemoryStoreCapabilities
} {
  const putCalls: PutCall[] = []
  const deleteCalls: DeleteCall[] = []
  const records: RecordStore = new Map()
  const failingDeleteKeys = new Set(options?.failingDeleteKeys ?? [])
  const capabilities: MemoryStoreCapabilities = {
    supportsDelete: true,
    supportsSearchFilters: true,
    supportsPagination: true,
  }

  const service = {
    put: vi.fn().mockImplementation(
      (ns: string, scope: Record<string, string>, key: string, value: Record<string, unknown>) => {
        putCalls.push({ ns, scope, key, value })
        const nsKey = `${ns}:${JSON.stringify(scope)}`
        if (!records.has(nsKey)) records.set(nsKey, new Map())
        records.get(nsKey)!.set(key, value)
        return Promise.resolve()
      },
    ),
    delete: vi.fn().mockImplementation(
      (ns: string, scope: Record<string, string>, key: string) => {
        deleteCalls.push({ ns, scope, key })
        if (failingDeleteKeys.has(key)) {
          return Promise.resolve(false)
        }
        const nsKey = `${ns}:${JSON.stringify(scope)}`
        records.get(nsKey)?.delete(key)
        return Promise.resolve(true)
      },
    ),
    get: vi.fn().mockImplementation(
      (ns: string, scope: Record<string, string>, key?: string) => {
        const nsKey = `${ns}:${JSON.stringify(scope)}`
        const nsRecords = records.get(nsKey)
        if (!nsRecords) return Promise.resolve([])
        if (key) {
          const val = nsRecords.get(key)
          return Promise.resolve(val ? [val] : [])
        }
        return Promise.resolve(Array.from(nsRecords.values()))
      },
    ),
    search: vi.fn().mockImplementation(
      (ns: string, scope: Record<string, string>, _query: string, _limit?: number) => {
        const nsKey = `${ns}:${JSON.stringify(scope)}`
        const nsRecords = records.get(nsKey)
        if (!nsRecords) return Promise.resolve([])
        return Promise.resolve(Array.from(nsRecords.values()))
      },
    ),
    getStoreCapabilities: vi.fn().mockImplementation(() => ({ ...capabilities })),
    formatForPrompt: vi.fn().mockReturnValue(''),
  } as unknown as MemoryService

  return { service, putCalls, deleteCalls, records, capabilities }
}

const OWNER_URI = 'forge://acme/planner'
const AGENT_A = 'forge://acme/executor'
const AGENT_B = 'forge://acme/reviewer'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemorySpaceManager', () => {
  let mock: ReturnType<typeof createMockMemoryService>
  let manager: MemorySpaceManager
  let events: SharedMemoryEvent[]

  beforeEach(() => {
    mock = createMockMemoryService()
    events = []
    manager = new MemorySpaceManager({
      memoryService: mock.service,
      onEvent: (e) => events.push(e),
    })
  })

  // -----------------------------------------------------------------------
  // create
  // -----------------------------------------------------------------------

  describe('create', () => {
    it('returns a SharedMemorySpace with generated ID', async () => {
      const space = await manager.create({
        name: 'team-knowledge',
        owner: OWNER_URI,
      })

      expect(space.id).toBeDefined()
      expect(space.id.length).toBeGreaterThan(0)
      expect(space.name).toBe('team-knowledge')
      expect(space.owner).toBe(OWNER_URI)
      expect(space.conflictResolution).toBe('lww')
      expect(space.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(space.participants).toHaveLength(1)
      expect(space.participants[0]!.agentUri).toBe(OWNER_URI)
      expect(space.participants[0]!.permission).toBe('admin')
    })

    it('stores the space via MemoryService', async () => {
      const space = await manager.create({
        name: 'test',
        owner: OWNER_URI,
      })

      const stored = mock.putCalls.find(c => c.ns === '__spaces' && c.key === space.id)
      expect(stored).toBeDefined()
    })

    it('emits memory:space:created event', async () => {
      const space = await manager.create({
        name: 'test',
        owner: OWNER_URI,
      })

      const event = events.find(e => e.type === 'memory:space:created')
      expect(event).toBeDefined()
      expect(event!.type === 'memory:space:created' && event!.spaceId).toBe(space.id)
    })

    it('preserves retentionPolicy when provided', async () => {
      const space = await manager.create({
        name: 'limited',
        owner: OWNER_URI,
        retentionPolicy: { maxRecords: 100, maxAgeMs: 3600000 },
      })

      expect(space.retentionPolicy).toEqual({ maxRecords: 100, maxAgeMs: 3600000 })
    })

    it('uses provided conflictResolution', async () => {
      const space = await manager.create({
        name: 'manual-space',
        owner: OWNER_URI,
        conflictResolution: 'manual',
      })

      expect(space.conflictResolution).toBe('manual')
    })
  })

  // -----------------------------------------------------------------------
  // share
  // -----------------------------------------------------------------------

  describe('share', () => {
    it('rejects subscribe mode with a migration-safe error', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })

      await expect(manager.share({
        from: OWNER_URI,
        spaceId: space.id,
        key: 'k1',
        value: { text: 'data' },
        mode: 'subscribe' as never,
      })).rejects.toThrow('MemorySpaceManager.subscribe()')
    })
  })

  // -----------------------------------------------------------------------
  // join
  // -----------------------------------------------------------------------

  describe('join', () => {
    it('adds participant with permission', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      await manager.join(space.id, AGENT_A, 'read-write')

      const updated = await manager.getSpace(space.id)
      expect(updated).toBeDefined()
      expect(updated!.participants).toHaveLength(2)
      const agentA = updated!.participants.find(p => p.agentUri === AGENT_A)
      expect(agentA).toBeDefined()
      expect(agentA!.permission).toBe('read-write')
    })

    it('defaults to read permission', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      await manager.join(space.id, AGENT_A)

      const updated = await manager.getSpace(space.id)
      const agentA = updated!.participants.find(p => p.agentUri === AGENT_A)
      expect(agentA!.permission).toBe('read')
    })

    it('emits memory:space:joined event', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      events.length = 0

      await manager.join(space.id, AGENT_A, 'read-write')

      const event = events.find(e => e.type === 'memory:space:joined')
      expect(event).toBeDefined()
      if (event && event.type === 'memory:space:joined') {
        expect(event.agentUri).toBe(AGENT_A)
        expect(event.permission).toBe('read-write')
      }
    })

    it('is idempotent for same agent', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      await manager.join(space.id, AGENT_A)
      await manager.join(space.id, AGENT_A)

      const updated = await manager.getSpace(space.id)
      const agentAs = updated!.participants.filter(p => p.agentUri === AGENT_A)
      expect(agentAs).toHaveLength(1)
    })

    it('throws for unknown space', async () => {
      await expect(manager.join('nonexistent', AGENT_A)).rejects.toThrow('Space not found')
    })
  })

  // -----------------------------------------------------------------------
  // leave
  // -----------------------------------------------------------------------

  describe('leave', () => {
    it('removes participant', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      await manager.join(space.id, AGENT_A)
      await manager.leave(space.id, AGENT_A)

      const updated = await manager.getSpace(space.id)
      expect(updated!.participants.find(p => p.agentUri === AGENT_A)).toBeUndefined()
    })

    it('emits memory:space:left event', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      await manager.join(space.id, AGENT_A)
      events.length = 0

      await manager.leave(space.id, AGENT_A)

      const event = events.find(e => e.type === 'memory:space:left')
      expect(event).toBeDefined()
      if (event && event.type === 'memory:space:left') {
        expect(event.agentUri).toBe(AGENT_A)
      }
    })

    it('is a no-op for non-participant', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      await manager.leave(space.id, 'forge://nobody/agent')
      // No error thrown
    })
  })

  // -----------------------------------------------------------------------
  // share (push)
  // -----------------------------------------------------------------------

  describe('share (push)', () => {
    it('writes to space namespace with provenance', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })

      await manager.share({
        from: OWNER_URI,
        spaceId: space.id,
        key: 'k1',
        value: { text: 'shared knowledge' },
        mode: 'push',
      })

      // Find the write to the space namespace
      const spaceWrite = mock.putCalls.find(c => c.ns === `space:${space.id}`)
      expect(spaceWrite).toBeDefined()
      expect(spaceWrite!.key).toBe('k1')
      expect(spaceWrite!.value['text']).toBe('shared knowledge')
      // Provenance should be injected by ProvenanceWriter
      expect(spaceWrite!.value['_provenance']).toBeDefined()
    })

    it('emits memory:space:write event', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      events.length = 0

      await manager.share({
        from: OWNER_URI,
        spaceId: space.id,
        key: 'k1',
        value: { text: 'data' },
        mode: 'push',
      })

      const event = events.find(e => e.type === 'memory:space:write')
      expect(event).toBeDefined()
      if (event && event.type === 'memory:space:write') {
        expect(event.key).toBe('k1')
        expect(event.agentUri).toBe(OWNER_URI)
      }
    })

    it('denied without write permission (read-only user)', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      await manager.join(space.id, AGENT_A, 'read')

      await expect(
        manager.share({
          from: AGENT_A,
          spaceId: space.id,
          key: 'k1',
          value: { text: 'data' },
          mode: 'push',
        }),
      ).rejects.toThrow('does not have write permission')
    })

    it('allows write for read-write participant', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      await manager.join(space.id, AGENT_A, 'read-write')

      await expect(
        manager.share({
          from: AGENT_A,
          spaceId: space.id,
          key: 'k1',
          value: { text: 'data' },
          mode: 'push',
        }),
      ).resolves.toBeUndefined()
    })

    it('throws for non-participant', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })

      await expect(
        manager.share({
          from: AGENT_A,
          spaceId: space.id,
          key: 'k1',
          value: { text: 'data' },
          mode: 'push',
        }),
      ).rejects.toThrow('is not a participant')
    })
  })

  // -----------------------------------------------------------------------
  // share (pull-request)
  // -----------------------------------------------------------------------

  describe('share (pull-request)', () => {
    it('creates pending request', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      await manager.join(space.id, AGENT_A, 'read')

      await manager.share({
        from: AGENT_A,
        spaceId: space.id,
        key: 'k1',
        value: { text: 'proposed' },
        mode: 'pull-request',
      })

      const pending = await manager.listPendingRequests(space.id)
      expect(pending).toHaveLength(1)
      expect(pending[0]!.status).toBe('pending')
      expect(pending[0]!.request.key).toBe('k1')
    })

    it('emits memory:space:pull_request event', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      await manager.join(space.id, AGENT_A, 'read')
      events.length = 0

      await manager.share({
        from: AGENT_A,
        spaceId: space.id,
        key: 'k1',
        value: { text: 'proposed' },
        mode: 'pull-request',
      })

      const event = events.find(e => e.type === 'memory:space:pull_request')
      expect(event).toBeDefined()
      if (event && event.type === 'memory:space:pull_request') {
        expect(event.agentUri).toBe(AGENT_A)
      }
    })
  })

  // -----------------------------------------------------------------------
  // query
  // -----------------------------------------------------------------------

  describe('query', () => {
    it('returns records from space', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })

      await manager.share({
        from: OWNER_URI,
        spaceId: space.id,
        key: 'k1',
        value: { text: 'knowledge' },
        mode: 'push',
      })

      const results = await manager.query(space.id, OWNER_URI)
      expect(results.length).toBeGreaterThanOrEqual(1)
    })

    it('denied without read permission (non-participant)', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })

      await expect(
        manager.query(space.id, AGENT_A),
      ).rejects.toThrow('is not a participant')
    })

    it('uses search when queryText is provided', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })

      await manager.share({
        from: OWNER_URI,
        spaceId: space.id,
        key: 'k1',
        value: { text: 'knowledge' },
        mode: 'push',
      })

      await manager.query(space.id, OWNER_URI, 'search query', 5)
      expect(mock.service.search).toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // reviewPullRequest
  // -----------------------------------------------------------------------

  describe('reviewPullRequest', () => {
    it('approved: executes the write', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      await manager.join(space.id, AGENT_A, 'read')

      await manager.share({
        from: AGENT_A,
        spaceId: space.id,
        key: 'k1',
        value: { text: 'proposed' },
        mode: 'pull-request',
      })

      const pending = await manager.listPendingRequests(space.id)
      expect(pending).toHaveLength(1)

      const putCountBefore = mock.putCalls.filter(c => c.ns === `space:${space.id}`).length

      await manager.reviewPullRequest(pending[0]!.id, OWNER_URI, true)

      // Should have written to the space namespace
      const putCountAfter = mock.putCalls.filter(c => c.ns === `space:${space.id}`).length
      expect(putCountAfter).toBeGreaterThan(putCountBefore)
    })

    it('rejected: does not write to space', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      await manager.join(space.id, AGENT_A, 'read')

      await manager.share({
        from: AGENT_A,
        spaceId: space.id,
        key: 'k1',
        value: { text: 'proposed' },
        mode: 'pull-request',
      })

      const pending = await manager.listPendingRequests(space.id)
      const putCountBefore = mock.putCalls.filter(c => c.ns === `space:${space.id}`).length

      await manager.reviewPullRequest(pending[0]!.id, OWNER_URI, false)

      const putCountAfter = mock.putCalls.filter(c => c.ns === `space:${space.id}`).length
      expect(putCountAfter).toBe(putCountBefore)
    })

    it('denied for non-admin', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      await manager.join(space.id, AGENT_A, 'read')
      await manager.join(space.id, AGENT_B, 'read-write')

      await manager.share({
        from: AGENT_A,
        spaceId: space.id,
        key: 'k1',
        value: { text: 'proposed' },
        mode: 'pull-request',
      })

      const pending = await manager.listPendingRequests(space.id)

      await expect(
        manager.reviewPullRequest(pending[0]!.id, AGENT_B, true),
      ).rejects.toThrow('does not have admin permission')
    })

    it('emits pull_reviewed event', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      await manager.join(space.id, AGENT_A, 'read')

      await manager.share({
        from: AGENT_A,
        spaceId: space.id,
        key: 'k1',
        value: { text: 'proposed' },
        mode: 'pull-request',
      })

      const pending = await manager.listPendingRequests(space.id)
      events.length = 0

      await manager.reviewPullRequest(pending[0]!.id, OWNER_URI, true)

      const event = events.find(e => e.type === 'memory:space:pull_reviewed')
      expect(event).toBeDefined()
      if (event && event.type === 'memory:space:pull_reviewed') {
        expect(event.status).toBe('approved')
      }
    })

    it('treats malformed persisted pending requests as not found', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      const pendingRecords = new Map<string, Record<string, unknown>>()
      pendingRecords.set('bad-request', {
        id: 'bad-request',
        request: {
          from: AGENT_A,
          spaceId: space.id,
          key: 'k1',
          value: 'not-an-object',
          mode: 'pull-request',
        },
        status: 'pending',
        createdAt: new Date().toISOString(),
      })
      mock.records.set(`__pending_shares:${JSON.stringify({ _ns: '__pending_shares' })}`, pendingRecords)

      await expect(
        manager.reviewPullRequest('bad-request', OWNER_URI, true),
      ).rejects.toThrow('Pending request not found: bad-request')
    })
  })

  // -----------------------------------------------------------------------
  // listSpaces
  // -----------------------------------------------------------------------

  describe('listSpaces', () => {
    it('filters by participant', async () => {
      const space1 = await manager.create({ name: 's1', owner: OWNER_URI })
      const space2 = await manager.create({ name: 's2', owner: OWNER_URI })
      await manager.join(space1.id, AGENT_A)

      const agentSpaces = await manager.listSpaces(AGENT_A)
      const ids = agentSpaces.map(s => s.id)
      expect(ids).toContain(space1.id)
      expect(ids).not.toContain(space2.id)
    })

    it('returns all spaces when no agentUri', async () => {
      await manager.create({ name: 's1', owner: OWNER_URI })
      await manager.create({ name: 's2', owner: OWNER_URI })

      const all = await manager.listSpaces()
      expect(all).toHaveLength(2)
    })

    it('ignores persisted spaces with malformed participant and policy data', async () => {
      const validSpace = await manager.create({
        name: 'valid',
        owner: OWNER_URI,
        retentionPolicy: { maxRecords: 5, maxAgeMs: 1000 },
      })
      const spacesKey = `__spaces:${JSON.stringify({ _ns: '__spaces' })}`
      mock.records.get(spacesKey)!.set('bad-participant', {
        id: 'bad-participant',
        name: 'bad participant',
        owner: OWNER_URI,
        participants: [{ agentUri: AGENT_A, permission: 'owner', joinedAt: new Date().toISOString() }],
        conflictResolution: 'lww',
        createdAt: new Date().toISOString(),
      })
      mock.records.get(spacesKey)!.set('bad-policy', {
        id: 'bad-policy',
        name: 'bad policy',
        owner: OWNER_URI,
        participants: [{ agentUri: AGENT_A, permission: 'read', joinedAt: new Date().toISOString() }],
        retentionPolicy: { maxRecords: -1 },
        conflictResolution: 'lww',
        createdAt: new Date().toISOString(),
      })

      const spaces = await manager.listSpaces()

      expect(spaces.map(space => space.id)).toEqual([validSpace.id])
      expect(spaces[0]!.retentionPolicy).toEqual({ maxRecords: 5, maxAgeMs: 1000 })
    })
  })

  // -----------------------------------------------------------------------
  // getSpace
  // -----------------------------------------------------------------------

  describe('getSpace', () => {
    it('returns undefined for unknown ID', async () => {
      const result = await manager.getSpace('nonexistent-id')
      expect(result).toBeUndefined()
    })

    it('returns space for valid ID', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      const loaded = await manager.getSpace(space.id)
      expect(loaded).toBeDefined()
      expect(loaded!.id).toBe(space.id)
    })

    it('returns undefined for persisted spaces with malformed timestamps', async () => {
      mock.records.set(`__spaces:${JSON.stringify({ _ns: '__spaces' })}`, new Map([
        ['bad-timestamp', {
          id: 'bad-timestamp',
          name: 'bad timestamp',
          owner: OWNER_URI,
          participants: [{ agentUri: OWNER_URI, permission: 'admin', joinedAt: 'not-a-date' }],
          conflictResolution: 'lww',
          createdAt: new Date().toISOString(),
        }],
      ]))

      await expect(manager.getSpace('bad-timestamp')).resolves.toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // listPendingRequests
  // -----------------------------------------------------------------------

  describe('listPendingRequests', () => {
    it('decodes pending requests and ignores malformed stored records', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      const createdAt = new Date().toISOString()
      const pendingRecords = new Map<string, Record<string, unknown>>()
      pendingRecords.set('valid-request', {
        id: 'valid-request',
        request: {
          from: AGENT_A,
          spaceId: space.id,
          key: 'k1',
          value: { text: 'proposed' },
          mode: 'pull-request',
        },
        status: 'pending',
        createdAt,
      })
      pendingRecords.set('bad-status', {
        id: 'bad-status',
        request: {
          from: AGENT_A,
          spaceId: space.id,
          key: 'k2',
          value: { text: 'bad' },
          mode: 'pull-request',
        },
        status: 'waiting',
        createdAt,
      })
      pendingRecords.set('bad-created-at', {
        id: 'bad-created-at',
        request: {
          from: AGENT_A,
          spaceId: space.id,
          key: 'k3',
          value: { text: 'bad' },
          mode: 'pull-request',
        },
        status: 'pending',
        createdAt: 'not-a-date',
      })
      mock.records.set(`__pending_shares:${JSON.stringify({ _ns: '__pending_shares' })}`, pendingRecords)

      const pending = await manager.listPendingRequests(space.id)

      expect(pending).toEqual([
        {
          id: 'valid-request',
          request: {
            from: AGENT_A,
            spaceId: space.id,
            key: 'k1',
            value: { text: 'proposed' },
            mode: 'pull-request',
          },
          status: 'pending',
          createdAt,
        },
      ])
    })
  })

  // -----------------------------------------------------------------------
  // enforceRetention
  // -----------------------------------------------------------------------

  describe('enforceRetention', () => {
    it('prunes old records', async () => {
      const space = await manager.create({
        name: 'limited',
        owner: OWNER_URI,
        retentionPolicy: { maxRecords: 1 },
      })

      // Manually seed 3 records in the space namespace
      const nsKey = `space:${space.id}:${JSON.stringify({ _space: space.id })}`
      const spaceRecords = new Map<string, Record<string, unknown>>()
      spaceRecords.set('record-0', {
        text: 'old',
        _provenance: { createdAt: new Date(Date.now() - 10000).toISOString(), createdBy: OWNER_URI, source: 'shared', confidence: 1, contentHash: 'a', lineage: [OWNER_URI] },
      })
      spaceRecords.set('record-1', {
        text: 'newer',
        _provenance: { createdAt: new Date(Date.now() - 5000).toISOString(), createdBy: OWNER_URI, source: 'shared', confidence: 1, contentHash: 'b', lineage: [OWNER_URI] },
      })
      spaceRecords.set('record-2', {
        text: 'newest',
        _provenance: { createdAt: new Date().toISOString(), createdBy: OWNER_URI, source: 'shared', confidence: 1, contentHash: 'c', lineage: [OWNER_URI] },
      })
      mock.records.set(nsKey, spaceRecords)

      const result = await manager.enforceRetention(space.id)
      expect(result.pruned).toBe(2) // Keep 1 (newest), prune 2
    })

    it('returns pruned:0 for space without retention policy', async () => {
      const space = await manager.create({ name: 'no-limit', owner: OWNER_URI })
      const result = await manager.enforceRetention(space.id)
      expect(result.pruned).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // compactTombstones
  // -----------------------------------------------------------------------

  describe('compactTombstones', () => {
    it('deletes tombstones and records metrics when delete is supported', async () => {
      const space = await manager.create({
        name: 'compactable',
        owner: OWNER_URI,
        retentionPolicy: { maxAgeMs: 1000 },
      })

      const nsKey = `space:${space.id}:${JSON.stringify({ _space: space.id })}`
      const spaceRecords = new Map<string, Record<string, unknown>>()
      spaceRecords.set('active', { text: 'active' })
      spaceRecords.set('old-tombstone', {
        _tombstone: true,
        _deletedAt: new Date(Date.now() - 5000).toISOString(),
      })
      spaceRecords.set('fresh-tombstone', {
        _tombstone: true,
        _deletedAt: new Date().toISOString(),
      })
      mock.records.set(nsKey, spaceRecords)

      const report = await manager.compactTombstones(space.id)

      expect(report.tombstonesFound).toBe(2)
      expect(report.tombstonesCompacted).toBe(1)
      expect(report.tombstonesSkipped).toBe(0)
      expect(report.durationMs).toBeGreaterThanOrEqual(0)
      expect(mock.deleteCalls).toHaveLength(1)
      expect(events.some(e => e.type === 'memory:space:tombstones_compacted')).toBe(true)

      const metrics = manager.getTombstoneCompactionMetrics()
      expect(metrics.runs).toBe(1)
      expect(metrics.tombstonesFound).toBe(2)
      expect(metrics.tombstonesCompacted).toBe(1)
      expect(metrics.lastDurationMs).toBe(report.durationMs)
    })

    it('counts failed deletes as skipped and only confirmed deletes as compacted', async () => {
      const localEvents: SharedMemoryEvent[] = []
      const localMock = createMockMemoryService({
        failingDeleteKeys: ['failed-tombstone'],
      })
      const localManager = new MemorySpaceManager({
        memoryService: localMock.service,
        onEvent: (e) => localEvents.push(e),
      })

      const space = await localManager.create({
        name: 'partial-failure',
        owner: OWNER_URI,
      })

      const nsKey = `space:${space.id}:${JSON.stringify({ _space: space.id })}`
      const spaceRecords = new Map<string, Record<string, unknown>>()
      spaceRecords.set('successful-tombstone', {
        _key: 'successful-tombstone',
        _tombstone: true,
        _deletedAt: new Date(Date.now() - 5000).toISOString(),
      })
      spaceRecords.set('failed-tombstone', {
        _key: 'failed-tombstone',
        _tombstone: true,
        _deletedAt: new Date(Date.now() - 10000).toISOString(),
      })
      localMock.records.set(nsKey, spaceRecords)

      const report = await localManager.compactTombstones(space.id)

      expect(report.tombstonesFound).toBe(2)
      expect(report.tombstonesCompacted).toBe(1)
      expect(report.tombstonesSkipped).toBe(1)
      expect(report.durationMs).toBeGreaterThanOrEqual(0)
      expect(localMock.deleteCalls).toHaveLength(2)
      expect(localEvents.some(e => e.type === 'memory:space:tombstones_compacted')).toBe(true)

      const metrics = localManager.getTombstoneCompactionMetrics()
      expect(metrics.runs).toBe(1)
      expect(metrics.tombstonesFound).toBe(2)
      expect(metrics.tombstonesCompacted).toBe(1)
      expect(metrics.tombstonesSkipped).toBe(1)
    })

    it('skips hard delete when the backing store reports no delete support', async () => {
      mock.capabilities.supportsDelete = false

      const space = await manager.create({
        name: 'no-delete',
        owner: OWNER_URI,
      })

      const nsKey = `space:${space.id}:${JSON.stringify({ _space: space.id })}`
      const spaceRecords = new Map<string, Record<string, unknown>>()
      spaceRecords.set('tombstone', {
        _tombstone: true,
        _deletedAt: new Date(Date.now() - 5000).toISOString(),
      })
      mock.records.set(nsKey, spaceRecords)

      const report = await manager.compactTombstones(space.id)

      expect(report.tombstonesFound).toBe(1)
      expect(report.tombstonesCompacted).toBe(0)
      expect(report.tombstonesSkipped).toBe(1)
      expect(mock.deleteCalls).toHaveLength(0)
      expect(manager.getTombstoneCompactionMetrics().tombstonesSkipped).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // subscribe
  // -----------------------------------------------------------------------

  describe('subscribe', () => {
    it('receives events on write', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      const subEvents: SharedMemoryEvent[] = []

      manager.subscribe(space.id, (e) => subEvents.push(e))

      await manager.share({
        from: OWNER_URI,
        spaceId: space.id,
        key: 'k1',
        value: { text: 'data' },
        mode: 'push',
      })

      const writeEvent = subEvents.find(e => e.type === 'memory:space:write')
      expect(writeEvent).toBeDefined()
    })

    it('unsubscribe stops receiving events', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      const subEvents: SharedMemoryEvent[] = []

      const sub = manager.subscribe(space.id, (e) => subEvents.push(e))
      sub.unsubscribe()

      await manager.share({
        from: OWNER_URI,
        spaceId: space.id,
        key: 'k1',
        value: { text: 'data' },
        mode: 'push',
      })

      expect(subEvents).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // dispose
  // -----------------------------------------------------------------------

  describe('dispose', () => {
    it('cleans up subscriptions', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      const subEvents: SharedMemoryEvent[] = []

      manager.subscribe(space.id, (e) => subEvents.push(e))
      manager.dispose()

      await manager.share({
        from: OWNER_URI,
        spaceId: space.id,
        key: 'k1',
        value: { text: 'data' },
        mode: 'push',
      })

      // No events after dispose
      expect(subEvents).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // Events emitted for create/join/leave/write
  // -----------------------------------------------------------------------

  describe('event emission', () => {
    it('emits correct event types for lifecycle operations', async () => {
      const space = await manager.create({ name: 'test', owner: OWNER_URI })
      await manager.join(space.id, AGENT_A, 'read-write')
      await manager.share({
        from: AGENT_A,
        spaceId: space.id,
        key: 'k1',
        value: { text: 'data' },
        mode: 'push',
      })
      await manager.leave(space.id, AGENT_A)

      const types = events.map(e => e.type)
      expect(types).toContain('memory:space:created')
      expect(types).toContain('memory:space:joined')
      expect(types).toContain('memory:space:write')
      expect(types).toContain('memory:space:left')
    })
  })
})
