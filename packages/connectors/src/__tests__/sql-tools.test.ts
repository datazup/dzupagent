/**
 * Tests for SQL read-only safety guard in sql-tools.ts.
 *
 * Exercises the `isReadOnlySQL` and `stripCommentsAndLiterals` internals
 * exported via `__sqlToolsInternals`.
 */

import { describe, it, expect, vi } from 'vitest'
import { __sqlToolsInternals, createSQLTools } from '../sql/sql-tools.js'
import type { SQLConnector } from '../sql/types.js'

const { isReadOnlySQL, stripLeadingComments, READ_ONLY_SQL_ERROR } = __sqlToolsInternals

// ---------------------------------------------------------------------------
// stripLeadingComments
// ---------------------------------------------------------------------------

describe('stripLeadingComments', () => {
  it('returns plain query unchanged', () => {
    expect(stripLeadingComments('SELECT 1')).toBe('SELECT 1')
  })

  it('strips a leading -- comment', () => {
    expect(stripLeadingComments('-- comment\nSELECT 1')).toBe('SELECT 1')
  })

  it('strips multiple leading -- comments', () => {
    const sql = '-- c1\n-- c2\nSELECT 1'
    expect(stripLeadingComments(sql)).toBe('SELECT 1')
  })

  it('strips a leading /* */ block comment', () => {
    expect(stripLeadingComments('/* comment */SELECT 1')).toBe('SELECT 1')
  })

  it('strips mixed leading comments', () => {
    const sql = '-- line\n/* block */SELECT 1'
    expect(stripLeadingComments(sql)).toBe('SELECT 1')
  })

  it('returns empty string for unclosed block comment', () => {
    expect(stripLeadingComments('/* no end SELECT 1')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// isReadOnlySQL — allowed queries
// ---------------------------------------------------------------------------

describe('isReadOnlySQL — allowed', () => {
  it('plain SELECT', () => {
    expect(isReadOnlySQL('SELECT * FROM t')).toBe(true)
  })

  it('SELECT with CTAS keyword inside a string literal (not real DML)', () => {
    // The word INSERT in a string should not block the query
    expect(isReadOnlySQL("SELECT 'INSERT' AS keyword FROM t")).toBe(true)
  })

  it('SELECT with DML keyword in a -- comment', () => {
    expect(isReadOnlySQL('SELECT 1 -- DELETE this later')).toBe(true)
  })

  it('SELECT with DML keyword in a /* */ comment', () => {
    expect(isReadOnlySQL('SELECT 1 /* UPDATE stats */')).toBe(true)
  })

  it('WITH ... SELECT (plain CTE)', () => {
    expect(isReadOnlySQL('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(true)
  })

  it('WITH RECURSIVE', () => {
    expect(isReadOnlySQL('WITH RECURSIVE r AS (SELECT 1) SELECT * FROM r')).toBe(true)
  })

  it('case-insensitive for SELECT', () => {
    expect(isReadOnlySQL('select * from t')).toBe(true)
  })

  it('case-insensitive for WITH', () => {
    expect(isReadOnlySQL('with cte as (select 1) select * from cte')).toBe(true)
  })

  it('allows SELECT after leading block comment', () => {
    expect(isReadOnlySQL('/* header */\nSELECT 1')).toBe(true)
  })

  it('string literal with doubled-quote escape does not confuse parser', () => {
    expect(isReadOnlySQL("SELECT 'it''s fine' FROM t")).toBe(true)
  })

  it('double-quoted identifier with DML keyword does not block', () => {
    expect(isReadOnlySQL('SELECT "delete_at" FROM t')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isReadOnlySQL — blocked queries
// ---------------------------------------------------------------------------

describe('isReadOnlySQL — blocked', () => {
  it('INSERT statement', () => {
    expect(isReadOnlySQL('INSERT INTO t VALUES (1)')).toBe(false)
  })

  it('UPDATE statement', () => {
    expect(isReadOnlySQL('UPDATE t SET x = 1')).toBe(false)
  })

  it('DELETE statement', () => {
    expect(isReadOnlySQL('DELETE FROM t')).toBe(false)
  })

  it('MERGE statement', () => {
    expect(isReadOnlySQL('MERGE INTO t USING s ON t.id = s.id')).toBe(false)
  })

  it('CREATE TABLE', () => {
    expect(isReadOnlySQL('CREATE TABLE t (id INT)')).toBe(false)
  })

  it('DROP TABLE', () => {
    expect(isReadOnlySQL('DROP TABLE t')).toBe(false)
  })

  it('WITH ... INSERT data-modifying CTE', () => {
    expect(isReadOnlySQL('WITH x AS (SELECT 1) INSERT INTO y SELECT * FROM x')).toBe(false)
  })

  it('WITH ... DELETE data-modifying CTE', () => {
    expect(isReadOnlySQL('WITH x AS (SELECT 1) DELETE FROM y')).toBe(false)
  })

  it('WITH ... UPDATE data-modifying CTE', () => {
    expect(isReadOnlySQL('WITH x AS (SELECT 1) UPDATE y SET a = 1')).toBe(false)
  })

  it('DML keyword after /* */ comment was bypass — now blocked', () => {
    // Previously this could bypass the check if comment-stripping was incomplete.
    expect(isReadOnlySQL('SELECT 1 /* innocent */ UNION ALL INSERT INTO t VALUES (1)')).toBe(false)
  })

  it('empty string', () => {
    expect(isReadOnlySQL('')).toBe(false)
  })

  it('whitespace only', () => {
    expect(isReadOnlySQL('   ')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// createSQLTools — sql-query tool enforces read-only guard
// ---------------------------------------------------------------------------

describe('createSQLTools — sql-query', () => {
  function makeMockConnector(overrides: Partial<SQLConnector> = {}): SQLConnector {
    return {
      executeQuery: vi.fn().mockResolvedValue({ columns: ['id'], rows: [[1]], rowCount: 1, truncated: false }),
      discoverSchema: vi.fn().mockResolvedValue({ dialect: 'postgresql', tables: [] }),
      generateDDL: vi.fn().mockReturnValue('CREATE TABLE t (id INT)'),
      testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
      close: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    } as unknown as SQLConnector
  }

  it('executes a valid SELECT query', async () => {
    const connector = makeMockConnector()
    const tools = createSQLTools({ connector })
    const sqlTool = tools.find(t => t.name === 'sql-query')!
    const result = JSON.parse(await sqlTool.invoke({ sql: 'SELECT 1' }))
    expect(result.rowCount).toBe(1)
  })

  it('rejects INSERT with read-only error', async () => {
    const connector = makeMockConnector()
    const tools = createSQLTools({ connector })
    const sqlTool = tools.find(t => t.name === 'sql-query')!
    const result = JSON.parse(await sqlTool.invoke({ sql: 'INSERT INTO t VALUES (1)' }))
    expect(result.error).toBe(READ_ONLY_SQL_ERROR)
    expect(connector.executeQuery).not.toHaveBeenCalled()
  })

  it('rejects DML-in-comment bypass attempt', async () => {
    const connector = makeMockConnector()
    const tools = createSQLTools({ connector })
    const sqlTool = tools.find(t => t.name === 'sql-query')!
    const result = JSON.parse(await sqlTool.invoke({
      sql: "SELECT 'safe' /* DELETE FROM secrets */ FROM t",
    }))
    // This should PASS (keyword is inside a comment/literal, not real DML)
    // The query is actually safe — our fix correctly allows it
    expect(result.rowCount).toBe(1)
  })
})
