import { describe, it, expect } from 'vitest'
import type { Table } from 'apache-arrow'

import { FrameBuilder } from '../frame-builder.js'
import { FrameReader } from '../frame-reader.js'
import {
  deserializeFromIPC,
  base64ToIPC,
  ipcToBase64,
  serializeToIPC,
} from '../ipc-serializer.js'
import { MEMORY_FRAME_VERSION } from '../schema.js'
import {
  handleExportMemory,
  handleImportMemory,
  handleMemorySchema,
} from '../mcp-memory-transport.js'
import type {
  ExportMemoryDeps,
  ImportMemoryDeps,
} from '../mcp-memory-transport.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTestTable(count: number): Table {
  const builder = new FrameBuilder()
  for (let i = 0; i < count; i++) {
    builder.add(
      {
        text: `Record ${i}`,
        _temporal: {
          systemCreatedAt: 1700000000000 + i * 1000,
          validFrom: 1700000000000 + i * 1000,
        },
        category: 'test',
        importance: 0.5,
      },
      {
        id: `rec-${i}`,
        namespace: 'decisions',
        key: `key-${i}`,
        scope: { tenant: 't1', project: 'p1' },
      },
    )
  }
  return builder.build()
}

function makeExportDeps(table: Table): ExportMemoryDeps {
  return {
    exportFrame: async (
      _ns: string,
      _scope: Record<string, string>,
      _opts?: { query?: string; limit?: number },
    ) => table,
  }
}

function makeImportDeps(): ImportMemoryDeps & {
  lastImported: {
    ns: string
    scope: Record<string, string>
    table: Table
    strategy: string | undefined
  } | null
} {
  const deps = {
    lastImported: null as {
      ns: string
      scope: Record<string, string>
      table: Table
      strategy: string | undefined
    } | null,
    importFrame: async (
      ns: string,
      scope: Record<string, string>,
      table: Table,
      strategy?: string,
    ) => {
      deps.lastImported = { ns, scope, table, strategy }
      return { imported: table.numRows, skipped: 0, conflicts: 0 }
    },
  }
  return deps
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleExportMemory', () => {
  it('exports in arrow_ipc format with valid base64', async () => {
    const table = buildTestTable(5)
    const deps = makeExportDeps(table)

    const result = await handleExportMemory(
      { namespace: 'decisions', format: 'arrow_ipc', limit: 100 },
      deps,
    )

    expect(result.format).toBe('arrow_ipc')
    expect(result.schema_version).toBe(MEMORY_FRAME_VERSION)
    expect(result.record_count).toBe(5)
    expect(result.namespaces).toContain('decisions')
    expect(result.byte_size).toBeGreaterThan(0)

    // Verify base64 decodes to valid Arrow IPC
    const ipcBytes = base64ToIPC(result.data)
    expect(ipcBytes.byteLength).toBeGreaterThan(0)
    const restored = deserializeFromIPC(ipcBytes)
    expect(restored.numRows).toBe(5)
  })

  it('exports in json format with valid base64', async () => {
    const table = buildTestTable(3)
    const deps = makeExportDeps(table)

    const result = await handleExportMemory(
      { namespace: 'decisions', format: 'json', limit: 100 },
      deps,
    )

    expect(result.format).toBe('json')
    expect(result.record_count).toBe(3)

    // Verify base64 decodes to valid JSON
    const jsonBytes = base64ToIPC(result.data)
    const jsonStr = new TextDecoder().decode(jsonBytes)
    const parsed: unknown = JSON.parse(jsonStr)
    expect(Array.isArray(parsed)).toBe(true)
    expect((parsed as unknown[]).length).toBe(3)
  })

  it('passes scope and query to deps', async () => {
    const table = buildTestTable(1)
    let capturedArgs: {
      ns: string
      scope: Record<string, string>
      opts: { query?: string; limit?: number } | undefined
    } | null = null

    const deps: ExportMemoryDeps = {
      exportFrame: async (ns, scope, opts) => {
        capturedArgs = { ns, scope, opts }
        return table
      },
    }

    await handleExportMemory(
      {
        namespace: 'lessons',
        scope: { tenant: 't1' },
        query: 'search query',
        format: 'arrow_ipc',
        limit: 50,
      },
      deps,
    )

    expect(capturedArgs).not.toBeNull()
    expect(capturedArgs!.ns).toBe('lessons')
    expect(capturedArgs!.scope).toEqual({ tenant: 't1' })
    expect(capturedArgs!.opts?.query).toBe('search query')
    expect(capturedArgs!.opts?.limit).toBe(50)
  })

  it('handles empty table export', async () => {
    const builder = new FrameBuilder()
    const table = builder.build()
    const deps = makeExportDeps(table)

    const result = await handleExportMemory(
      { namespace: 'empty', format: 'arrow_ipc', limit: 100 },
      deps,
    )

    expect(result.record_count).toBe(0)
    expect(result.namespaces).toEqual([])
  })
})

describe('handleImportMemory', () => {
  it('imports Arrow IPC data and reports imported count', async () => {
    const table = buildTestTable(4)
    const ipcBytes = serializeToIPC(table)
    const b64 = ipcToBase64(ipcBytes)
    const deps = makeImportDeps()

    const result = await handleImportMemory(
      {
        data: b64,
        format: 'arrow_ipc',
        namespace: 'decisions',
        merge_strategy: 'upsert',
      },
      deps,
    )

    expect(result.imported).toBe(4)
    expect(result.skipped).toBe(0)
    expect(result.conflicts).toBe(0)
    expect(result.warnings).toEqual([])
    expect(deps.lastImported).not.toBeNull()
    expect(deps.lastImported!.ns).toBe('decisions')
    expect(deps.lastImported!.strategy).toBe('upsert')
  })

  it('imports JSON data', async () => {
    const table = buildTestTable(2)
    const reader = new FrameReader(table)
    const records = reader.toRecords()
    const jsonStr = JSON.stringify(records)
    const b64 = ipcToBase64(new TextEncoder().encode(jsonStr))
    const deps = makeImportDeps()

    const result = await handleImportMemory(
      {
        data: b64,
        format: 'json',
        namespace: 'test-ns',
        merge_strategy: 'append',
      },
      deps,
    )

    expect(result.imported).toBe(2)
    expect(result.warnings).toEqual([])
  })

  it('handles invalid base64 Arrow IPC gracefully', async () => {
    const deps = makeImportDeps()

    const result = await handleImportMemory(
      {
        data: '',
        format: 'arrow_ipc',
        namespace: 'test',
        merge_strategy: 'upsert',
      },
      deps,
    )

    expect(result.imported).toBe(0)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('handles invalid JSON gracefully', async () => {
    const b64 = ipcToBase64(new TextEncoder().encode('not valid json'))
    const deps = makeImportDeps()

    const result = await handleImportMemory(
      {
        data: b64,
        format: 'json',
        namespace: 'test',
        merge_strategy: 'upsert',
      },
      deps,
    )

    expect(result.imported).toBe(0)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('warns on malformed JSON records', async () => {
    const jsonData = JSON.stringify([
      { meta: { id: 'r1', namespace: 'test', key: 'k1' }, value: { text: 'ok' } },
      { bad: 'record' },
    ])
    const b64 = ipcToBase64(new TextEncoder().encode(jsonData))
    const deps = makeImportDeps()

    const result = await handleImportMemory(
      {
        data: b64,
        format: 'json',
        namespace: 'test',
        merge_strategy: 'upsert',
      },
      deps,
    )

    expect(result.imported).toBe(1)
    expect(result.warnings).toContain('Skipped malformed record (missing meta/value)')
  })
})

describe('handleMemorySchema', () => {
  it('returns field list matching schema', () => {
    const result = handleMemorySchema()

    expect(result.schema_version).toBe(MEMORY_FRAME_VERSION)
    expect(result.fields.length).toBeGreaterThan(0)

    // Check a few known fields
    const fieldNames = result.fields.map((f) => f.name)
    expect(fieldNames).toContain('id')
    expect(fieldNames).toContain('namespace')
    expect(fieldNames).toContain('text')
    expect(fieldNames).toContain('system_created_at')
    expect(fieldNames).toContain('decay_strength')
    expect(fieldNames).toContain('is_active')

    // Check field properties
    const idField = result.fields.find((f) => f.name === 'id')
    expect(idField).toBeDefined()
    expect(idField!.nullable).toBe(false)
    expect(idField!.description).toBe('Unique record identifier')

    const textField = result.fields.find((f) => f.name === 'text')
    expect(textField).toBeDefined()
    expect(textField!.nullable).toBe(true)
  })
})
