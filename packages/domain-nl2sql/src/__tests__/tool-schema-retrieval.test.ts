import { describe, it, expect, vi } from 'vitest'
import { createSchemaRetrievalTool } from '../tools/tool-schema-retrieval.js'
import type { NL2SQLToolkitConfig, TableSchema } from '../types/index.js'

const usersTable: TableSchema = {
  tableName: 'users',
  schemaName: 'public',
  columns: [
    {
      columnName: 'id',
      dataType: 'integer',
      isNullable: false,
      isPrimaryKey: true,
      defaultValue: null,
      description: null,
      maxLength: null,
    },
    {
      columnName: 'email',
      dataType: 'text',
      isNullable: false,
      isPrimaryKey: false,
      defaultValue: null,
      description: 'user email',
      maxLength: null,
    },
  ],
  foreignKeys: [],
  rowCountEstimate: 1000,
  description: 'application users',
  sampleValues: {},
}

function createConfig(overrides: Partial<NL2SQLToolkitConfig> = {}): NL2SQLToolkitConfig {
  return {
    chatModel: {} as NL2SQLToolkitConfig['chatModel'],
    vectorStore: {
      provider: 'test',
      search: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1, provider: 'test' }),
      ...(overrides.vectorStore ?? {}),
    },
    sqlConnector: {
      getDialect: () => 'postgresql',
      executeQuery: vi.fn(),
      discoverSchema: vi.fn().mockResolvedValue({
        dialect: 'postgresql',
        schemaName: 'public',
        tables: [usersTable],
        discoveredAt: new Date('2026-03-29T00:00:00.000Z'),
      }),
      generateDDL: vi.fn(),
      destroy: vi.fn(),
      ...(overrides.sqlConnector ?? {}),
    },
    tenantId: 'tenant-a',
    dataSourceId: 'source-1',
    workspaceId: 'workspace-9',
    dialect: 'postgresql',
    ...overrides,
  }
}

describe('createSchemaRetrievalTool', () => {
  it('retrieves SQL examples when embedding provider is configured', async () => {
    const search = vi.fn().mockResolvedValue([
      {
        id: 'example-1',
        score: 0.98,
        metadata: {
          question: 'How many users do we have?',
          sql: 'SELECT count(*) FROM public.users;',
          explanation: 'Counts all users',
        },
      },
    ])

    const config = createConfig({
      embeddingProvider: {
        embedQuery: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
        embed: vi.fn(),
      },
      vectorStore: {
        provider: 'test',
        collectionExists: vi.fn().mockResolvedValue(true),
        search,
        upsert: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1, provider: 'test' }),
      } as NL2SQLToolkitConfig['vectorStore'],
    })

    const tool = createSchemaRetrievalTool(config)
    const output = await tool.invoke({ query: 'count users', topK: 5 })
    const parsed = JSON.parse(String(output))

    expect(search).toHaveBeenCalledWith(
      'nl2sql_sql_examples',
      expect.objectContaining({
        limit: 5,
        vector: [0.1, 0.2, 0.3],
      }),
    )
    expect(parsed.examples).toEqual([
      {
        question: 'How many users do we have?',
        sql: 'SELECT count(*) FROM public.users;',
        explanation: 'Counts all users',
        score: 0.98,
      },
    ])
  })

  it('falls back to empty examples when embedding provider is not configured', async () => {
    const search = vi.fn()
    const config = createConfig({
      vectorStore: {
        provider: 'test',
        collectionExists: vi.fn().mockResolvedValue(true),
        search,
        upsert: vi.fn(),
        healthCheck: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1, provider: 'test' }),
      } as NL2SQLToolkitConfig['vectorStore'],
      embeddingProvider: undefined,
    })

    const tool = createSchemaRetrievalTool(config)
    const output = await tool.invoke({ query: 'count users' })
    const parsed = JSON.parse(String(output))

    expect(search).not.toHaveBeenCalled()
    expect(parsed.examples).toEqual([])
  })
})
