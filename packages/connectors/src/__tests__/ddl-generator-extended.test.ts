/**
 * Extended DDL generator tests — covers edge cases for schema name handling,
 * foreign key lines, auto-increment detection, composite primary keys,
 * column descriptions, and dialect-specific generator branches.
 */
import { describe, it, expect } from 'vitest'
import { generateDDL } from '../sql/ddl-generator.js'
import type { TableSchema, ColumnInfo, ForeignKey, SQLDialect } from '../sql/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeColumn(overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    columnName: 'id',
    dataType: 'INTEGER',
    isNullable: false,
    isPrimaryKey: false,
    defaultValue: null,
    description: null,
    sampleValues: [],
    ...overrides,
  }
}

function makeFK(overrides: Partial<ForeignKey> = {}): ForeignKey {
  return {
    constraintName: 'fk_user',
    columnName: 'user_id',
    referencedTable: 'users',
    referencedColumn: 'id',
    referencedSchema: null,
    ...overrides,
  }
}

function makeTable(overrides: Partial<TableSchema> = {}): TableSchema {
  return {
    tableName: 'orders',
    schemaName: 'public',
    columns: [makeColumn()],
    foreignKeys: [],
    rowCountEstimate: null,
    description: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL DDL
// ---------------------------------------------------------------------------

describe('generateDDL — PostgreSQL', () => {
  it('generates basic CREATE TABLE', () => {
    const ddl = generateDDL(makeTable(), 'postgresql')
    expect(ddl).toContain('CREATE TABLE "public"."orders"')
    expect(ddl).toContain('"id" INTEGER NOT NULL')
  })

  it('includes single-column PRIMARY KEY inline', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ isPrimaryKey: true })],
    }), 'postgresql')
    expect(ddl).toContain('PRIMARY KEY')
  })

  it('generates composite PRIMARY KEY as separate line', () => {
    const ddl = generateDDL(makeTable({
      columns: [
        makeColumn({ columnName: 'a', isPrimaryKey: true }),
        makeColumn({ columnName: 'b', isPrimaryKey: true }),
      ],
    }), 'postgresql')
    expect(ddl).toContain('PRIMARY KEY ("a", "b")')
  })

  it('includes DEFAULT clause', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ defaultValue: 'now()' })],
    }), 'postgresql')
    expect(ddl).toContain('DEFAULT now()')
  })

  it('includes column description as comment', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ description: 'Primary key' })],
    }), 'postgresql')
    expect(ddl).toContain('-- Primary key')
  })

  it('handles nullable columns without NOT NULL', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ isNullable: true })],
    }), 'postgresql')
    expect(ddl).not.toContain('NOT NULL')
  })

  it('includes foreign key constraints', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ columnName: 'user_id' })],
      foreignKeys: [makeFK()],
    }), 'postgresql')
    expect(ddl).toContain('CONSTRAINT "fk_user"')
    expect(ddl).toContain('FOREIGN KEY ("user_id")')
    expect(ddl).toContain('REFERENCES "users" ("id")')
  })

  it('includes referenced schema in FK when present', () => {
    const ddl = generateDDL(makeTable({
      foreignKeys: [makeFK({ referencedSchema: 'auth' })],
    }), 'postgresql')
    expect(ddl).toContain('"auth"."users"')
  })

  it('quotes identifiers with double quotes in column names', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ columnName: 'column"with"quotes' })],
    }), 'postgresql')
    expect(ddl).toContain('"column""with""quotes"')
  })
})

// ---------------------------------------------------------------------------
// MySQL DDL
// ---------------------------------------------------------------------------

describe('generateDDL — MySQL', () => {
  it('uses backtick quoting', () => {
    const ddl = generateDDL(makeTable(), 'mysql')
    expect(ddl).toContain('`orders`')
    expect(ddl).toContain('`id`')
  })

  it('adds PRIMARY KEY as separate line', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ isPrimaryKey: true })],
    }), 'mysql')
    expect(ddl).toContain('PRIMARY KEY (`id`)')
  })

  it('adds AUTO_INCREMENT for integer PK without default', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ isPrimaryKey: true, dataType: 'INT' })],
    }), 'mysql')
    expect(ddl).toContain('AUTO_INCREMENT')
  })

  it('adds AUTO_INCREMENT for serial PK with nextval default', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ isPrimaryKey: true, dataType: 'serial', defaultValue: "nextval('id_seq')" })],
    }), 'mysql')
    expect(ddl).toContain('AUTO_INCREMENT')
  })

  it('does not add AUTO_INCREMENT for non-PK integer', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ dataType: 'INT', isPrimaryKey: false })],
    }), 'mysql')
    expect(ddl).not.toContain('AUTO_INCREMENT')
  })

  it('does not add AUTO_INCREMENT for non-integer PK', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ dataType: 'VARCHAR(255)', isPrimaryKey: true })],
    }), 'mysql')
    expect(ddl).not.toContain('AUTO_INCREMENT')
  })

  it('includes foreign key with schema reference', () => {
    const ddl = generateDDL(makeTable({
      foreignKeys: [makeFK({ referencedSchema: 'auth' })],
    }), 'mysql')
    expect(ddl).toContain('`auth`.`users`')
  })
})

// ---------------------------------------------------------------------------
// ClickHouse DDL
// ---------------------------------------------------------------------------

describe('generateDDL — ClickHouse', () => {
  it('includes ENGINE and ORDER BY', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ isPrimaryKey: true })],
    }), 'clickhouse')
    expect(ddl).toContain('ENGINE = MergeTree()')
    expect(ddl).toContain('ORDER BY (`id`)')
  })

  it('uses ORDER BY tuple() when no PK columns', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ isPrimaryKey: false })],
    }), 'clickhouse')
    expect(ddl).toContain('ORDER BY tuple()')
  })

  it('includes schema name when present', () => {
    const ddl = generateDDL(makeTable({ schemaName: 'analytics' }), 'clickhouse')
    expect(ddl).toContain('`analytics`.`orders`')
  })

  it('omits schema name when empty', () => {
    const ddl = generateDDL(makeTable({ schemaName: '' }), 'clickhouse')
    expect(ddl).toContain('`orders`')
    expect(ddl).not.toContain('``.`orders`')
  })

  it('does not include NOT NULL (ClickHouse uses Nullable type)', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ isNullable: false })],
    }), 'clickhouse')
    expect(ddl).not.toContain('NOT NULL')
  })
})

// ---------------------------------------------------------------------------
// Snowflake DDL
// ---------------------------------------------------------------------------

describe('generateDDL — Snowflake', () => {
  it('uses double-quote quoting', () => {
    const ddl = generateDDL(makeTable(), 'snowflake')
    expect(ddl).toContain('"public"."orders"')
  })

  it('includes PK as separate line', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ isPrimaryKey: true })],
    }), 'snowflake')
    expect(ddl).toContain('PRIMARY KEY ("id")')
  })

  it('includes schema name when present', () => {
    const ddl = generateDDL(makeTable({ schemaName: 'raw' }), 'snowflake')
    expect(ddl).toContain('"raw"."orders"')
  })

  it('omits schema when empty', () => {
    const ddl = generateDDL(makeTable({ schemaName: '' }), 'snowflake')
    expect(ddl).toContain('"orders"')
    expect(ddl).not.toContain('""."orders"')
  })
})

// ---------------------------------------------------------------------------
// BigQuery DDL
// ---------------------------------------------------------------------------

describe('generateDDL — BigQuery', () => {
  it('uses backtick quoting for table name', () => {
    const ddl = generateDDL(makeTable(), 'bigquery')
    expect(ddl).toContain('`public`.`orders`')
  })

  it('omits schema when empty', () => {
    const ddl = generateDDL(makeTable({ schemaName: '' }), 'bigquery')
    expect(ddl).toContain('`orders`')
    expect(ddl).not.toContain('``.`orders`')
  })

  it('does not include PRIMARY KEY constraint', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ isPrimaryKey: true })],
    }), 'bigquery')
    expect(ddl).not.toContain('PRIMARY KEY')
  })
})

// ---------------------------------------------------------------------------
// Generic / SQLite / SQLServer DDL
// ---------------------------------------------------------------------------

describe('generateDDL — generic dialects', () => {
  const genericDialects: SQLDialect[] = ['sqlite', 'sqlserver', 'generic']

  for (const dialect of genericDialects) {
    describe(`dialect: ${dialect}`, () => {
      it('generates valid CREATE TABLE', () => {
        const ddl = generateDDL(makeTable(), dialect)
        expect(ddl).toContain('CREATE TABLE')
        expect(ddl).toContain('"id" INTEGER NOT NULL')
      })

      it('handles composite PK', () => {
        const ddl = generateDDL(makeTable({
          columns: [
            makeColumn({ columnName: 'a', isPrimaryKey: true }),
            makeColumn({ columnName: 'b', isPrimaryKey: true }),
          ],
        }), dialect)
        expect(ddl).toContain('PRIMARY KEY ("a", "b")')
      })

      it('omits schema when empty', () => {
        const ddl = generateDDL(makeTable({ schemaName: '' }), dialect)
        expect(ddl).toContain('"orders"')
        expect(ddl).not.toContain('""."orders"')
      })
    })
  }
})

// ---------------------------------------------------------------------------
// DuckDB DDL (uses PostgreSQL generator)
// ---------------------------------------------------------------------------

describe('generateDDL — DuckDB', () => {
  it('uses PostgreSQL-style DDL', () => {
    const ddl = generateDDL(makeTable(), 'duckdb')
    expect(ddl).toContain('"public"."orders"')
    expect(ddl).toContain('"id" INTEGER NOT NULL')
  })
})

// ---------------------------------------------------------------------------
// Column description handling
// ---------------------------------------------------------------------------

describe('column descriptions', () => {
  it('strips newlines from description comments', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ description: 'line1\nline2\rline3' })],
    }), 'postgresql')
    expect(ddl).toContain('-- line1 line2 line3')
  })

  it('skips comment for null description', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ description: null })],
    }), 'postgresql')
    expect(ddl).not.toContain('--')
  })

  it('skips comment for whitespace-only description', () => {
    const ddl = generateDDL(makeTable({
      columns: [makeColumn({ description: '   ' })],
    }), 'postgresql')
    expect(ddl).not.toContain('--')
  })
})
