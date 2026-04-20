/**
 * Extended coverage for AgentFileExporter / AgentFileImporter.
 *
 * The existing agent-file/__tests__/agent-file.test.ts covers basic happy-path
 * scenarios. This file targets:
 *   - Exporter edge cases (empty stores, getNamespaceNames fallback to nsMap,
 *     state-only exports, prompts-only exports, signature determinism)
 *   - Importer validation edge cases (signature when no signature supplied,
 *     deep-merge corner cases, namespace filter excluding all)
 *   - Round-trip variants (signed + filtered, merge strategy)
 *   - Error robustness (memoryService.get throws => skipped silently)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentFileExporter } from '../agent-file/exporter.js'
import { AgentFileImporter } from '../agent-file/importer.js'
import {
  AGENT_FILE_SCHEMA,
  AGENT_FILE_VERSION,
  type AgentFile,
  type AgentFileMemoryRecord,
} from '../agent-file/types.js'
import type { MemoryService } from '../memory-service.js'
import type { MemoryProvenance } from '../provenance/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RecordStore = Map<string, Map<string, Record<string, unknown>>>

function createMock(namespaces: string[], opts?: { useGetNamespaceNames?: boolean }): {
  service: MemoryService
  records: RecordStore
} {
  const records: RecordStore = new Map()
  const nsMap = new Map(namespaces.map(ns => [ns, { name: ns, scopeKeys: ['tenantId'] }]))

  const base: Record<string, unknown> = {
    nsMap,
    put: vi.fn().mockImplementation(
      (
        ns: string,
        scope: Record<string, string>,
        key: string,
        value: Record<string, unknown>,
      ) => {
        const k = `${ns}:${JSON.stringify(scope)}`
        if (!records.has(k)) records.set(k, new Map())
        records.get(k)!.set(key, value)
        return Promise.resolve()
      },
    ),
    get: vi.fn().mockImplementation(
      (ns: string, scope: Record<string, string>, key?: string) => {
        const k = `${ns}:${JSON.stringify(scope)}`
        const map = records.get(k)
        if (!map) return Promise.resolve([])
        if (key) {
          const v = map.get(key)
          return Promise.resolve(v ? [v] : [])
        }
        return Promise.resolve(Array.from(map.values()))
      },
    ),
    search: vi.fn().mockResolvedValue([]),
    formatForPrompt: vi.fn().mockReturnValue(''),
  }

  if (opts?.useGetNamespaceNames !== false) {
    base['getNamespaceNames'] = vi.fn().mockImplementation(() => Array.from(nsMap.keys()))
  }

  return { service: base as unknown as MemoryService, records }
}

const SCOPE = { tenantId: 't1' }
const AGENT_URI = 'forge://acme/planner'
const AGENT_NAME = 'planner'

function makeProv(agent = AGENT_URI, source: MemoryProvenance['source'] = 'direct'): MemoryProvenance {
  return {
    createdBy: agent,
    createdAt: '2026-04-01T12:00:00.000Z',
    source,
    confidence: 0.9,
    contentHash: 'hash-' + agent,
    lineage: [agent],
  }
}

function seed(
  records: RecordStore,
  ns: string,
  scope: Record<string, string>,
  key: string,
  value: Record<string, unknown>,
): void {
  const k = `${ns}:${JSON.stringify(scope)}`
  if (!records.has(k)) records.set(k, new Map())
  records.get(k)!.set(key, value)
}

function validFile(overrides: Partial<AgentFile> = {}): AgentFile {
  return {
    $schema: AGENT_FILE_SCHEMA,
    version: AGENT_FILE_VERSION,
    exportedAt: '2026-04-01T00:00:00.000Z',
    exportedBy: AGENT_URI,
    agent: { name: AGENT_NAME },
    memory: { namespaces: {} },
    ...overrides,
  }
}

// ===========================================================================
// AgentFileExporter — namespace discovery
// ===========================================================================

describe('AgentFileExporter — namespace discovery', () => {
  it('falls back to nsMap when getNamespaceNames is absent', async () => {
    const mock = createMock(['decisions', 'lessons'], { useGetNamespaceNames: false })
    seed(mock.records, 'decisions', SCOPE, 'd1', { _key: 'd1', text: 'A' })

    const exp = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })

    const file = await exp.export()
    expect(Object.keys(file.memory.namespaces)).toContain('decisions')
  })

  it('returns empty memory section when no namespaces exist', async () => {
    const mock = createMock([])
    const exp = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })
    const file = await exp.export()
    expect(file.memory.namespaces).toEqual({})
  })

  it('returns empty memory section when all namespaces are empty', async () => {
    const mock = createMock(['decisions', 'lessons'])
    const exp = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })
    const file = await exp.export()
    // No records seeded => no entries
    expect(file.memory.namespaces).toEqual({})
  })

  it('returns empty namespaces array when nsMap is not a Map and no getNamespaceNames', async () => {
    const svc = {
      put: vi.fn(),
      get: vi.fn().mockResolvedValue([]),
      search: vi.fn(),
      formatForPrompt: vi.fn().mockReturnValue(''),
      // intentionally no nsMap, no getNamespaceNames
    } as unknown as MemoryService
    const exp = new AgentFileExporter({
      memoryService: svc,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })
    const file = await exp.export()
    expect(file.memory.namespaces).toEqual({})
  })
})

// ===========================================================================
// AgentFileExporter — agent identity section
// ===========================================================================

describe('AgentFileExporter — agent identity section', () => {
  it('omits description when not provided', async () => {
    const mock = createMock(['decisions'])
    const exp = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })
    const file = await exp.export()
    expect(file.agent.description).toBeUndefined()
  })

  it('omits capabilities when empty array passed', async () => {
    const mock = createMock(['decisions'])
    const exp = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      capabilities: [],
      scope: SCOPE,
    })
    const file = await exp.export()
    expect(file.agent.capabilities).toBeUndefined()
  })

  it('includes capabilities when non-empty', async () => {
    const mock = createMock(['decisions'])
    const exp = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      capabilities: ['cap1', 'cap2'],
      scope: SCOPE,
    })
    const file = await exp.export()
    expect(file.agent.capabilities).toEqual(['cap1', 'cap2'])
  })
})

// ===========================================================================
// AgentFileExporter — record key derivation
// ===========================================================================

describe('AgentFileExporter — record key derivation', () => {
  it('uses _key when present', async () => {
    const mock = createMock(['decisions'])
    seed(mock.records, 'decisions', SCOPE, 'first', { _key: 'first', text: 'A' })
    seed(mock.records, 'decisions', SCOPE, 'second', { _key: 'second', text: 'B' })

    const exp = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })
    const file = await exp.export()
    const recs = file.memory.namespaces['decisions']!
    expect(recs.map(r => r.key)).toEqual(['first', 'second'])
  })

  it('uses synthetic record-N when _key is missing', async () => {
    const mock = createMock(['decisions'])
    seed(mock.records, 'decisions', SCOPE, 'k1', { text: 'A' })
    seed(mock.records, 'decisions', SCOPE, 'k2', { text: 'B' })

    const exp = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })
    const file = await exp.export()
    const recs = file.memory.namespaces['decisions']!
    expect(recs[0]!.key).toBe('record-0')
    expect(recs[1]!.key).toBe('record-1')
  })

  it('uses synthetic key when _key is non-string', async () => {
    const mock = createMock(['decisions'])
    seed(mock.records, 'decisions', SCOPE, 'k1', { _key: 42, text: 'A' })
    const exp = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })
    const file = await exp.export()
    expect(file.memory.namespaces['decisions']![0]!.key).toBe('record-0')
  })
})

// ===========================================================================
// AgentFileExporter — provenance and createdAt
// ===========================================================================

describe('AgentFileExporter — provenance', () => {
  it('omits provenance and createdAt when record has no provenance metadata', async () => {
    const mock = createMock(['decisions'])
    seed(mock.records, 'decisions', SCOPE, 'k', { _key: 'k', text: 'plain' })
    const exp = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })
    const file = await exp.export()
    const r = file.memory.namespaces['decisions']![0]!
    expect(r.provenance).toBeUndefined()
    expect(r.createdAt).toBeUndefined()
  })

  it('skips invalid provenance (missing required field)', async () => {
    const mock = createMock(['decisions'])
    // _provenance present but invalid (missing createdBy)
    seed(mock.records, 'decisions', SCOPE, 'k', {
      _key: 'k',
      text: 'A',
      _provenance: { createdAt: '2026-04-01T00:00:00.000Z' },
    })
    const exp = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })
    const file = await exp.export()
    const r = file.memory.namespaces['decisions']![0]!
    expect(r.provenance).toBeUndefined()
    expect(r.createdAt).toBeUndefined()
  })

  it('attaches createdAt from provenance.createdAt', async () => {
    const mock = createMock(['decisions'])
    const prov = makeProv(AGENT_URI)
    seed(mock.records, 'decisions', SCOPE, 'k', {
      _key: 'k',
      text: 'A',
      _provenance: prov,
    })
    const exp = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })
    const file = await exp.export()
    const r = file.memory.namespaces['decisions']![0]!
    expect(r.createdAt).toBe(prov.createdAt)
  })
})

// ===========================================================================
// AgentFileExporter — signature determinism
// ===========================================================================

describe('AgentFileExporter — signature', () => {
  it('produces deterministic signature for identical content', async () => {
    const mock1 = createMock(['decisions'])
    seed(mock1.records, 'decisions', SCOPE, 'k', { _key: 'k', text: 'A' })
    const mock2 = createMock(['decisions'])
    seed(mock2.records, 'decisions', SCOPE, 'k', { _key: 'k', text: 'A' })

    const exp1 = new AgentFileExporter({
      memoryService: mock1.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })
    const exp2 = new AgentFileExporter({
      memoryService: mock2.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })

    const f1 = await exp1.export({ sign: true })
    const f2 = await exp2.export({ sign: true })
    // Signatures depend on memory/prompts/state — exportedAt does not affect them
    expect(f1.signature).toBe(f2.signature)
  })

  it('different memory content produces different signatures', async () => {
    const mock1 = createMock(['decisions'])
    seed(mock1.records, 'decisions', SCOPE, 'k', { _key: 'k', text: 'A' })
    const mock2 = createMock(['decisions'])
    seed(mock2.records, 'decisions', SCOPE, 'k', { _key: 'k', text: 'B' })

    const f1 = await new AgentFileExporter({
      memoryService: mock1.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    }).export({ sign: true })

    const f2 = await new AgentFileExporter({
      memoryService: mock2.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    }).export({ sign: true })

    expect(f1.signature).not.toBe(f2.signature)
  })

  it('signing defaults to true when sign option not supplied', async () => {
    const mock = createMock(['decisions'])
    seed(mock.records, 'decisions', SCOPE, 'k', { _key: 'k', text: 'A' })
    const f = await new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    }).export()
    expect(f.signature).toBeDefined()
  })

  it('different prompts content produces different signatures', async () => {
    const mock = createMock(['decisions'])
    seed(mock.records, 'decisions', SCOPE, 'k', { _key: 'k', text: 'A' })

    const a = await new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
      prompts: { templates: [{ name: 't1', content: 'hello' }] },
    }).export({ sign: true })

    const b = await new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
      prompts: { templates: [{ name: 't1', content: 'goodbye' }] },
    }).export({ sign: true })

    expect(a.signature).not.toBe(b.signature)
  })
})

// ===========================================================================
// AgentFileExporter — robustness
// ===========================================================================

describe('AgentFileExporter — robustness', () => {
  it('skips a namespace whose get() throws (non-fatal)', async () => {
    const mock = createMock(['decisions', 'lessons'])
    seed(mock.records, 'lessons', SCOPE, 'l1', { _key: 'l1', text: 'OK' })
    // Make decisions throw
    const original = mock.service.get
    mock.service.get = vi.fn().mockImplementation((ns: string, scope, key) => {
      if (ns === 'decisions') return Promise.reject(new Error('boom'))
      return original(ns, scope, key)
    }) as unknown as typeof mock.service.get

    const exp = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })
    const file = await exp.export()
    expect(file.memory.namespaces['decisions']).toBeUndefined()
    expect(file.memory.namespaces['lessons']).toBeDefined()
  })

  it('exports prompts and state when both provided', async () => {
    const mock = createMock(['decisions'])
    const exp = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
      prompts: { templates: [{ name: 'a', content: 'hi {{n}}', variables: ['n'] }] },
      state: { workingMemory: { x: 1 }, metadata: { version: 'v2' } },
    })
    const file = await exp.export()
    expect(file.prompts?.templates).toHaveLength(1)
    expect(file.state?.workingMemory).toEqual({ x: 1 })
    expect(file.state?.metadata).toEqual({ version: 'v2' })
  })

  it('omits prompts/state when not provided', async () => {
    const mock = createMock(['decisions'])
    const file = await new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    }).export()
    expect(file.prompts).toBeUndefined()
    expect(file.state).toBeUndefined()
  })
})

// ===========================================================================
// AgentFileImporter — validate edge cases
// ===========================================================================

describe('AgentFileImporter.validate — edge cases', () => {
  let mock: ReturnType<typeof createMock>
  let importer: AgentFileImporter

  beforeEach(() => {
    mock = createMock(['decisions', 'lessons'])
    importer = new AgentFileImporter(mock.service, SCOPE)
  })

  it('rejects undefined', () => {
    const r = importer.validate(undefined)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toContain('non-null object')
  })

  it('rejects primitive (string)', () => {
    const r = importer.validate('not an object')
    expect(r.valid).toBe(false)
  })

  it('rejects primitive (number)', () => {
    const r = importer.validate(42)
    expect(r.valid).toBe(false)
  })

  it('rejects array (typeof === object)', () => {
    // arrays pass `typeof obj === 'object'` so we should still get version errors
    const r = importer.validate([])
    expect(r.valid).toBe(false)
    expect(r.errors.length).toBeGreaterThan(0)
  })

  it('rejects when agent.name is non-string', () => {
    const f = validFile()
    ;(f.agent as Record<string, unknown>)['name'] = 42
    const r = importer.validate(f)
    expect(r.valid).toBe(false)
    expect(r.errors.some(e => e.includes('agent.name'))).toBe(true)
  })

  it('rejects when memory.namespaces is missing', () => {
    const f = validFile()
    ;(f as Record<string, unknown>)['memory'] = {}
    const r = importer.validate(f)
    expect(r.valid).toBe(false)
    expect(r.errors.some(e => e.includes('memory.namespaces'))).toBe(true)
  })

  it('rejects when exportedBy is empty string', () => {
    const f = validFile()
    ;(f as Record<string, unknown>)['exportedBy'] = ''
    const r = importer.validate(f)
    expect(r.valid).toBe(false)
    expect(r.errors.some(e => e.includes('exportedBy'))).toBe(true)
  })

  it('rejects when exportedAt is not a string', () => {
    const f = validFile()
    ;(f as Record<string, unknown>)['exportedAt'] = 12345
    const r = importer.validate(f)
    expect(r.valid).toBe(false)
    expect(r.errors.some(e => e.includes('exportedAt'))).toBe(true)
  })

  it('accepts file with no signature (validation skipped)', () => {
    const f = validFile()
    delete (f as Record<string, unknown>)['signature']
    const r = importer.validate(f)
    expect(r.valid).toBe(true)
  })

  it('accumulates multiple errors (does not short-circuit)', () => {
    const r = importer.validate({})
    expect(r.valid).toBe(false)
    // Should report several issues at once
    expect(r.errors.length).toBeGreaterThanOrEqual(3)
  })
})

// ===========================================================================
// AgentFileImporter — import edge cases
// ===========================================================================

describe('AgentFileImporter.import — edge cases', () => {
  let mock: ReturnType<typeof createMock>
  let importer: AgentFileImporter

  beforeEach(() => {
    mock = createMock(['decisions', 'lessons'])
    importer = new AgentFileImporter(mock.service, SCOPE)
  })

  function makeFile(records: Record<string, AgentFileMemoryRecord[]>): AgentFile {
    return validFile({ memory: { namespaces: records } })
  }

  it('default conflict strategy is "skip"', async () => {
    seed(mock.records, 'decisions', SCOPE, 'k', { text: 'existing' })
    const file = makeFile({
      decisions: [{ key: 'k', value: { text: 'incoming' } }],
    })
    const r = await importer.import(file) // no strategy
    expect(r.skipped).toBe(1)
    expect(r.imported).toBe(0)
    const stored = mock.records.get(`decisions:${JSON.stringify(SCOPE)}`)!.get('k')!
    expect(stored['text']).toBe('existing')
  })

  it('returns 0/0/0 result when memory has no namespaces', async () => {
    const file = makeFile({})
    const r = await importer.import(file, { conflictStrategy: 'overwrite' })
    expect(r.imported).toBe(0)
    expect(r.skipped).toBe(0)
    expect(r.failed).toBe(0)
    expect(r.warnings).toHaveLength(0)
  })

  it('namespace filter excluding all imports nothing', async () => {
    const file = makeFile({
      decisions: [{ key: 'k', value: { text: 'v' } }],
    })
    const r = await importer.import(file, {
      conflictStrategy: 'overwrite',
      namespaces: ['nonexistent'],
    })
    expect(r.imported).toBe(0)
  })

  it('counts a single failure when memoryService.put throws', async () => {
    const file = makeFile({
      decisions: [{ key: 'k1', value: { text: 'v' } }],
    })
    mock.service.put = vi.fn().mockRejectedValue(new Error('write failed')) as unknown as MemoryService['put']
    const r = await importer.import(file, { conflictStrategy: 'overwrite' })
    expect(r.failed).toBe(1)
    expect(r.warnings.some(w => w.includes('k1'))).toBe(true)
  })

  it('counts a failure when memoryService.get throws', async () => {
    const file = makeFile({
      decisions: [{ key: 'k1', value: { text: 'v' } }],
    })
    mock.service.get = vi.fn().mockRejectedValue(new Error('read failed')) as unknown as MemoryService['get']
    const r = await importer.import(file, { conflictStrategy: 'overwrite' })
    expect(r.failed).toBe(1)
  })

  it('merge strategy creates new record when no existing', async () => {
    const file = makeFile({
      decisions: [{ key: 'new', value: { text: 'fresh', detail: { x: 1 } } }],
    })
    const r = await importer.import(file, { conflictStrategy: 'merge' })
    expect(r.imported).toBe(1)
    const stored = mock.records.get(`decisions:${JSON.stringify(SCOPE)}`)!.get('new')!
    expect(stored['text']).toBe('fresh')
    expect(stored['detail']).toEqual({ x: 1 })
  })

  it('merge with array values replaces array (not merges)', async () => {
    seed(mock.records, 'decisions', SCOPE, 'k', { tags: ['old1', 'old2'] })
    const file = makeFile({
      decisions: [{ key: 'k', value: { tags: ['new1'] } }],
    })
    await importer.import(file, { conflictStrategy: 'merge' })
    const stored = mock.records.get(`decisions:${JSON.stringify(SCOPE)}`)!.get('k')!
    expect(stored['tags']).toEqual(['new1'])
  })

  it('merge handles null values in source as overwrite', async () => {
    seed(mock.records, 'decisions', SCOPE, 'k', {
      text: 'old',
      nested: { keep: 'this', drop: 'that' },
    })
    const file = makeFile({
      decisions: [{ key: 'k', value: { text: null, nested: null } }],
    })
    await importer.import(file, { conflictStrategy: 'merge' })
    const stored = mock.records.get(`decisions:${JSON.stringify(SCOPE)}`)!.get('k')!
    expect(stored['text']).toBeNull()
    expect(stored['nested']).toBeNull()
  })

  it('imports multiple namespaces independently', async () => {
    const file = makeFile({
      decisions: [{ key: 'd1', value: { text: 'd' } }],
      lessons: [
        { key: 'l1', value: { text: 'l1' } },
        { key: 'l2', value: { text: 'l2' } },
      ],
    })
    const r = await importer.import(file, { conflictStrategy: 'overwrite' })
    expect(r.imported).toBe(3)
  })

  it('handles empty namespace records arrays', async () => {
    const file = makeFile({ decisions: [], lessons: [] })
    const r = await importer.import(file, { conflictStrategy: 'overwrite' })
    expect(r.imported).toBe(0)
    expect(r.skipped).toBe(0)
    expect(r.failed).toBe(0)
  })

  it('verifySignature=false (default) does not abort on missing/bad signature', async () => {
    const file = makeFile({
      decisions: [{ key: 'k', value: { text: 'v' } }],
    })
    file.signature = 'totally-bogus'
    const r = await importer.import(file, { conflictStrategy: 'overwrite' })
    // Default verifySignature is false, so we proceed normally
    expect(r.imported).toBe(1)
  })

  it('verifySignature with no signature on file does not abort', async () => {
    const file = makeFile({
      decisions: [{ key: 'k', value: { text: 'v' } }],
    })
    // No signature on file
    const r = await importer.import(file, {
      conflictStrategy: 'overwrite',
      verifySignature: true,
    })
    expect(r.imported).toBe(1) // signature absent, so verification step skipped
  })

  it('preserves provenance fields beyond source when re-marking as imported', async () => {
    const prov = makeProv(AGENT_URI, 'derived')
    const file = makeFile({
      decisions: [{ key: 'k', value: { text: 'v' }, provenance: prov }],
    })
    await importer.import(file, { conflictStrategy: 'overwrite' })
    const stored = mock.records.get(`decisions:${JSON.stringify(SCOPE)}`)!.get('k')!
    const sp = stored['_provenance'] as Record<string, unknown>
    expect(sp['source']).toBe('imported')
    expect(sp['createdBy']).toBe(prov.createdBy)
    expect(sp['createdAt']).toBe(prov.createdAt)
    expect(sp['confidence']).toBe(prov.confidence)
    expect(sp['contentHash']).toBe(prov.contentHash)
    expect(sp['lineage']).toEqual(prov.lineage)
  })
})

// ===========================================================================
// AgentFileImporter — combined namespace+strategy
// ===========================================================================

describe('AgentFileImporter — combined behaviors', () => {
  let mock: ReturnType<typeof createMock>
  let importer: AgentFileImporter

  beforeEach(() => {
    mock = createMock(['decisions', 'lessons'])
    importer = new AgentFileImporter(mock.service, SCOPE)
  })

  it('namespace filter + overwrite', async () => {
    seed(mock.records, 'decisions', SCOPE, 'd1', { text: 'old-d' })
    seed(mock.records, 'lessons', SCOPE, 'l1', { text: 'old-l' })
    const file = validFile({
      memory: {
        namespaces: {
          decisions: [{ key: 'd1', value: { text: 'new-d' } }],
          lessons: [{ key: 'l1', value: { text: 'new-l' } }],
        },
      },
    })
    const r = await importer.import(file, {
      conflictStrategy: 'overwrite',
      namespaces: ['lessons'],
    })
    expect(r.imported).toBe(1)
    expect(
      mock.records.get(`decisions:${JSON.stringify(SCOPE)}`)!.get('d1')!['text'],
    ).toBe('old-d')
    expect(
      mock.records.get(`lessons:${JSON.stringify(SCOPE)}`)!.get('l1')!['text'],
    ).toBe('new-l')
  })

  it('mixed conflict outcomes within one import', async () => {
    seed(mock.records, 'decisions', SCOPE, 'a', { text: 'existing-a' })
    const file = validFile({
      memory: {
        namespaces: {
          decisions: [
            { key: 'a', value: { text: 'incoming-a' } },
            { key: 'b', value: { text: 'incoming-b' } },
            { key: 'c', value: { text: 'incoming-c' } },
          ],
        },
      },
    })
    const r = await importer.import(file, { conflictStrategy: 'skip' })
    expect(r.imported).toBe(2)
    expect(r.skipped).toBe(1)
    expect(r.failed).toBe(0)
  })
})

// ===========================================================================
// Round-trip variants
// ===========================================================================

describe('Round-trip — variants', () => {
  it('round-trip with state and prompts preserves all sections', async () => {
    const src = createMock(['decisions'])
    seed(src.records, 'decisions', SCOPE, 'd1', {
      _key: 'd1',
      text: 'X',
      _provenance: makeProv(),
    })

    const file = await new AgentFileExporter({
      memoryService: src.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
      prompts: { templates: [{ name: 'g', content: 'go {{x}}', variables: ['x'] }] },
      state: { workingMemory: { active: true } },
    }).export({ sign: true })

    expect(file.prompts?.templates).toHaveLength(1)
    expect(file.state?.workingMemory).toEqual({ active: true })

    const dst = createMock(['decisions'])
    const importer = new AgentFileImporter(dst.service, SCOPE)
    const v = importer.validate(file)
    expect(v.valid).toBe(true)

    const r = await importer.import(file, {
      conflictStrategy: 'overwrite',
      verifySignature: true,
    })
    expect(r.imported).toBe(1)
    expect(r.warnings).toHaveLength(0)
  })

  it('round-trip with merge strategy preserves provenance', async () => {
    const src = createMock(['decisions'])
    seed(src.records, 'decisions', SCOPE, 'd1', {
      _key: 'd1',
      text: 'X',
      _provenance: makeProv(),
      detail: { a: 1 },
    })

    const file = await new AgentFileExporter({
      memoryService: src.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    }).export({ sign: true })

    const dst = createMock(['decisions'])
    seed(dst.records, 'decisions', SCOPE, 'd1', {
      text: 'pre-existing',
      detail: { b: 2 },
    })

    const importer = new AgentFileImporter(dst.service, SCOPE)
    const r = await importer.import(file, { conflictStrategy: 'merge' })
    expect(r.imported).toBe(1)
    const merged = dst.records.get(`decisions:${JSON.stringify(SCOPE)}`)!.get('d1')!
    const detail = merged['detail'] as Record<string, unknown>
    // both nested keys preserved
    expect(detail['a']).toBe(1)
    expect(detail['b']).toBe(2)
    const prov = merged['_provenance'] as Record<string, unknown>
    expect(prov['source']).toBe('imported')
  })

  it('round-trip with explicit namespace filter at export omits other namespaces from file', async () => {
    const src = createMock(['decisions', 'lessons'])
    seed(src.records, 'decisions', SCOPE, 'd1', { _key: 'd1', text: 'D' })
    seed(src.records, 'lessons', SCOPE, 'l1', { _key: 'l1', text: 'L' })

    const file = await new AgentFileExporter({
      memoryService: src.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    }).export({ namespaces: ['decisions'] })

    expect(file.memory.namespaces['decisions']).toBeDefined()
    expect(file.memory.namespaces['lessons']).toBeUndefined()
  })
})
