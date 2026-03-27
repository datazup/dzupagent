import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AgentFileExporter } from '../exporter.js'
import { AgentFileImporter } from '../importer.js'
import { AGENT_FILE_SCHEMA, AGENT_FILE_VERSION } from '../types.js'
import type { AgentFile, AgentFileMemoryRecord } from '../types.js'
import type { MemoryService } from '../../memory-service.js'
import type { MemoryProvenance } from '../../provenance/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RecordStore = Map<string, Map<string, Record<string, unknown>>>

function createMockMemoryService(namespaces: string[]): {
  service: MemoryService
  records: RecordStore
} {
  const records: RecordStore = new Map()
  const nsMap = new Map(namespaces.map(ns => [ns, { name: ns, scopeKeys: ['tenantId'] }]))

  const service = {
    nsMap,
    getNamespaceNames: vi.fn().mockImplementation(() => Array.from(nsMap.keys())),
    put: vi.fn().mockImplementation(
      (ns: string, scope: Record<string, string>, key: string, value: Record<string, unknown>) => {
        const nsKey = `${ns}:${JSON.stringify(scope)}`
        if (!records.has(nsKey)) records.set(nsKey, new Map())
        records.get(nsKey)!.set(key, value)
        return Promise.resolve()
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
    search: vi.fn().mockResolvedValue([]),
    formatForPrompt: vi.fn().mockReturnValue(''),
  } as unknown as MemoryService

  return { service, records }
}

const SCOPE = { tenantId: 't1' }
const AGENT_URI = 'forge://acme/planner'
const AGENT_NAME = 'planner'

function makeProv(agentUri: string, source: string = 'direct'): MemoryProvenance {
  return {
    createdBy: agentUri,
    createdAt: '2026-03-25T00:00:00.000Z',
    source: source as MemoryProvenance['source'],
    confidence: 1.0,
    contentHash: 'abc123',
    lineage: [agentUri],
  }
}

function seedRecord(
  records: RecordStore,
  ns: string,
  scope: Record<string, string>,
  key: string,
  value: Record<string, unknown>,
): void {
  const nsKey = `${ns}:${JSON.stringify(scope)}`
  if (!records.has(nsKey)) records.set(nsKey, new Map())
  records.get(nsKey)!.set(key, value)
}

// ---------------------------------------------------------------------------
// AgentFileExporter
// ---------------------------------------------------------------------------

describe('AgentFileExporter', () => {
  let mock: ReturnType<typeof createMockMemoryService>

  beforeEach(() => {
    mock = createMockMemoryService(['decisions', 'lessons', '__internal'])
    // Seed some records
    seedRecord(mock.records, 'decisions', SCOPE, 'dec-1', {
      text: 'Use PostgreSQL',
      _key: 'dec-1',
      _provenance: makeProv(AGENT_URI),
    })
    seedRecord(mock.records, 'lessons', SCOPE, 'les-1', {
      text: 'Always validate inputs',
      _key: 'les-1',
    })
    seedRecord(mock.records, '__internal', SCOPE, 'int-1', {
      text: 'internal data',
      _key: 'int-1',
    })
  })

  it('creates valid AgentFile with all sections', async () => {
    const exporter = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      agentDescription: 'Plans things',
      capabilities: ['planning', 'analysis'],
      scope: SCOPE,
      prompts: { templates: [{ name: 'greet', content: 'Hello {{name}}', variables: ['name'] }] },
      state: { workingMemory: { step: 3 } },
    })

    const file = await exporter.export()

    expect(file.$schema).toBe(AGENT_FILE_SCHEMA)
    expect(file.version).toBe(AGENT_FILE_VERSION)
    expect(file.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(file.exportedBy).toBe(AGENT_URI)
    expect(file.agent.name).toBe(AGENT_NAME)
    expect(file.agent.description).toBe('Plans things')
    expect(file.agent.capabilities).toEqual(['planning', 'analysis'])
    expect(file.memory.namespaces['decisions']).toBeDefined()
    expect(file.memory.namespaces['lessons']).toBeDefined()
    expect(file.prompts?.templates).toHaveLength(1)
    expect(file.state?.workingMemory).toEqual({ step: 3 })
  })

  it('includes provenance metadata in exported records', async () => {
    const exporter = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })

    const file = await exporter.export()
    const decRecords = file.memory.namespaces['decisions']
    expect(decRecords).toBeDefined()
    expect(decRecords).toHaveLength(1)

    const rec = decRecords![0]!
    expect(rec.provenance).toBeDefined()
    expect(rec.provenance!.createdBy).toBe(AGENT_URI)
    expect(rec.createdAt).toBe('2026-03-25T00:00:00.000Z')
  })

  it('generates SHA-256 signature', async () => {
    const exporter = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })

    const file = await exporter.export({ sign: true })

    expect(file.signature).toBeDefined()
    expect(file.signature).toHaveLength(64) // SHA-256 hex
  })

  it('skips internal namespaces by default', async () => {
    const exporter = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })

    const file = await exporter.export()

    expect(file.memory.namespaces['__internal']).toBeUndefined()
    expect(file.memory.namespaces['decisions']).toBeDefined()
    expect(file.memory.namespaces['lessons']).toBeDefined()
  })

  it('includes internal namespaces when explicitly requested', async () => {
    const exporter = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })

    const file = await exporter.export({ namespaces: ['__internal', 'decisions'] })

    expect(file.memory.namespaces['__internal']).toBeDefined()
    expect(file.memory.namespaces['decisions']).toBeDefined()
    expect(file.memory.namespaces['lessons']).toBeUndefined()
  })

  it('omits signature when sign: false', async () => {
    const exporter = new AgentFileExporter({
      memoryService: mock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })

    const file = await exporter.export({ sign: false })

    expect(file.signature).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AgentFileImporter — validate()
// ---------------------------------------------------------------------------

describe('AgentFileImporter.validate', () => {
  let mock: ReturnType<typeof createMockMemoryService>
  let importer: AgentFileImporter

  beforeEach(() => {
    mock = createMockMemoryService(['decisions', 'lessons'])
    importer = new AgentFileImporter(mock.service, SCOPE)
  })

  function validFile(): AgentFile {
    return {
      $schema: AGENT_FILE_SCHEMA,
      version: AGENT_FILE_VERSION,
      exportedAt: '2026-03-25T00:00:00.000Z',
      exportedBy: AGENT_URI,
      agent: { name: AGENT_NAME },
      memory: { namespaces: {} },
    }
  }

  it('accepts valid file', () => {
    const { valid, errors } = importer.validate(validFile())
    expect(valid).toBe(true)
    expect(errors).toHaveLength(0)
  })

  it('rejects null', () => {
    const { valid, errors } = importer.validate(null)
    expect(valid).toBe(false)
    expect(errors[0]).toContain('non-null object')
  })

  it('rejects missing $schema', () => {
    const file = validFile()
    ;(file as Record<string, unknown>)['$schema'] = 'wrong'
    const { valid, errors } = importer.validate(file)
    expect(valid).toBe(false)
    expect(errors.some(e => e.includes('$schema'))).toBe(true)
  })

  it('rejects missing version', () => {
    const file = validFile()
    ;(file as Record<string, unknown>)['version'] = '2.0.0'
    const { valid, errors } = importer.validate(file)
    expect(valid).toBe(false)
    expect(errors.some(e => e.includes('version'))).toBe(true)
  })

  it('rejects missing exportedAt', () => {
    const file = validFile()
    ;(file as Record<string, unknown>)['exportedAt'] = ''
    const { valid, errors } = importer.validate(file)
    expect(valid).toBe(false)
    expect(errors.some(e => e.includes('exportedAt'))).toBe(true)
  })

  it('rejects missing agent section', () => {
    const file = validFile()
    ;(file as Record<string, unknown>)['agent'] = null
    const { valid, errors } = importer.validate(file)
    expect(valid).toBe(false)
    expect(errors.some(e => e.includes('agent'))).toBe(true)
  })

  it('rejects missing agent.name', () => {
    const file = validFile()
    file.agent = { name: '' }
    const { valid, errors } = importer.validate(file)
    expect(valid).toBe(false)
    expect(errors.some(e => e.includes('agent.name'))).toBe(true)
  })

  it('rejects missing memory section', () => {
    const file = validFile()
    ;(file as Record<string, unknown>)['memory'] = null
    const { valid, errors } = importer.validate(file)
    expect(valid).toBe(false)
    expect(errors.some(e => e.includes('memory'))).toBe(true)
  })

  it('detects tampered signature', () => {
    const file = validFile()
    file.signature = 'tampered-signature-that-wont-match-the-content-sha256x'
    const { valid, errors } = importer.validate(file)
    expect(valid).toBe(false)
    expect(errors.some(e => e.includes('Signature verification failed'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AgentFileImporter — import()
// ---------------------------------------------------------------------------

describe('AgentFileImporter.import', () => {
  let mock: ReturnType<typeof createMockMemoryService>
  let importer: AgentFileImporter

  function makeFile(records: Record<string, AgentFileMemoryRecord[]>): AgentFile {
    return {
      $schema: AGENT_FILE_SCHEMA,
      version: AGENT_FILE_VERSION,
      exportedAt: '2026-03-25T00:00:00.000Z',
      exportedBy: AGENT_URI,
      agent: { name: AGENT_NAME },
      memory: { namespaces: records },
    }
  }

  beforeEach(() => {
    mock = createMockMemoryService(['decisions', 'lessons'])
    importer = new AgentFileImporter(mock.service, SCOPE)
  })

  it('imports records with skip strategy — skips existing keys', async () => {
    // Seed existing record
    seedRecord(mock.records, 'decisions', SCOPE, 'dec-1', { text: 'existing' })

    const file = makeFile({
      decisions: [
        { key: 'dec-1', value: { text: 'new value' } },
        { key: 'dec-2', value: { text: 'brand new' } },
      ],
    })

    const result = await importer.import(file, { conflictStrategy: 'skip' })

    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.failed).toBe(0)

    // dec-1 should still have old value
    const nsKey = `decisions:${JSON.stringify(SCOPE)}`
    expect(mock.records.get(nsKey)!.get('dec-1')!['text']).toBe('existing')
    // dec-2 should be the new value
    expect(mock.records.get(nsKey)!.get('dec-2')!['text']).toBe('brand new')
  })

  it('imports records with overwrite strategy — replaces existing keys', async () => {
    seedRecord(mock.records, 'decisions', SCOPE, 'dec-1', { text: 'existing' })

    const file = makeFile({
      decisions: [
        { key: 'dec-1', value: { text: 'overwritten' } },
      ],
    })

    const result = await importer.import(file, { conflictStrategy: 'overwrite' })

    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(0)

    const nsKey = `decisions:${JSON.stringify(SCOPE)}`
    expect(mock.records.get(nsKey)!.get('dec-1')!['text']).toBe('overwritten')
  })

  it('imports records with merge strategy — deep-merges values', async () => {
    seedRecord(mock.records, 'decisions', SCOPE, 'dec-1', {
      text: 'existing',
      details: { priority: 'high', status: 'open' },
      tags: ['a'],
    })

    const file = makeFile({
      decisions: [
        {
          key: 'dec-1',
          value: {
            text: 'merged',
            details: { status: 'closed', assignee: 'bob' },
            extra: true,
          },
        },
      ],
    })

    const result = await importer.import(file, { conflictStrategy: 'merge' })

    expect(result.imported).toBe(1)
    const nsKey = `decisions:${JSON.stringify(SCOPE)}`
    const merged = mock.records.get(nsKey)!.get('dec-1')!
    // text overwritten by new value
    expect(merged['text']).toBe('merged')
    // details deep-merged
    const details = merged['details'] as Record<string, unknown>
    expect(details['priority']).toBe('high') // kept from existing
    expect(details['status']).toBe('closed') // overwritten by new
    expect(details['assignee']).toBe('bob') // added from new
    // arrays replaced (not merged)
    expect(merged['tags']).toEqual(['a']) // kept from existing since new doesn't have it
    expect(merged['extra']).toBe(true) // added from new
  })

  it('adds source:"imported" to provenance', async () => {
    const prov = makeProv(AGENT_URI, 'direct')
    const file = makeFile({
      decisions: [
        { key: 'dec-1', value: { text: 'imported data' }, provenance: prov },
      ],
    })

    const result = await importer.import(file, { conflictStrategy: 'overwrite' })

    expect(result.imported).toBe(1)
    const nsKey = `decisions:${JSON.stringify(SCOPE)}`
    const written = mock.records.get(nsKey)!.get('dec-1')!
    const writtenProv = written['_provenance'] as Record<string, unknown>
    expect(writtenProv['source']).toBe('imported')
    // Original provenance fields preserved
    expect(writtenProv['createdBy']).toBe(AGENT_URI)
  })

  it('adds minimal provenance marker when record has no provenance', async () => {
    const file = makeFile({
      decisions: [
        { key: 'dec-1', value: { text: 'no prov' } },
      ],
    })

    await importer.import(file, { conflictStrategy: 'overwrite' })

    const nsKey = `decisions:${JSON.stringify(SCOPE)}`
    const written = mock.records.get(nsKey)!.get('dec-1')!
    const writtenProv = written['_provenance'] as Record<string, unknown>
    expect(writtenProv['source']).toBe('imported')
  })

  it('returns correct counts', async () => {
    seedRecord(mock.records, 'decisions', SCOPE, 'dec-1', { text: 'existing' })

    const file = makeFile({
      decisions: [
        { key: 'dec-1', value: { text: 'skip this' } },
        { key: 'dec-2', value: { text: 'import this' } },
        { key: 'dec-3', value: { text: 'import this too' } },
      ],
    })

    const result = await importer.import(file, { conflictStrategy: 'skip' })

    expect(result.imported).toBe(2)
    expect(result.skipped).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('respects namespace filter', async () => {
    const file = makeFile({
      decisions: [
        { key: 'dec-1', value: { text: 'decision' } },
      ],
      lessons: [
        { key: 'les-1', value: { text: 'lesson' } },
      ],
    })

    const result = await importer.import(file, {
      conflictStrategy: 'overwrite',
      namespaces: ['lessons'],
    })

    expect(result.imported).toBe(1)
    const decNsKey = `decisions:${JSON.stringify(SCOPE)}`
    const lesNsKey = `lessons:${JSON.stringify(SCOPE)}`
    expect(mock.records.get(decNsKey)?.get('dec-1')).toBeUndefined()
    expect(mock.records.get(lesNsKey)?.get('les-1')).toBeDefined()
  })

  it('aborts import when verifySignature fails', async () => {
    const file = makeFile({
      decisions: [{ key: 'dec-1', value: { text: 'data' } }],
    })
    file.signature = 'invalid-signature'

    const result = await importer.import(file, {
      conflictStrategy: 'overwrite',
      verifySignature: true,
    })

    expect(result.imported).toBe(0)
    expect(result.warnings.some(w => w.includes('Signature verification failed'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Round-trip: export → import
// ---------------------------------------------------------------------------

describe('Round-trip: export → import', () => {
  it('export then import produces matching data', async () => {
    // Source agent
    const sourceMock = createMockMemoryService(['decisions', 'lessons'])
    seedRecord(sourceMock.records, 'decisions', SCOPE, 'dec-1', {
      text: 'Use PostgreSQL',
      _key: 'dec-1',
      _provenance: makeProv(AGENT_URI),
    })
    seedRecord(sourceMock.records, 'decisions', SCOPE, 'dec-2', {
      text: 'Use Redis for caching',
      _key: 'dec-2',
    })
    seedRecord(sourceMock.records, 'lessons', SCOPE, 'les-1', {
      text: 'Always validate inputs',
      _key: 'les-1',
    })

    // Export
    const exporter = new AgentFileExporter({
      memoryService: sourceMock.service,
      agentName: AGENT_NAME,
      agentUri: AGENT_URI,
      scope: SCOPE,
    })
    const file = await exporter.export({ sign: true })

    // Target agent
    const targetMock = createMockMemoryService(['decisions', 'lessons'])
    const importer = new AgentFileImporter(targetMock.service, SCOPE)

    // Validate
    const { valid } = importer.validate(file)
    expect(valid).toBe(true)

    // Import
    const result = await importer.import(file, {
      conflictStrategy: 'overwrite',
      verifySignature: true,
    })

    expect(result.imported).toBe(3)
    expect(result.failed).toBe(0)

    // Verify data was imported
    const decNsKey = `decisions:${JSON.stringify(SCOPE)}`
    const lesNsKey = `lessons:${JSON.stringify(SCOPE)}`
    expect(targetMock.records.get(decNsKey)!.size).toBe(2)
    expect(targetMock.records.get(lesNsKey)!.size).toBe(1)

    // Verify imported records have correct text
    const dec1 = targetMock.records.get(decNsKey)!.get('dec-1')!
    expect(dec1['text']).toBe('Use PostgreSQL')
    // Verify provenance was marked as imported
    const prov = dec1['_provenance'] as Record<string, unknown>
    expect(prov['source']).toBe('imported')
  })
})
