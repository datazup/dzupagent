import { describe, it, expect } from 'vitest'
import { generateDDL } from '../ddl-generator.js'
import type { TableSchema, ColumnInfo, ForeignKey, SQLDialect } from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeColumn(overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    columnName: 'id',
    dataType: 'integer',
    isNullable: false,
    isPrimaryKey: true,
    defaultValue: null,
    description: null,
    maxLength: null,
    ...overrides,
  }
}

function makeTable(overrides: Partial<TableSchema> = {}): TableSchema {
  return {
    tableName: 'users',
    schemaName: 'public',
    columns: [
      makeColumn(),
      makeColumn({
        columnName: 'name',
        dataType: 'varchar',
        isNullable: true,
        isPrimaryKey: false,
      }),
    ],
    foreignKeys: [],
    rowCountEstimate: 100,
    description: null,
    sampleValues: {},
    ...overrides,
  }
}

function makeForeignKey(overrides: Partial<ForeignKey> = {}): ForeignKey {
  return {
    constraintName: 'fk_orders_user_id',
    columnName: 'user_id',
    referencedTable: 'users',
    referencedColumn: 'id',
    referencedSchema: 'public',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL DDL
// ---------------------------------------------------------------------------

describe('generateDDL — postgresql', () => {
  it('should generate CREATE TABLE with schema-qualified name', () => {
    const ddl = generateDDL(makeTable(), 'postgresql')
    expect(ddl).toContain('CREATE TABLE "public"."users"')
  })

  it('should include NOT NULL for non-nullable columns', () => {
    const ddl = generateDDL(makeTable(), 'postgresql')
    expect(ddl).toContain('"id" integer NOT NULL')
  })

  it('should omit NOT NULL for nullable columns', () => {
    const ddl = generateDDL(makeTable(), 'postgresql')
    expect(ddl).toMatch(/"name" varchar(?! NOT NULL)/)
  })

  it('should include PRIMARY KEY for single PK column', () => {
    const ddl = generateDDL(makeTable(), 'postgresql')
    expect(ddl).toContain('PRIMARY KEY')
  })

  it('should generate composite PRIMARY KEY for multiple PK columns', () => {
    const table = makeTable({
      columns: [
        makeColumn({ columnName: 'a', dataType: 'int' }),
        makeColumn({ columnName: 'b', dataType: 'int' }),
      ],
    })
    const ddl = generateDDL(table, 'postgresql')
    expect(ddl).toContain('PRIMARY KEY ("a", "b")')
  })

  it('should include DEFAULT clause', () => {
    const table = makeTable({
      columns: [
        makeColumn({ defaultValue: "nextval('users_id_seq')" }),
      ],
    })
    const ddl = generateDDL(table, 'postgresql')
    expect(ddl).toContain("DEFAULT nextval('users_id_seq')")
  })

  it('should include column descriptions as comments', () => {
    const table = makeTable({
      columns: [
        makeColumn({ description: 'Primary key identifier' }),
      ],
    })
    const ddl = generateDDL(table, 'postgresql')
    expect(ddl).toContain('-- Primary key identifier')
  })

  it('should include foreign key constraints', () => {
    const table = makeTable({
      foreignKeys: [makeForeignKey()],
    })
    const ddl = generateDDL(table, 'postgresql')
    expect(ddl).toContain('CONSTRAINT "fk_orders_user_id" FOREIGN KEY')
    expect(ddl).toContain('REFERENCES "public"."users"')
  })

  it('should end with a semicolon', () => {
    const ddl = generateDDL(makeTable(), 'postgresql')
    expect(ddl.trimEnd()).toMatch(/;$/)
  })

  it('should escape double quotes in identifiers', () => {
    const table = makeTable({
      tableName: 'my"table',
      columns: [makeColumn({ columnName: 'col"name', isPrimaryKey: false })],
    })
    const ddl = generateDDL(table, 'postgresql')
    expect(ddl).toContain('"my""table"')
    expect(ddl).toContain('"col""name"')
  })
})

// ---------------------------------------------------------------------------
// MySQL DDL
// ---------------------------------------------------------------------------

describe('generateDDL — mysql', () => {
  it('should use backtick quoting', () => {
    const ddl = generateDDL(makeTable(), 'mysql')
    expect(ddl).toContain('`users`')
    expect(ddl).toContain('`id`')
  })

  it('should not use schema-qualified table name', () => {
    const ddl = generateDDL(makeTable(), 'mysql')
    // MySQL DDL uses just the table name, not schema.table
    expect(ddl).toMatch(/CREATE TABLE `users`/)
  })

  it('should include AUTO_INCREMENT for integer PK', () => {
    const table = makeTable({
      columns: [
        makeColumn({ dataType: 'int', defaultValue: null }),
      ],
    })
    const ddl = generateDDL(table, 'mysql')
    expect(ddl).toContain('AUTO_INCREMENT')
  })

  it('should include PRIMARY KEY line for PK columns', () => {
    const ddl = generateDDL(makeTable(), 'mysql')
    expect(ddl).toContain('PRIMARY KEY (`id`)')
  })

  it('should include foreign key constraints with backtick quoting', () => {
    const table = makeTable({
      foreignKeys: [makeForeignKey()],
    })
    const ddl = generateDDL(table, 'mysql')
    expect(ddl).toContain('CONSTRAINT `fk_orders_user_id` FOREIGN KEY')
  })
})

// ---------------------------------------------------------------------------
// ClickHouse DDL
// ---------------------------------------------------------------------------

describe('generateDDL — clickhouse', () => {
  it('should include ENGINE = MergeTree()', () => {
    const ddl = generateDDL(makeTable(), 'clickhouse')
    expect(ddl).toContain('ENGINE = MergeTree()')
  })

  it('should include ORDER BY with PK columns', () => {
    const ddl = generateDDL(makeTable(), 'clickhouse')
    expect(ddl).toContain('ORDER BY (`id`)')
  })

  it('should use ORDER BY tuple() when no PK', () => {
    const table = makeTable({
      columns: [
        makeColumn({ isPrimaryKey: false, columnName: 'value', dataType: 'String' }),
      ],
    })
    const ddl = generateDDL(table, 'clickhouse')
    expect(ddl).toContain('ORDER BY tuple()')
  })

  it('should include DEFAULT for columns with defaults', () => {
    const table = makeTable({
      columns: [
        makeColumn({ columnName: 'ts', dataType: 'DateTime', isPrimaryKey: false, defaultValue: 'now()' }),
      ],
    })
    const ddl = generateDDL(table, 'clickhouse')
    expect(ddl).toContain('DEFAULT now()')
  })
})

// ---------------------------------------------------------------------------
// Snowflake DDL
// ---------------------------------------------------------------------------

describe('generateDDL — snowflake', () => {
  it('should use double-quote identifiers', () => {
    const ddl = generateDDL(makeTable(), 'snowflake')
    expect(ddl).toContain('"public"."users"')
    expect(ddl).toContain('"id"')
  })

  it('should include PRIMARY KEY for PK columns', () => {
    const table = makeTable({
      columns: [
        makeColumn({ columnName: 'id', dataType: 'NUMBER' }),
        makeColumn({ columnName: 'name', dataType: 'VARCHAR', isPrimaryKey: false, isNullable: true }),
      ],
    })
    const ddl = generateDDL(table, 'snowflake')
    expect(ddl).toContain('PRIMARY KEY ("id")')
  })
})

// ---------------------------------------------------------------------------
// BigQuery DDL
// ---------------------------------------------------------------------------

describe('generateDDL — bigquery', () => {
  it('should use backtick identifiers', () => {
    const ddl = generateDDL(makeTable(), 'bigquery')
    expect(ddl).toContain('`public`.`users`')
    expect(ddl).toContain('`id`')
  })

  it('should not include PRIMARY KEY clause', () => {
    const ddl = generateDDL(makeTable(), 'bigquery')
    expect(ddl).not.toContain('PRIMARY KEY')
  })

  it('should include NOT NULL', () => {
    const ddl = generateDDL(makeTable(), 'bigquery')
    expect(ddl).toContain('NOT NULL')
  })
})

// ---------------------------------------------------------------------------
// Generic / SQLite / SQL Server DDL
// ---------------------------------------------------------------------------

describe('generateDDL — generic/sqlite/sqlserver', () => {
  const genericDialects: SQLDialect[] = ['sqlite', 'sqlserver', 'generic']

  for (const dialect of genericDialects) {
    it(`should generate valid DDL for ${dialect}`, () => {
      const ddl = generateDDL(makeTable(), dialect)
      expect(ddl).toContain('CREATE TABLE')
      expect(ddl).toContain('"id"')
      expect(ddl.trimEnd()).toMatch(/;$/)
    })
  }

  it('should include inline PRIMARY KEY for single PK (generic)', () => {
    const ddl = generateDDL(makeTable(), 'generic')
    expect(ddl).toContain('PRIMARY KEY')
  })

  it('should include composite PRIMARY KEY for generic', () => {
    const table = makeTable({
      columns: [
        makeColumn({ columnName: 'a' }),
        makeColumn({ columnName: 'b' }),
      ],
    })
    const ddl = generateDDL(table, 'generic')
    expect(ddl).toContain('PRIMARY KEY ("a", "b")')
  })
})

// ---------------------------------------------------------------------------
// DuckDB DDL (uses PostgreSQL path)
// ---------------------------------------------------------------------------

describe('generateDDL — duckdb', () => {
  it('should use PostgreSQL-style DDL', () => {
    const ddl = generateDDL(makeTable(), 'duckdb')
    expect(ddl).toContain('CREATE TABLE "public"."users"')
    expect(ddl).toContain('"id" integer NOT NULL')
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting tests
// ---------------------------------------------------------------------------

describe('generateDDL — cross-cutting', () => {
  it('should handle table with no columns', () => {
    const table = makeTable({ columns: [] })
    const ddl = generateDDL(table, 'postgresql')
    expect(ddl).toContain('CREATE TABLE')
  })

  it('should handle multiline description by collapsing newlines', () => {
    const table = makeTable({
      columns: [
        makeColumn({ description: 'Line 1\nLine 2\r\nLine 3' }),
      ],
    })
    const ddl = generateDDL(table, 'postgresql')
    expect(ddl).toContain('-- Line 1 Line 2 Line 3')
  })

  it('should handle null description (no comment)', () => {
    const table = makeTable({
      columns: [makeColumn({ description: null })],
    })
    const ddl = generateDDL(table, 'postgresql')
    expect(ddl).not.toContain('--')
  })

  it('should handle empty string description (no comment)', () => {
    const table = makeTable({
      columns: [makeColumn({ description: '' })],
    })
    const ddl = generateDDL(table, 'postgresql')
    expect(ddl).not.toContain('--')
  })

  it('should handle FK without referenced schema', () => {
    const table = makeTable({
      foreignKeys: [
        makeForeignKey({ referencedSchema: '' }),
      ],
    })
    // For PostgreSQL, empty schema string still gets quoted
    const ddl = generateDDL(table, 'postgresql')
    expect(ddl).toContain('FOREIGN KEY')
  })
})
