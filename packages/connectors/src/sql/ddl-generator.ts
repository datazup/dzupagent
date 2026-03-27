/**
 * Dialect-specific DDL generation from discovered TableSchema.
 *
 * Migrated from @nl2sql/schema-discovery/ddl-generator.ts
 */

import type { TableSchema, ColumnInfo, SQLDialect } from './types.js'

/**
 * Generate a CREATE TABLE DDL string for the given table and SQL dialect.
 */
export function generateDDL(table: TableSchema, dialect: SQLDialect): string {
  switch (dialect) {
    case 'postgresql':
      return generatePostgreSQLDDL(table)
    case 'mysql':
      return generateMySQLDDL(table)
    case 'clickhouse':
      return generateClickHouseDDL(table)
    case 'snowflake':
      return generateSnowflakeDDL(table)
    case 'bigquery':
      return generateBigQueryDDL(table)
    case 'sqlite':
    case 'sqlserver':
    case 'generic':
      return generateGenericDDL(table)
    case 'duckdb':
      return generatePostgreSQLDDL(table)
  }
}

// --- Identifier quoting ---

function quotePG(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function quoteMySQL(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``
}

function descriptionComment(description: string | null): string {
  if (!description?.trim()) return ''
  return ` -- ${description.replace(/[\r\n]+/g, ' ').trim()}`
}

function primaryKeyColumns(columns: readonly ColumnInfo[]): string[] {
  return columns.filter((c) => c.isPrimaryKey).map((c) => c.columnName)
}

function isAutoIncrementCandidate(col: ColumnInfo): boolean {
  if (!col.isPrimaryKey) return false
  const t = col.dataType.toLowerCase()
  const isInt = t.includes('int') || t === 'serial' || t === 'bigserial' || t === 'smallserial'
  const hasSeq = col.defaultValue !== null && col.defaultValue.toLowerCase().includes('nextval')
  return isInt && (hasSeq || col.defaultValue === null)
}

// --- FK helper ---

function fkLines(table: TableSchema, quoteFn: (n: string) => string): string[] {
  return table.foreignKeys.map((fk) => {
    const ref = fk.referencedSchema
      ? `${quoteFn(fk.referencedSchema)}.${quoteFn(fk.referencedTable)}`
      : quoteFn(fk.referencedTable)
    return `  CONSTRAINT ${quoteFn(fk.constraintName)} FOREIGN KEY (${quoteFn(fk.columnName)}) REFERENCES ${ref} (${quoteFn(fk.referencedColumn)})`
  })
}

// --- Dialect generators ---

function generatePostgreSQLDDL(table: TableSchema): string {
  const name = `${quotePG(table.schemaName)}.${quotePG(table.tableName)}`
  const lines: string[] = []
  const pkCols = primaryKeyColumns(table.columns)

  for (const col of table.columns) {
    let line = `  ${quotePG(col.columnName)} ${col.dataType}`
    if (!col.isNullable) line += ' NOT NULL'
    if (col.defaultValue !== null) line += ` DEFAULT ${col.defaultValue}`
    if (col.isPrimaryKey && pkCols.length === 1) line += ' PRIMARY KEY'
    line += descriptionComment(col.description)
    lines.push(line)
  }
  if (pkCols.length > 1) lines.push(`  PRIMARY KEY (${pkCols.map(quotePG).join(', ')})`)
  lines.push(...fkLines(table, quotePG))
  return `CREATE TABLE ${name} (\n${lines.join(',\n')}\n);`
}

function generateMySQLDDL(table: TableSchema): string {
  const lines: string[] = []
  const pkCols = primaryKeyColumns(table.columns)

  for (const col of table.columns) {
    let line = `  ${quoteMySQL(col.columnName)} ${col.dataType}`
    if (!col.isNullable) line += ' NOT NULL'
    if (isAutoIncrementCandidate(col)) {
      line += ' AUTO_INCREMENT'
    } else if (col.defaultValue !== null) {
      line += ` DEFAULT ${col.defaultValue}`
    }
    line += descriptionComment(col.description)
    lines.push(line)
  }
  if (pkCols.length > 0) lines.push(`  PRIMARY KEY (${pkCols.map(quoteMySQL).join(', ')})`)
  lines.push(...fkLines(table, quoteMySQL))
  return `CREATE TABLE ${quoteMySQL(table.tableName)} (\n${lines.join(',\n')}\n);`
}

function generateClickHouseDDL(table: TableSchema): string {
  const name = table.schemaName
    ? `${quoteMySQL(table.schemaName)}.${quoteMySQL(table.tableName)}`
    : quoteMySQL(table.tableName)
  const lines: string[] = []
  const pkCols = primaryKeyColumns(table.columns)

  for (const col of table.columns) {
    let line = `  ${quoteMySQL(col.columnName)} ${col.dataType}`
    if (col.defaultValue !== null) line += ` DEFAULT ${col.defaultValue}`
    line += descriptionComment(col.description)
    lines.push(line)
  }

  const orderBy = pkCols.length > 0
    ? `ORDER BY (${pkCols.map(quoteMySQL).join(', ')})`
    : 'ORDER BY tuple()'

  return `CREATE TABLE ${name} (\n${lines.join(',\n')}\n)\nENGINE = MergeTree()\n${orderBy};`
}

function generateSnowflakeDDL(table: TableSchema): string {
  const name = table.schemaName
    ? `${quotePG(table.schemaName)}.${quotePG(table.tableName)}`
    : quotePG(table.tableName)
  const lines: string[] = []
  const pkCols = primaryKeyColumns(table.columns)

  for (const col of table.columns) {
    let line = `  ${quotePG(col.columnName)} ${col.dataType}`
    if (!col.isNullable) line += ' NOT NULL'
    if (col.defaultValue !== null) line += ` DEFAULT ${col.defaultValue}`
    line += descriptionComment(col.description)
    lines.push(line)
  }
  if (pkCols.length > 0) lines.push(`  PRIMARY KEY (${pkCols.map(quotePG).join(', ')})`)
  lines.push(...fkLines(table, quotePG))
  return `CREATE TABLE ${name} (\n${lines.join(',\n')}\n);`
}

function generateBigQueryDDL(table: TableSchema): string {
  const name = table.schemaName
    ? `\`${table.schemaName}\`.\`${table.tableName}\``
    : `\`${table.tableName}\``
  const lines: string[] = []

  for (const col of table.columns) {
    let line = `  \`${col.columnName}\` ${col.dataType}`
    if (!col.isNullable) line += ' NOT NULL'
    if (col.defaultValue !== null) line += ` DEFAULT ${col.defaultValue}`
    line += descriptionComment(col.description)
    lines.push(line)
  }

  return `CREATE TABLE ${name} (\n${lines.join(',\n')}\n);`
}

function generateGenericDDL(table: TableSchema): string {
  const name = table.schemaName
    ? `${quotePG(table.schemaName)}.${quotePG(table.tableName)}`
    : quotePG(table.tableName)
  const lines: string[] = []
  const pkCols = primaryKeyColumns(table.columns)

  for (const col of table.columns) {
    let line = `  ${quotePG(col.columnName)} ${col.dataType}`
    if (!col.isNullable) line += ' NOT NULL'
    if (col.defaultValue !== null) line += ` DEFAULT ${col.defaultValue}`
    if (col.isPrimaryKey && pkCols.length === 1) line += ' PRIMARY KEY'
    line += descriptionComment(col.description)
    lines.push(line)
  }
  if (pkCols.length > 1) lines.push(`  PRIMARY KEY (${pkCols.map(quotePG).join(', ')})`)
  lines.push(...fkLines(table, quotePG))
  return `CREATE TABLE ${name} (\n${lines.join(',\n')}\n);`
}
