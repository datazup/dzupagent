/**
 * Database connector — SQL read-only safety policy.
 *
 * SAFETY: Only parameterized queries are allowed — no string interpolation
 * of user input into SQL. Read-only mode allows only read-safe statement
 * forms and rejects multi-statement/query-shape bypasses.
 *
 * Statement-shape analysis is built on the dialect-aware scanners in
 * {@link ./db-sql-lexer.js}, which neutralize quoted/commented content so the
 * keyword checks below cannot be tricked.
 */
import { leadingKeyword, maskSqlLiteralsAndComments, splitTopLevelStatements } from './db-sql-lexer.js'

export { maskSqlLiteralsAndComments, splitTopLevelStatements } from './db-sql-lexer.js'

const WRITE_ROOT_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'MERGE',
  'COPY',
])

const READ_ONLY_ROOT_KEYWORDS = new Set([
  'SELECT',
  'WITH',
  'EXPLAIN',
  'SHOW',
  'VALUES',
])

const DATA_MODIFYING_KEYWORDS_RE = /\b(INSERT|UPDATE|DELETE|MERGE|COPY)\b/i
const EXPLAIN_ANALYZE_RE = /\bANALYZE\b/i
export const LIMIT_RE = /\bLIMIT\b/i

function isDataModifyingWithStatement(maskedSql: string): boolean {
  return DATA_MODIFYING_KEYWORDS_RE.test(maskedSql)
}

function stripExplainPrefix(maskedSql: string): string {
  let rest = maskedSql.replace(/^\s*EXPLAIN\b/i, '').trimStart()
  if (!rest.startsWith('(')) return rest

  let i = 0
  let depth = 0
  while (i < rest.length) {
    const ch = rest[i]!
    if (ch === '(') depth += 1
    if (ch === ')') {
      depth -= 1
      if (depth === 0) {
        i += 1
        break
      }
    }
    i += 1
  }

  return rest.slice(i).trimStart()
}

export function enforceReadOnlyStatement(sql: string): string {
  const statements = splitTopLevelStatements(sql)
  if (statements.length === 0) {
    throw new Error('Write operations not allowed (read-only mode). SQL query is empty.')
  }
  if (statements.length > 1) {
    throw new Error('Write operations not allowed (read-only mode). Multiple SQL statements are not permitted.')
  }

  const statement = statements[0]!
  const masked = maskSqlLiteralsAndComments(statement)
  const root = leadingKeyword(masked)
  if (!root || !READ_ONLY_ROOT_KEYWORDS.has(root)) {
    throw new Error(
      'Write operations not allowed (read-only mode). Only read-safe SELECT/WITH/SHOW/VALUES/EXPLAIN statements are permitted.',
    )
  }

  if (WRITE_ROOT_KEYWORDS.has(root)) {
    throw new Error('Write operations not allowed (read-only mode).')
  }

  if (root === 'WITH' && isDataModifyingWithStatement(masked)) {
    throw new Error('Write operations not allowed (read-only mode). Data-modifying CTEs are not permitted.')
  }

  if (root === 'EXPLAIN') {
    if (EXPLAIN_ANALYZE_RE.test(masked)) {
      throw new Error('Write operations not allowed (read-only mode). EXPLAIN ANALYZE is not permitted.')
    }
    const explainedStatement = stripExplainPrefix(masked)
    const explainedRoot = leadingKeyword(explainedStatement)
    if (explainedRoot && WRITE_ROOT_KEYWORDS.has(explainedRoot)) {
      throw new Error('Write operations not allowed (read-only mode). EXPLAIN of write statements is not permitted.')
    }
    if (explainedRoot === 'WITH' && isDataModifyingWithStatement(explainedStatement)) {
      throw new Error('Write operations not allowed (read-only mode). EXPLAIN of data-modifying CTEs is not permitted.')
    }
  }

  return statement
}

export function shouldApplyAutoLimit(maskedSql: string): boolean {
  const root = leadingKeyword(maskedSql)
  if (!root) return false
  if (root === 'SHOW' || root === 'EXPLAIN') return false
  if (root === 'WITH' && isDataModifyingWithStatement(maskedSql)) return false
  return root === 'SELECT' || root === 'WITH' || root === 'VALUES'
}
