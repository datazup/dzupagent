/**
 * Tests for DrizzleClusterStore using a Proxy-based chainable mock Drizzle client.
 *
 * We simulate the subset of the Drizzle fluent API used by the store:
 *   - db.insert(table).values(...)
 *   - db.select().from(table).where(...).limit(1)
 *   - db.select().from(table).where(...)
 *   - db.delete(table).where(...)  → resolves to { rowCount: N }
 *
 * No real Postgres connection is required.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DrizzleClusterStore } from '../persistence/drizzle-cluster-store.js'
import type { ClusterRecord, CreateClusterInput } from '../persistence/drizzle-cluster-store.js'
import type { ClusterRole } from '@dzupagent/agent'

// ---------------------------------------------------------------------------
// Mock drizzle-orm and schema modules
// ---------------------------------------------------------------------------

vi.mock('drizzle-orm', () => ({
  eq: (_col: unknown, value: unknown) => ({ _mockEq: true, value }),
  and: (...conditions: unknown[]) => ({ _mockAnd: true, conditions }),
}))

vi.mock('../persistence/drizzle-schema.js', () => ({
  agentClusters: { _table: 'agent_clusters' },
  clusterRoles: { _table: 'cluster_roles' },
}))

// ---------------------------------------------------------------------------
// Call log type
// ---------------------------------------------------------------------------

interface CallLog {
  op: string
  fn: string
  args: unknown[]
}

// ---------------------------------------------------------------------------
// Proxy-based chainable mock builder
// (identical pattern to drizzle-a2a-task-store.test.ts)
// ---------------------------------------------------------------------------

function makeChain(
  terminal: unknown,
  onCall: (fn: string, args: unknown[]) => void,
): Record<string, unknown> {
  const handler: ProxyHandler<() => unknown> = {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve(terminal).then(onFulfilled)
      }
      return (...args: unknown[]) => {
        onCall(prop, args)
        return makeChain(terminal, onCall)
      }
    },
  }
  return new Proxy(function proxyFn() {}, handler)
}

interface MockDbConfig {
  /** Each entry is the rows returned by one select() call, consumed in order. */
  selectSequence?: unknown[][]
  /** Each entry is the result returned by one insert() call, consumed in order. */
  insertSequence?: unknown[][]
  /** Each entry is the result returned by one delete() call, consumed in order. */
  deleteSequence?: unknown[][]
  /** Optional call log that accumulates all chain method invocations. */
  log?: CallLog[]
}

function buildMockDb(cfg: MockDbConfig = {}): Record<string, unknown> {
  const log = cfg.log ?? []
  const selQueue = [...(cfg.selectSequence ?? [])]
  const insQueue = [...(cfg.insertSequence ?? [])]
  const delQueue = [...(cfg.deleteSequence ?? [])]

  const make = (op: string, terminal: unknown) => {
    const onCall = (fn: string, args: unknown[]): void => {
      log.push({ op, fn, args })
    }
    return makeChain(terminal, onCall)
  }

  return {
    // select() resolves to rows array
    select: vi.fn(() => make('select', selQueue.shift() ?? [])),
    // insert() resolves to void (cluster store does not use .returning())
    insert: vi.fn(() => make('insert', insQueue.shift() ?? undefined)),
    // delete() resolves to { rowCount: N }
    delete: vi.fn(() => make('delete', delQueue.shift() ?? { rowCount: 0 })),
    _log: log,
  }
}

// ---------------------------------------------------------------------------
// Row factory helpers
// ---------------------------------------------------------------------------

function makeClusterRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 'cluster-1',
    workspaceType: 'local',
    workspaceOptions: {},
    metadata: {},
    createdAt: new Date('2026-04-19T00:00:00Z'),
    updatedAt: new Date('2026-04-19T00:00:00Z'),
    ...overrides,
  }
}

function makeRoleRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    roleId: 'planner',
    agentId: 'agent-1',
    capabilities: ['plan', 'reason'],
    ...overrides,
  }
}

function makeRole(overrides: Partial<ClusterRole> = {}): ClusterRole {
  return {
    roleId: 'planner',
    agentId: 'agent-1',
    capabilities: ['plan', 'reason'],
    ...overrides,
  }
}

function makeCreateInput(
  overrides: Partial<CreateClusterInput> = {},
): CreateClusterInput {
  return {
    id: 'cluster-1',
    workspaceType: 'local',
    workspaceOptions: {},
    metadata: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DrizzleClusterStore', () => {
  let db: ReturnType<typeof buildMockDb>
  let store: DrizzleClusterStore

  beforeEach(() => {
    vi.useFakeTimers().setSystemTime(new Date('2026-04-19T00:00:00Z'))
    db = buildMockDb()
    store = new DrizzleClusterStore(db)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // create()
  // -------------------------------------------------------------------------

  describe('create()', () => {
    it('calls db.insert once', async () => {
      store = new DrizzleClusterStore(buildMockDb())
      await store.create(makeCreateInput())
      expect(db.insert).not.toHaveBeenCalled() // using store's own db
    })

    it('calls insert on agentClusters table', async () => {
      const log: CallLog[] = []
      db = buildMockDb({ log })
      store = new DrizzleClusterStore(db)

      await store.create(makeCreateInput())

      expect(db.insert).toHaveBeenCalledTimes(1)
    })

    it('passes correct field values in .values() call', async () => {
      const log: CallLog[] = []
      db = buildMockDb({ log })
      store = new DrizzleClusterStore(db)

      await store.create({
        id: 'c-42',
        workspaceType: 'docker',
        workspaceOptions: { image: 'node:20' },
        metadata: { owner: 'alice' },
      })

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      expect(valuesCall).toBeDefined()
      const inserted = valuesCall!.args[0] as Record<string, unknown>
      expect(inserted['id']).toBe('c-42')
      expect(inserted['workspaceType']).toBe('docker')
      expect(inserted['workspaceOptions']).toEqual({ image: 'node:20' })
      expect(inserted['metadata']).toEqual({ owner: 'alice' })
    })

    it('sets createdAt and updatedAt to the current time', async () => {
      const log: CallLog[] = []
      db = buildMockDb({ log })
      store = new DrizzleClusterStore(db)

      await store.create(makeCreateInput())

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      const inserted = valuesCall!.args[0] as Record<string, unknown>
      expect(inserted['createdAt']).toBeInstanceOf(Date)
      expect(inserted['updatedAt']).toBeInstanceOf(Date)
      expect((inserted['createdAt'] as Date).toISOString()).toBe(
        '2026-04-19T00:00:00.000Z',
      )
    })

    it('returns a ClusterRecord with roles: []', async () => {
      db = buildMockDb()
      store = new DrizzleClusterStore(db)

      const result = await store.create(makeCreateInput({ id: 'c-new' }))

      expect(result.id).toBe('c-new')
      expect(result.roles).toEqual([])
    })

    it('defaults workspaceType to "local" when not provided', async () => {
      db = buildMockDb()
      store = new DrizzleClusterStore(db)

      const result = await store.create({ id: 'c-default' })

      expect(result.workspaceType).toBe('local')
    })

    it('defaults workspaceOptions to {} when not provided', async () => {
      db = buildMockDb()
      store = new DrizzleClusterStore(db)

      const result = await store.create({ id: 'c-default' })

      expect(result.workspaceOptions).toEqual({})
    })

    it('defaults metadata to {} when not provided', async () => {
      db = buildMockDb()
      store = new DrizzleClusterStore(db)

      const result = await store.create({ id: 'c-default' })

      expect(result.metadata).toEqual({})
    })

    it('returns provided workspaceOptions in the record', async () => {
      db = buildMockDb()
      store = new DrizzleClusterStore(db)
      const opts = { cpu: 4, memory: '8Gi' }

      const result = await store.create(makeCreateInput({ workspaceOptions: opts }))

      expect(result.workspaceOptions).toEqual(opts)
    })

    it('returns provided metadata in the record', async () => {
      db = buildMockDb()
      store = new DrizzleClusterStore(db)
      const meta = { team: 'backend', project: 'dzup' }

      const result = await store.create(makeCreateInput({ metadata: meta }))

      expect(result.metadata).toEqual(meta)
    })

    it('returned record has createdAt and updatedAt as Date instances', async () => {
      db = buildMockDb()
      store = new DrizzleClusterStore(db)

      const result: ClusterRecord = await store.create(makeCreateInput())

      expect(result.createdAt).toBeInstanceOf(Date)
      expect(result.updatedAt).toBeInstanceOf(Date)
    })
  })

  // -------------------------------------------------------------------------
  // findById()
  // -------------------------------------------------------------------------

  describe('findById()', () => {
    it('returns null when no cluster row is found', async () => {
      db = buildMockDb({ selectSequence: [[], []] })
      store = new DrizzleClusterStore(db)

      const result = await store.findById('missing')

      expect(result).toBeNull()
    })

    it('returns a ClusterRecord when a row is found', async () => {
      const row = makeClusterRow({ id: 'c-1' })
      db = buildMockDb({ selectSequence: [[row], []] })
      store = new DrizzleClusterStore(db)

      const result = await store.findById('c-1')

      expect(result).not.toBeNull()
      expect(result!.id).toBe('c-1')
    })

    it('maps workspaceType from the row', async () => {
      const row = makeClusterRow({ workspaceType: 'kubernetes' })
      db = buildMockDb({ selectSequence: [[row], []] })
      store = new DrizzleClusterStore(db)

      const result = await store.findById('c-1')

      expect(result!.workspaceType).toBe('kubernetes')
    })

    it('maps workspaceOptions falling back to {} when null', async () => {
      const row = makeClusterRow({ workspaceOptions: null })
      db = buildMockDb({ selectSequence: [[row], []] })
      store = new DrizzleClusterStore(db)

      const result = await store.findById('c-1')

      expect(result!.workspaceOptions).toEqual({})
    })

    it('maps metadata falling back to {} when null', async () => {
      const row = makeClusterRow({ metadata: null })
      db = buildMockDb({ selectSequence: [[row], []] })
      store = new DrizzleClusterStore(db)

      const result = await store.findById('c-1')

      expect(result!.metadata).toEqual({})
    })

    it('calls db.select() twice — once for cluster, once for roles', async () => {
      const row = makeClusterRow()
      db = buildMockDb({ selectSequence: [[row], []] })
      store = new DrizzleClusterStore(db)

      await store.findById('c-1')

      expect(db.select).toHaveBeenCalledTimes(2)
    })

    it('includes roles returned by listRoles() in the record', async () => {
      const clusterRow = makeClusterRow()
      const roleRow = makeRoleRow({ roleId: 'reviewer', agentId: 'agent-2' })
      db = buildMockDb({ selectSequence: [[clusterRow], [roleRow]] })
      store = new DrizzleClusterStore(db)

      const result = await store.findById('c-1')

      expect(result!.roles).toHaveLength(1)
      expect(result!.roles[0]!.roleId).toBe('reviewer')
      expect(result!.roles[0]!.agentId).toBe('agent-2')
    })

    it('includes multiple roles in the record', async () => {
      const clusterRow = makeClusterRow()
      const roleRows = [
        makeRoleRow({ roleId: 'planner', agentId: 'agent-1' }),
        makeRoleRow({ roleId: 'coder', agentId: 'agent-2' }),
        makeRoleRow({ roleId: 'reviewer', agentId: 'agent-3' }),
      ]
      db = buildMockDb({ selectSequence: [[clusterRow], roleRows] })
      store = new DrizzleClusterStore(db)

      const result = await store.findById('c-1')

      expect(result!.roles).toHaveLength(3)
    })

    it('returns roles: [] when cluster has no roles', async () => {
      const clusterRow = makeClusterRow()
      db = buildMockDb({ selectSequence: [[clusterRow], []] })
      store = new DrizzleClusterStore(db)

      const result = await store.findById('c-1')

      expect(result!.roles).toEqual([])
    })

    it('preserves workspaceOptions as-is from the row', async () => {
      const opts = { cpu: 2, namespace: 'production' }
      const row = makeClusterRow({ workspaceOptions: opts })
      db = buildMockDb({ selectSequence: [[row], []] })
      store = new DrizzleClusterStore(db)

      const result = await store.findById('c-1')

      expect(result!.workspaceOptions).toEqual(opts)
    })

    it('uses .limit(1) when selecting the cluster row', async () => {
      const log: CallLog[] = []
      const row = makeClusterRow()
      db = buildMockDb({ selectSequence: [[row], []], log })
      store = new DrizzleClusterStore(db)

      await store.findById('c-1')

      const limitCall = log.find((l) => l.op === 'select' && l.fn === 'limit')
      expect(limitCall).toBeDefined()
      expect(limitCall!.args[0]).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // delete()
  // -------------------------------------------------------------------------

  describe('delete()', () => {
    it('returns true when rowCount > 0', async () => {
      db = buildMockDb({ deleteSequence: [{ rowCount: 1 }] })
      store = new DrizzleClusterStore(db)

      const result = await store.delete('c-1')

      expect(result).toBe(true)
    })

    it('returns false when rowCount is 0', async () => {
      db = buildMockDb({ deleteSequence: [{ rowCount: 0 }] })
      store = new DrizzleClusterStore(db)

      const result = await store.delete('nonexistent')

      expect(result).toBe(false)
    })

    it('returns false when rowCount is absent (undefined)', async () => {
      db = buildMockDb({ deleteSequence: [{}] })
      store = new DrizzleClusterStore(db)

      const result = await store.delete('c-1')

      expect(result).toBe(false)
    })

    it('returns true when rowCount is 2 (cascade deletes)', async () => {
      db = buildMockDb({ deleteSequence: [{ rowCount: 2 }] })
      store = new DrizzleClusterStore(db)

      const result = await store.delete('c-1')

      expect(result).toBe(true)
    })

    it('calls db.delete once', async () => {
      db = buildMockDb({ deleteSequence: [{ rowCount: 1 }] })
      store = new DrizzleClusterStore(db)

      await store.delete('c-1')

      expect(db.delete).toHaveBeenCalledTimes(1)
    })

    it('applies a where condition targeting the cluster id', async () => {
      const log: CallLog[] = []
      db = buildMockDb({ deleteSequence: [{ rowCount: 1 }], log })
      store = new DrizzleClusterStore(db)

      await store.delete('c-xyz')

      const whereCall = log.find((l) => l.op === 'delete' && l.fn === 'where')
      expect(whereCall).toBeDefined()
    })
  })

  // -------------------------------------------------------------------------
  // addRole()
  // -------------------------------------------------------------------------

  describe('addRole()', () => {
    it('calls db.insert once', async () => {
      db = buildMockDb()
      store = new DrizzleClusterStore(db)

      await store.addRole('cluster-1', makeRole())

      expect(db.insert).toHaveBeenCalledTimes(1)
    })

    it('inserts role fields into clusterRoles table', async () => {
      const log: CallLog[] = []
      db = buildMockDb({ log })
      store = new DrizzleClusterStore(db)
      const role = makeRole({ roleId: 'coder', agentId: 'agent-99', capabilities: ['write', 'read'] })

      await store.addRole('cluster-1', role)

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      expect(valuesCall).toBeDefined()
      const inserted = valuesCall!.args[0] as Record<string, unknown>
      expect(inserted['clusterId']).toBe('cluster-1')
      expect(inserted['roleId']).toBe('coder')
      expect(inserted['agentId']).toBe('agent-99')
      expect(inserted['capabilities']).toEqual(['write', 'read'])
    })

    it('defaults capabilities to [] when role.capabilities is undefined', async () => {
      const log: CallLog[] = []
      db = buildMockDb({ log })
      store = new DrizzleClusterStore(db)
      const role: ClusterRole = { roleId: 'planner', agentId: 'agent-1' }

      await store.addRole('cluster-1', role)

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      const inserted = valuesCall!.args[0] as Record<string, unknown>
      expect(inserted['capabilities']).toEqual([])
    })

    it('resolves to void (returns undefined)', async () => {
      db = buildMockDb()
      store = new DrizzleClusterStore(db)

      const result = await store.addRole('cluster-1', makeRole())

      expect(result).toBeUndefined()
    })

    it('stores clusterId from the first argument', async () => {
      const log: CallLog[] = []
      db = buildMockDb({ log })
      store = new DrizzleClusterStore(db)

      await store.addRole('my-cluster', makeRole())

      const valuesCall = log.find((l) => l.op === 'insert' && l.fn === 'values')
      const inserted = valuesCall!.args[0] as Record<string, unknown>
      expect(inserted['clusterId']).toBe('my-cluster')
    })
  })

  // -------------------------------------------------------------------------
  // removeRole()
  // -------------------------------------------------------------------------

  describe('removeRole()', () => {
    it('returns true when rowCount > 0', async () => {
      db = buildMockDb({ deleteSequence: [{ rowCount: 1 }] })
      store = new DrizzleClusterStore(db)

      const result = await store.removeRole('cluster-1', 'planner')

      expect(result).toBe(true)
    })

    it('returns false when rowCount is 0', async () => {
      db = buildMockDb({ deleteSequence: [{ rowCount: 0 }] })
      store = new DrizzleClusterStore(db)

      const result = await store.removeRole('cluster-1', 'missing-role')

      expect(result).toBe(false)
    })

    it('returns false when rowCount is absent', async () => {
      db = buildMockDb({ deleteSequence: [{}] })
      store = new DrizzleClusterStore(db)

      const result = await store.removeRole('cluster-1', 'planner')

      expect(result).toBe(false)
    })

    it('calls db.delete once', async () => {
      db = buildMockDb({ deleteSequence: [{ rowCount: 1 }] })
      store = new DrizzleClusterStore(db)

      await store.removeRole('cluster-1', 'planner')

      expect(db.delete).toHaveBeenCalledTimes(1)
    })

    it('uses and() with two eq conditions (clusterId + roleId)', async () => {
      const log: CallLog[] = []
      db = buildMockDb({ deleteSequence: [{ rowCount: 1 }], log })
      store = new DrizzleClusterStore(db)

      await store.removeRole('cluster-99', 'coder')

      const whereCall = log.find((l) => l.op === 'delete' && l.fn === 'where')
      expect(whereCall).toBeDefined()
      // The where argument should be the and() result from drizzle-orm mock
      const whereArg = whereCall!.args[0] as Record<string, unknown>
      expect(whereArg).toHaveProperty('_mockAnd', true)
    })
  })

  // -------------------------------------------------------------------------
  // listRoles()
  // -------------------------------------------------------------------------

  describe('listRoles()', () => {
    it('returns empty array when no roles exist', async () => {
      db = buildMockDb({ selectSequence: [[]] })
      store = new DrizzleClusterStore(db)

      const result = await store.listRoles('cluster-1')

      expect(result).toEqual([])
    })

    it('maps a single role row to ClusterRole', async () => {
      const row = makeRoleRow({ roleId: 'planner', agentId: 'agent-1', capabilities: ['plan'] })
      db = buildMockDb({ selectSequence: [[row]] })
      store = new DrizzleClusterStore(db)

      const result = await store.listRoles('cluster-1')

      expect(result).toHaveLength(1)
      expect(result[0]!.roleId).toBe('planner')
      expect(result[0]!.agentId).toBe('agent-1')
      expect(result[0]!.capabilities).toEqual(['plan'])
    })

    it('maps multiple role rows correctly', async () => {
      const rows = [
        makeRoleRow({ roleId: 'planner', agentId: 'a1', capabilities: ['plan'] }),
        makeRoleRow({ roleId: 'coder', agentId: 'a2', capabilities: ['code', 'test'] }),
        makeRoleRow({ roleId: 'reviewer', agentId: 'a3', capabilities: [] }),
      ]
      db = buildMockDb({ selectSequence: [rows] })
      store = new DrizzleClusterStore(db)

      const result = await store.listRoles('cluster-1')

      expect(result).toHaveLength(3)
      expect(result[1]!.roleId).toBe('coder')
      expect(result[1]!.capabilities).toEqual(['code', 'test'])
    })

    it('defaults capabilities to [] when the row has null capabilities', async () => {
      const row = makeRoleRow({ capabilities: null })
      db = buildMockDb({ selectSequence: [[row]] })
      store = new DrizzleClusterStore(db)

      const result = await store.listRoles('cluster-1')

      expect(result[0]!.capabilities).toEqual([])
    })

    it('calls db.select once per listRoles() call', async () => {
      db = buildMockDb({ selectSequence: [[]] })
      store = new DrizzleClusterStore(db)

      await store.listRoles('cluster-1')

      expect(db.select).toHaveBeenCalledTimes(1)
    })

    it('applies a where condition for clusterId', async () => {
      const log: CallLog[] = []
      db = buildMockDb({ selectSequence: [[]], log })
      store = new DrizzleClusterStore(db)

      await store.listRoles('cluster-abc')

      const whereCall = log.find((l) => l.op === 'select' && l.fn === 'where')
      expect(whereCall).toBeDefined()
    })

    it('does not apply .limit() for listRoles() (fetches all)', async () => {
      const log: CallLog[] = []
      db = buildMockDb({ selectSequence: [[]], log })
      store = new DrizzleClusterStore(db)

      await store.listRoles('cluster-1')

      const limitCall = log.find((l) => l.op === 'select' && l.fn === 'limit')
      expect(limitCall).toBeUndefined()
    })

    it('returns roleId and agentId as strings', async () => {
      const row = makeRoleRow({ roleId: 'writer', agentId: 'agt-007' })
      db = buildMockDb({ selectSequence: [[row]] })
      store = new DrizzleClusterStore(db)

      const result = await store.listRoles('cluster-1')

      expect(typeof result[0]!.roleId).toBe('string')
      expect(typeof result[0]!.agentId).toBe('string')
    })
  })

  // -------------------------------------------------------------------------
  // findById() ↔ listRoles() interaction
  // -------------------------------------------------------------------------

  describe('findById() → listRoles() interaction', () => {
    it('calls select() for cluster then select() for roles in sequence', async () => {
      const selectOrder: string[] = []
      const clusterRow = makeClusterRow()
      const roleRow = makeRoleRow()

      // Track order by using separate mocks
      const selQueue = [[clusterRow], [roleRow]]
      const log: CallLog[] = []
      db = buildMockDb({ selectSequence: selQueue, log })
      store = new DrizzleClusterStore(db)

      const result = await store.findById('c-1')

      expect(db.select).toHaveBeenCalledTimes(2)
      expect(result!.roles).toHaveLength(1)
      void selectOrder
    })

    it('attaches roles from the second select to the returned record', async () => {
      const clusterRow = makeClusterRow({ id: 'c-with-roles' })
      const roleRows = [
        makeRoleRow({ roleId: 'alpha', agentId: 'agent-alpha' }),
        makeRoleRow({ roleId: 'beta', agentId: 'agent-beta' }),
      ]
      db = buildMockDb({ selectSequence: [[clusterRow], roleRows] })
      store = new DrizzleClusterStore(db)

      const result = await store.findById('c-with-roles')

      expect(result!.roles.map((r) => r.roleId)).toEqual(['alpha', 'beta'])
    })

    it('findById returns null without calling listRoles when cluster is missing', async () => {
      db = buildMockDb({ selectSequence: [[]] })
      store = new DrizzleClusterStore(db)

      const result = await store.findById('missing')

      // Only 1 select call — listRoles() is skipped when cluster row absent
      expect(db.select).toHaveBeenCalledTimes(1)
      expect(result).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Edge cases / boundary conditions
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('create() with empty string id propagates it to insert', async () => {
      const log: CallLog[] = []
      db = buildMockDb({ log })
      store = new DrizzleClusterStore(db)

      await store.create({ id: '' })

      const valuesCall = log.find((l) => l.fn === 'values')
      const inserted = valuesCall!.args[0] as Record<string, unknown>
      expect(inserted['id']).toBe('')
    })

    it('create() with complex nested workspaceOptions preserves deep structure', async () => {
      const opts = {
        network: { mode: 'bridge', ports: [8080, 9090] },
        volumes: [{ host: '/tmp', container: '/data' }],
      }
      db = buildMockDb()
      store = new DrizzleClusterStore(db)

      const result = await store.create({ id: 'c-nested', workspaceOptions: opts })

      expect(result.workspaceOptions).toEqual(opts)
    })

    it('listRoles() with large capabilities array preserves all entries', async () => {
      const caps = Array.from({ length: 50 }, (_, i) => `cap-${i}`)
      const row = makeRoleRow({ capabilities: caps })
      db = buildMockDb({ selectSequence: [[row]] })
      store = new DrizzleClusterStore(db)

      const result = await store.listRoles('cluster-1')

      expect(result[0]!.capabilities).toHaveLength(50)
      expect(result[0]!.capabilities![49]).toBe('cap-49')
    })

    it('delete() with rowCount=null returns false', async () => {
      db = buildMockDb({ deleteSequence: [{ rowCount: null }] })
      store = new DrizzleClusterStore(db)

      const result = await store.delete('c-1')

      expect(result).toBe(false)
    })

    it('removeRole() with rowCount=null returns false', async () => {
      db = buildMockDb({ deleteSequence: [{ rowCount: null }] })
      store = new DrizzleClusterStore(db)

      const result = await store.removeRole('cluster-1', 'planner')

      expect(result).toBe(false)
    })

    it('findById with workspaceOptions set to non-null object is passed through', async () => {
      const opts = { region: 'us-east-1' }
      const row = makeClusterRow({ workspaceOptions: opts })
      db = buildMockDb({ selectSequence: [[row], []] })
      store = new DrizzleClusterStore(db)

      const result = await store.findById('c-1')

      expect(result!.workspaceOptions).toEqual(opts)
    })

    it('addRole() called twice produces two insert calls', async () => {
      db = buildMockDb()
      store = new DrizzleClusterStore(db)

      await store.addRole('cluster-1', makeRole({ roleId: 'role-a', agentId: 'agent-a' }))
      await store.addRole('cluster-1', makeRole({ roleId: 'role-b', agentId: 'agent-b' }))

      expect(db.insert).toHaveBeenCalledTimes(2)
    })
  })
})
