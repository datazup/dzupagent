import { describe, expect, it } from 'vitest'

type JsonPayload = Record<string, string | number | boolean | null | string[] | Record<string, unknown>>

interface PortableMemory {
  id: string
  namespace: string
  payload: JsonPayload
  tags?: string[]
  createdAt: string
  updatedAt: string
  metadata?: Record<string, unknown>
}

interface MemoryDump {
  version: 1
  encoding: 'utf-8-json'
  exportedAt: string
  records: PortableMemory[]
}

type ImportStrategy = 'overwrite' | 'merge-newest' | 'skip-existing'

function memory(
  id: string,
  namespace: string,
  updatedAt: string,
  extras: Partial<PortableMemory> = {},
): PortableMemory {
  return {
    id,
    namespace,
    payload: { text: `${namespace}:${id}`, score: id.length },
    tags: ['core'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    ...extras,
  }
}

function exportMemories(
  records: PortableMemory[],
  filters: {
    namespaces?: string[]
    tags?: string[]
    from?: string
    to?: string
  } = {},
): string {
  const selected = records.filter(record => {
    if (filters.namespaces && !filters.namespaces.includes(record.namespace)) return false
    if (filters.tags && !filters.tags.some(tag => record.tags?.includes(tag))) return false
    if (filters.from && record.updatedAt < filters.from) return false
    if (filters.to && record.updatedAt > filters.to) return false
    return true
  })

  return JSON.stringify({
    version: 1,
    encoding: 'utf-8-json',
    exportedAt: '2026-06-26T10:00:00.000Z',
    records: selected.map(record => JSON.parse(JSON.stringify(record)) as PortableMemory),
  } satisfies MemoryDump)
}

function parseDump(json: string): MemoryDump {
  const dump = JSON.parse(json) as MemoryDump

  if (dump.encoding !== 'utf-8-json') {
    throw new Error('Unsupported memory dump encoding')
  }

  for (const record of dump.records) {
    if (!record.id || !record.payload || typeof record.payload !== 'object') {
      throw new Error('Memory id and payload are required')
    }
  }

  return dump
}

function importMemories(
  existing: PortableMemory[],
  json: string,
  strategy: ImportStrategy,
): PortableMemory[] {
  const merged = new Map(existing.map(record => [record.id, clone(record)]))

  for (const incoming of parseDump(json).records) {
    const current = merged.get(incoming.id)

    if (!current || strategy === 'overwrite') {
      merged.set(incoming.id, clone(incoming))
      continue
    }

    if (strategy === 'skip-existing') {
      continue
    }

    if (incoming.updatedAt > current.updatedAt) {
      merged.set(incoming.id, {
        ...current,
        ...incoming,
        payload: { ...current.payload, ...incoming.payload },
        metadata: { ...current.metadata, ...incoming.metadata },
      })
    }
  }

  return Array.from(merged.values())
}

function roundTrip(records: PortableMemory[], strategy: ImportStrategy = 'overwrite'): PortableMemory[] {
  return importMemories([], exportMemories(records), strategy)
}

function clone(record: PortableMemory): PortableMemory {
  return JSON.parse(JSON.stringify(record)) as PortableMemory
}

const fixtures = [
  memory('alpha', 'decisions', '2026-01-02T00:00:00.000Z', {
    tags: ['core', 'policy'],
    payload: { text: 'approve plan', priority: 3 },
  }),
  memory('beta', 'lessons', '2026-01-04T00:00:00.000Z', {
    tags: ['core', 'learning'],
    payload: { text: 'prefer focused tests', durable: true },
  }),
  memory('gamma', 'observations', '2026-01-06T00:00:00.000Z', {
    tags: ['telemetry'],
    payload: { text: 'validation passed', count: 1 },
  }),
  memory('delta', 'decisions', '2026-01-08T00:00:00.000Z', {
    tags: ['archive'],
    payload: { text: 'older decision', stale: false },
  }),
]

describe('memory export/import JSON dump contract', () => {
  it.each([
    ['uses the declared utf-8 JSON encoding', (dump: MemoryDump) => dump.encoding],
    ['uses a numeric version marker', (dump: MemoryDump) => dump.version],
    ['includes an export timestamp', (dump: MemoryDump) => dump.exportedAt],
    ['serializes every supplied record by default', (dump: MemoryDump) => dump.records.length],
    ['preserves record ids', (dump: MemoryDump) => dump.records.map(record => record.id).join(',')],
    ['preserves namespaces', (dump: MemoryDump) => dump.records.map(record => record.namespace).join(',')],
    ['preserves JSON-safe payload values', (dump: MemoryDump) => dump.records[0]?.payload.text],
    ['preserves tag arrays', (dump: MemoryDump) => dump.records[1]?.tags?.includes('learning')],
    ['keeps dates as ISO strings', (dump: MemoryDump) => typeof dump.records[2]?.updatedAt],
    ['round-trips through JSON.parse without mutation', (dump: MemoryDump) => JSON.stringify(dump) === exportMemories(fixtures)],
  ])('%s', (_label, read) => {
    expect(read(parseDump(exportMemories(fixtures)))).toBeTruthy()
  })
})

describe('memory export filters', () => {
  it.each([
    ['includes only requested decisions namespace', { namespaces: ['decisions'] }, ['alpha', 'delta']],
    ['excludes lessons when decisions namespace is requested', { namespaces: ['decisions'] }, ['beta']],
    ['includes only requested lessons namespace', { namespaces: ['lessons'] }, ['beta']],
    ['excludes decisions when lessons namespace is requested', { namespaces: ['lessons'] }, ['alpha', 'delta']],
    ['includes core-tagged records', { tags: ['core'] }, ['alpha', 'beta']],
    ['excludes telemetry when core tag is requested', { tags: ['core'] }, ['gamma']],
    ['includes telemetry-tagged records', { tags: ['telemetry'] }, ['gamma']],
    ['excludes archive when telemetry tag is requested', { tags: ['telemetry'] }, ['delta']],
    ['includes records after lower date bound', { from: '2026-01-05T00:00:00.000Z' }, ['gamma', 'delta']],
    ['excludes records before lower date bound', { from: '2026-01-05T00:00:00.000Z' }, ['alpha', 'beta']],
    ['includes records before upper date bound', { to: '2026-01-05T00:00:00.000Z' }, ['alpha', 'beta']],
    ['excludes records after upper date bound', { to: '2026-01-05T00:00:00.000Z' }, ['gamma', 'delta']],
    ['combines namespace and tag filters', { namespaces: ['decisions'], tags: ['policy'] }, ['alpha']],
    ['excludes same-namespace records without requested tag', { namespaces: ['decisions'], tags: ['policy'] }, ['delta']],
    ['combines namespace and date filters', { namespaces: ['decisions'], from: '2026-01-07T00:00:00.000Z' }, ['delta']],
    ['excludes out-of-range records from requested namespace', { namespaces: ['decisions'], from: '2026-01-07T00:00:00.000Z' }, ['alpha']],
    ['treats missing optional filters as full export', {}, ['alpha', 'beta', 'gamma', 'delta']],
    ['returns an empty dump when all filters miss', { namespaces: ['missing'], tags: ['absent'] }, []],
  ])('%s', (_label, filters, expectedIds) => {
    const ids = parseDump(exportMemories(fixtures, filters)).records.map(record => record.id)

    if (expectedIds.length === 0) {
      expect(ids).toEqual([])
    } else if (_label.startsWith('excludes')) {
      expect(ids).not.toEqual(expect.arrayContaining(expectedIds))
    } else {
      expect(ids).toEqual(expect.arrayContaining(expectedIds))
    }
  })
})

describe('memory import overwrite strategy', () => {
  it.each([
    ['replaces an existing payload value', { text: 'new' }, 'new'],
    ['replaces an existing namespace', { text: 'new' }, 'imported'],
    ['replaces an existing tag set', { text: 'new' }, 'incoming'],
    ['accepts an older incoming record when overwrite is explicit', { text: 'old' }, '2026-01-01T00:00:00.000Z'],
    ['imports a record that did not exist', { text: 'new' }, 'added'],
    ['preserves imported metadata fields', { text: 'new' }, 'external'],
    ['preserves imported nested payload objects', { nested: { ok: true } }, true],
    ['does not retain replaced payload fields', { text: 'new' }, undefined],
    ['leaves unrelated existing records present', { text: 'new' }, 'other'],
    ['keeps the import result JSON-safe', { text: 'new' }, 'string'],
  ])('%s', (_label, payload, expected) => {
    const existing = [
      memory('same', 'local', '2026-01-09T00:00:00.000Z', { payload: { text: 'old', stale: true }, tags: ['local'] }),
      memory('other', 'local', '2026-01-09T00:00:00.000Z'),
    ]
    const incoming = [
      memory('same', 'imported', '2026-01-01T00:00:00.000Z', {
        payload,
        tags: ['incoming'],
        metadata: { source: 'external' },
      }),
      memory('added', 'imported', '2026-01-10T00:00:00.000Z', { payload: { text: 'added' } }),
    ]
    const result = importMemories(existing, exportMemories(incoming), 'overwrite')
    const same = result.find(record => record.id === 'same')

    const probes: Record<string, unknown> = {
      new: same?.payload.text,
      imported: same?.namespace,
      incoming: same?.tags?.[0],
      '2026-01-01T00:00:00.000Z': same?.updatedAt,
      added: result.find(record => record.id === 'added')?.payload.text,
      external: same?.metadata?.source,
      true: (same?.payload.nested as Record<string, unknown> | undefined)?.ok,
      undefined: same?.payload.stale,
      other: result.find(record => record.id === 'other')?.id,
      string: typeof JSON.stringify(result),
    }

    expect(probes[String(expected)]).toBe(expected)
  })
})

describe('memory import merge-newest strategy', () => {
  it.each([
    ['applies a newer imported payload', '2026-01-10T00:00:00.000Z', 'new'],
    ['applies newer imported metadata', '2026-01-10T00:00:00.000Z', 'remote'],
    ['retains existing payload fields not present in newer import', '2026-01-10T00:00:00.000Z', true],
    ['updates the timestamp to the newer import timestamp', '2026-01-10T00:00:00.000Z', '2026-01-10T00:00:00.000Z'],
    ['keeps existing record when imported timestamp is older', '2026-01-01T00:00:00.000Z', 'old'],
    ['keeps newer local metadata when imported timestamp is older', '2026-01-01T00:00:00.000Z', 'local'],
    ['does not regress timestamp when imported timestamp is older', '2026-01-01T00:00:00.000Z', '2026-01-09T00:00:00.000Z'],
    ['imports missing records regardless of timestamp', '2026-01-01T00:00:00.000Z', 'fresh'],
    ['preserves unrelated records during newest merge', '2026-01-10T00:00:00.000Z', 'unrelated'],
    ['merges JSON-safe nested payload data from newer import', '2026-01-10T00:00:00.000Z', 'remote-nested'],
    ['keeps local nested payload data when import is older', '2026-01-01T00:00:00.000Z', 'local-nested'],
    ['handles equal timestamps without overwriting existing record', '2026-01-09T00:00:00.000Z', 'old'],
  ])('%s', (_label, incomingUpdatedAt, expected) => {
    const existing = [
      memory('same', 'local', '2026-01-09T00:00:00.000Z', {
        payload: { text: 'old', localOnly: true, nested: { source: 'local-nested' } },
        metadata: { source: 'local' },
      }),
      memory('unrelated', 'local', '2026-01-09T00:00:00.000Z'),
    ]
    const incoming = [
      memory('same', 'local', incomingUpdatedAt, {
        payload: { text: 'new', nested: { source: 'remote-nested' } },
        metadata: { source: 'remote' },
      }),
      memory('fresh', 'remote', '2026-01-01T00:00:00.000Z', { payload: { text: 'fresh' } }),
    ]
    const result = importMemories(existing, exportMemories(incoming), 'merge-newest')
    const same = result.find(record => record.id === 'same')

    const probes: Record<string, unknown> = {
      new: same?.payload.text,
      remote: same?.metadata?.source,
      true: same?.payload.localOnly,
      '2026-01-10T00:00:00.000Z': same?.updatedAt,
      old: same?.payload.text,
      local: same?.metadata?.source,
      '2026-01-09T00:00:00.000Z': same?.updatedAt,
      fresh: result.find(record => record.id === 'fresh')?.payload.text,
      unrelated: result.find(record => record.id === 'unrelated')?.id,
      'remote-nested': (same?.payload.nested as Record<string, unknown> | undefined)?.source,
      'local-nested': (same?.payload.nested as Record<string, unknown> | undefined)?.source,
    }

    expect(probes[String(expected)]).toBe(expected)
  })
})

describe('memory import skip-existing strategy', () => {
  it.each([
    ['does not overwrite an existing newer memory', '2026-01-10T00:00:00.000Z', 'local'],
    ['does not overwrite an existing older memory', '2026-01-01T00:00:00.000Z', 'local'],
    ['does not change existing tags', '2026-01-10T00:00:00.000Z', 'local-tag'],
    ['does not change existing metadata', '2026-01-10T00:00:00.000Z', 'local-meta'],
    ['still imports a missing memory', '2026-01-10T00:00:00.000Z', 'new-id'],
    ['keeps unrelated records present', '2026-01-10T00:00:00.000Z', 'keep'],
    ['keeps existing timestamp stable', '2026-01-10T00:00:00.000Z', '2026-01-05T00:00:00.000Z'],
    ['does not copy incoming payload fields onto skipped records', '2026-01-10T00:00:00.000Z', undefined],
  ])('%s', (_label, incomingUpdatedAt, expected) => {
    const existing = [
      memory('same', 'local', '2026-01-05T00:00:00.000Z', {
        payload: { text: 'local' },
        tags: ['local-tag'],
        metadata: { marker: 'local-meta' },
      }),
      memory('keep', 'local', '2026-01-05T00:00:00.000Z'),
    ]
    const incoming = [
      memory('same', 'remote', incomingUpdatedAt, {
        payload: { text: 'remote', incomingOnly: true },
        tags: ['remote-tag'],
        metadata: { marker: 'remote-meta' },
      }),
      memory('new-id', 'remote', incomingUpdatedAt, { payload: { text: 'new-id' } }),
    ]
    const result = importMemories(existing, exportMemories(incoming), 'skip-existing')
    const same = result.find(record => record.id === 'same')

    const probes: Record<string, unknown> = {
      local: same?.payload.text,
      'local-tag': same?.tags?.[0],
      'local-meta': same?.metadata?.marker,
      'new-id': result.find(record => record.id === 'new-id')?.id,
      keep: result.find(record => record.id === 'keep')?.id,
      '2026-01-05T00:00:00.000Z': same?.updatedAt,
      undefined: same?.payload.incomingOnly,
    }

    expect(probes[String(expected)]).toBe(expected)
  })
})

describe('memory export/import round trips', () => {
  it.each([
    ['preserves ids across a full round trip', (records: PortableMemory[]) => records.map(record => record.id).join(',')],
    ['preserves payload text across a full round trip', (records: PortableMemory[]) => records[0]?.payload.text],
    ['preserves namespace values across a full round trip', (records: PortableMemory[]) => records[1]?.namespace],
    ['preserves tags across a full round trip', (records: PortableMemory[]) => records[2]?.tags?.[0]],
    ['preserves created timestamps across a full round trip', (records: PortableMemory[]) => records[3]?.createdAt],
    ['preserves unsupported metadata while keeping known fields', (records: PortableMemory[]) => records[0]?.metadata?.unsupported],
    ['preserves required known fields when unsupported metadata is present', (records: PortableMemory[]) => records[0]?.payload.text],
  ])('%s', (_label, read) => {
    const source = fixtures.map((record, index) => ({
      ...record,
      metadata: { unsupported: `kept-${index}` },
    }))
    const result = roundTrip(source)

    expect(read(result)).toBe(read(source))
  })
})
