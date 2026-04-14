import { describe, it, expect, vi } from 'vitest'
import { type Table } from 'apache-arrow'
import {
  FrameBuilder,
  FrameReader,
  handleExportMemory,
  handleImportMemory,
  handleMemorySchema,
  base64ToIPC,
  ipcToBase64,
  serializeToIPC,
} from '../index.js'
import type { ExportMemoryDeps, ImportMemoryDeps } from '../index.js'

function buildTable(): Table {
  const builder = new FrameBuilder()

  builder.add(
    {
      text: 'Remember the parser design',
      _temporal: {
        systemCreatedAt: 1700000000000,
        validFrom: 1700000000000,
      },
      _decay: { strength: 0.7, halfLifeMs: 86_400_000, accessCount: 3 },
      _provenance: { createdBy: 'agent-a', source: 'integration-test' },
      category: 'decision',
      importance: 0.9,
      customField: 'payload',
    },
    {
      id: 'rec-1',
      namespace: 'decisions',
      key: 'parser-design',
      scope: { tenant: 'tenant-1', session: 'session-1' },
    },
  )

  builder.add(
    {
      text: 'Use the SQL connector as the source of truth',
      _temporal: {
        systemCreatedAt: 1700000001000,
        validFrom: 1700000001000,
      },
      category: 'note',
    },
    {
      id: 'rec-2',
      namespace: 'notes',
      key: 'sql-connector',
    },
  )

  return builder.build()
}

describe('memory-ipc integration', () => {
  it('round-trips a populated frame through IPC and reconstructs payload fields', () => {
    const table = buildTable()

    const ipcBytes = serializeToIPC(table)
    expect(ipcBytes.length).toBeGreaterThan(0)

    const base64 = ipcToBase64(ipcBytes)
    expect(base64.length).toBeGreaterThan(0)

    const restored = FrameReader.fromIPC(base64ToIPC(base64))
    expect(restored.rowCount).toBe(2)
    expect(restored.namespaces).toEqual(expect.arrayContaining(['decisions', 'notes']))

    const records = restored.toRecords()
    expect(records[0]?.meta.id).toBe('rec-1')
    expect(records[0]?.value.text).toBe('Remember the parser design')
    expect(records[0]?.value._provenance?.source).toBe('integration-test')
    expect(records[0]?.value.customField).toBe('payload')
    expect(records[1]?.meta.namespace).toBe('notes')
  })

  it('exports and imports Arrow IPC through the transport helpers', async () => {
    const table = buildTable()
    const exportedTable = FrameReader.fromIPC(serializeToIPC(table)).getTable()
    const importSpy = vi.fn()

    const exportDeps: ExportMemoryDeps = {
      exportFrame: async () => exportedTable,
    }

    const exportResult = await handleExportMemory(
      {
        namespace: 'decisions',
        format: 'arrow_ipc',
        limit: 10,
      },
      exportDeps,
    )

    expect(exportResult.schema_version).toBeDefined()
    expect(exportResult.record_count).toBe(2)

    const importDeps: ImportMemoryDeps = {
      importFrame: async (namespace, scope, inputTable, strategy) => {
        importSpy(namespace, scope, inputTable.numRows, strategy)
        return { imported: inputTable.numRows, skipped: 0, conflicts: 0 }
      },
    }

    const importResult = await handleImportMemory(
      {
        data: exportResult.data,
        format: 'arrow_ipc',
        namespace: 'decisions',
        merge_strategy: 'upsert',
      },
      importDeps,
    )

    expect(importResult.imported).toBe(2)
    expect(importResult.warnings).toEqual([])
    expect(importSpy).toHaveBeenCalledWith(
      'decisions',
      {},
      2,
      'upsert',
    )
  })

  it('describes the schema consistently', () => {
    const schema = handleMemorySchema()

    expect(schema.fields.length).toBeGreaterThan(0)
    expect(schema.schema_version).toBeDefined()
    expect(schema.fields.map((field) => field.name)).toEqual(
      expect.arrayContaining(['id', 'namespace', 'text', 'is_active']),
    )
  })
})
