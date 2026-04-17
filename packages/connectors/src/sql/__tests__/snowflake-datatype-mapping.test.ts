/**
 * Snowflake data type mapping exhaustive tests — covers all branches
 * in the mapDataType switch statement.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SQLConnectionConfig } from '../types.js'

// ---------------------------------------------------------------------------
// Mock snowflake-sdk
// ---------------------------------------------------------------------------

const mockExecute = vi.fn()
const mockConnect = vi.fn()
const mockDestroy = vi.fn()

const mockCreateConnection = vi.fn(() => ({
  connect: mockConnect,
  execute: mockExecute,
  destroy: mockDestroy,
}))

const mockConfigure = vi.fn()

const mockSnowflakeSDK = {
  createConnection: mockCreateConnection,
  configure: mockConfigure,
}

const mockRuntimeRequire = vi.fn((specifier: string) => {
  if (specifier === 'snowflake-sdk') {
    return mockSnowflakeSDK
  }
  throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' })
}) as unknown as NodeRequire

mockRuntimeRequire.resolve = vi.fn((specifier: string) => {
  if (specifier === 'snowflake-sdk') return '/fake/path/snowflake-sdk'
  throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' })
}) as unknown as NodeRequire['resolve']

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => mockRuntimeRequire),
}))

vi.mock('snowflake-sdk', () => ({
  default: mockSnowflakeSDK,
  createConnection: mockCreateConnection,
  configure: mockConfigure,
}))

const baseConfig: SQLConnectionConfig = {
  host: 'myaccount.snowflakecomputing.com',
  port: 443,
  database: 'MY_DB',
  username: 'testuser',
  password: 'testpass',
  ssl: true,
  account: 'myaccount',
  warehouse: 'MY_WH',
  role: 'MY_ROLE',
}

const { SnowflakeConnector } = await import('../adapters/snowflake.js')

function setupConnection(queryResults: Array<{ err?: Error; rows?: unknown[] }>): void {
  mockConnect.mockImplementation(
    (cb: (err: Error | null, conn: unknown) => void) => {
      cb(null, {
        execute: mockExecute,
        destroy: mockDestroy,
        connect: mockConnect,
      })
    },
  )

  let callIdx = 0
  mockExecute.mockImplementation(
    (opts: { sqlText: string; complete: (err: Error | null, stmt: unknown, rows: unknown[]) => void }) => {
      const entry = queryResults[callIdx++]
      if (entry?.err) {
        opts.complete(entry.err, null, [])
      } else {
        opts.complete(null, null, entry?.rows ?? [])
      }
    },
  )
}

describe('SnowflakeConnector — exhaustive data type mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function getColumnDataType(inputType: string): Promise<string> {
    setupConnection([
      { rows: [{ TABLE_NAME: 'T', TABLE_TYPE: 'BASE TABLE', COMMENT: null }] },
      { rows: [
        { COLUMN_NAME: 'COL', DATA_TYPE: inputType, IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, ORDINAL_POSITION: 1, CHARACTER_MAXIMUM_LENGTH: null, COMMENT: null },
      ] },
      { rows: [] },
      { rows: [{ ROW_COUNT: 0 }] },
    ])

    const connector = new SnowflakeConnector(baseConfig)
    const schema = await connector.discoverSchema({ sampleValueLimit: 0 })
    return schema.tables[0]!.columns[0]!.dataType
  }

  // Numeric types
  it('maps NUMBER to NUMBER', async () => {
    expect(await getColumnDataType('NUMBER')).toBe('NUMBER')
  })

  it('maps DECIMAL to NUMERIC', async () => {
    expect(await getColumnDataType('DECIMAL')).toBe('NUMERIC')
  })

  it('maps NUMERIC to NUMERIC', async () => {
    expect(await getColumnDataType('NUMERIC')).toBe('NUMERIC')
  })

  it('maps INT to INT', async () => {
    expect(await getColumnDataType('INT')).toBe('INT')
  })

  it('maps INTEGER to INTEGER', async () => {
    expect(await getColumnDataType('INTEGER')).toBe('INTEGER')
  })

  it('maps BIGINT to BIGINT', async () => {
    expect(await getColumnDataType('BIGINT')).toBe('BIGINT')
  })

  it('maps SMALLINT to SMALLINT', async () => {
    expect(await getColumnDataType('SMALLINT')).toBe('SMALLINT')
  })

  it('maps TINYINT to TINYINT', async () => {
    expect(await getColumnDataType('TINYINT')).toBe('TINYINT')
  })

  it('maps BYTEINT to BYTEINT', async () => {
    expect(await getColumnDataType('BYTEINT')).toBe('BYTEINT')
  })

  // Float types
  it('maps FLOAT4 to FLOAT', async () => {
    expect(await getColumnDataType('FLOAT4')).toBe('FLOAT')
  })

  it('maps FLOAT8 to FLOAT', async () => {
    expect(await getColumnDataType('FLOAT8')).toBe('FLOAT')
  })

  it('maps DOUBLE to FLOAT', async () => {
    expect(await getColumnDataType('DOUBLE')).toBe('FLOAT')
  })

  it('maps REAL to FLOAT', async () => {
    expect(await getColumnDataType('REAL')).toBe('FLOAT')
  })

  // String types
  it('maps CHAR to VARCHAR', async () => {
    expect(await getColumnDataType('CHAR')).toBe('VARCHAR')
  })

  it('maps CHARACTER to VARCHAR', async () => {
    expect(await getColumnDataType('CHARACTER')).toBe('VARCHAR')
  })

  // Binary types
  it('maps BINARY to BINARY', async () => {
    expect(await getColumnDataType('BINARY')).toBe('BINARY')
  })

  it('maps VARBINARY to BINARY', async () => {
    expect(await getColumnDataType('VARBINARY')).toBe('BINARY')
  })

  // Date/time types
  it('maps DATE to DATE', async () => {
    expect(await getColumnDataType('DATE')).toBe('DATE')
  })

  it('maps DATETIME to TIMESTAMP_NTZ', async () => {
    expect(await getColumnDataType('DATETIME')).toBe('TIMESTAMP_NTZ')
  })

  it('maps TIMESTAMP_LTZ to TIMESTAMP_LTZ', async () => {
    expect(await getColumnDataType('TIMESTAMP_LTZ')).toBe('TIMESTAMP_LTZ')
  })

  it('maps TIMESTAMP_TZ to TIMESTAMP_TZ', async () => {
    expect(await getColumnDataType('TIMESTAMP_TZ')).toBe('TIMESTAMP_TZ')
  })

  it('maps TIME to TIME', async () => {
    expect(await getColumnDataType('TIME')).toBe('TIME')
  })

  // Semi-structured types
  it('maps OBJECT to OBJECT', async () => {
    expect(await getColumnDataType('OBJECT')).toBe('OBJECT')
  })

  it('maps ARRAY to ARRAY', async () => {
    expect(await getColumnDataType('ARRAY')).toBe('ARRAY')
  })

  // Geospatial types
  it('maps GEOMETRY to GEOMETRY', async () => {
    expect(await getColumnDataType('GEOMETRY')).toBe('GEOMETRY')
  })
})
