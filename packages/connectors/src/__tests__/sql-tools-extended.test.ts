/**
 * Extended SQL tools tests — covers edge cases in stripCommentsAndLiterals,
 * isReadOnlySQL with complex injection patterns, and tool-level error paths.
 */
import { describe, it, expect } from 'vitest'
import { __sqlToolsInternals } from '../sql/sql-tools.js'

const { isReadOnlySQL, stripLeadingComments, stripCommentsAndLiterals, READ_ONLY_SQL_ERROR } = __sqlToolsInternals

// ---------------------------------------------------------------------------
// stripLeadingComments
// ---------------------------------------------------------------------------

describe('stripLeadingComments', () => {
  it('strips single-line comment', () => {
    expect(stripLeadingComments('-- comment\nSELECT 1')).toBe('SELECT 1')
  })

  it('strips block comment', () => {
    expect(stripLeadingComments('/* block */SELECT 1')).toBe('SELECT 1')
  })

  it('strips multiple leading comments', () => {
    const sql = '-- first\n-- second\n/* block */\nSELECT 1'
    expect(stripLeadingComments(sql)).toBe('SELECT 1')
  })

  it('returns empty string for comment-only input without newline', () => {
    expect(stripLeadingComments('-- only a comment')).toBe('')
  })

  it('returns empty string for unterminated block comment', () => {
    expect(stripLeadingComments('/* unterminated')).toBe('')
  })

  it('handles leading whitespace before comments', () => {
    expect(stripLeadingComments('   -- comment\nSELECT 1')).toBe('SELECT 1')
  })

  it('passes through SQL without comments', () => {
    expect(stripLeadingComments('SELECT 1')).toBe('SELECT 1')
  })
})

// ---------------------------------------------------------------------------
// stripCommentsAndLiterals
// ---------------------------------------------------------------------------

describe('stripCommentsAndLiterals', () => {
  it('replaces single-quoted string literals with space', () => {
    const result = stripCommentsAndLiterals("SELECT 'hello' FROM t")
    expect(result).not.toContain('hello')
    expect(result).toContain('SELECT')
    expect(result).toContain('FROM t')
  })

  it('replaces double-quoted identifiers with space', () => {
    const result = stripCommentsAndLiterals('SELECT "column name" FROM t')
    expect(result).not.toContain('column name')
  })

  it('handles escaped single quotes inside strings', () => {
    const result = stripCommentsAndLiterals("SELECT 'it''s here' FROM t")
    expect(result).not.toContain("it''s")
  })

  it('handles backslash-escaped characters in strings', () => {
    const result = stripCommentsAndLiterals("SELECT 'line\\nnew' FROM t")
    expect(result).not.toContain('line')
  })

  it('handles doubled double quotes', () => {
    const result = stripCommentsAndLiterals('SELECT "col""name" FROM t')
    expect(result).not.toContain('col')
  })

  it('replaces line comments with space', () => {
    const result = stripCommentsAndLiterals('SELECT 1 -- comment here\nFROM t')
    expect(result).not.toContain('comment here')
    expect(result).toContain('SELECT 1')
    expect(result).toContain('FROM t')
  })

  it('replaces block comments with space', () => {
    const result = stripCommentsAndLiterals('SELECT /* hidden */ 1 FROM t')
    expect(result).not.toContain('hidden')
    expect(result).toContain('SELECT')
    expect(result).toContain('1 FROM t')
  })

  it('handles unterminated line comment at end of input', () => {
    const result = stripCommentsAndLiterals('SELECT 1 -- trailing')
    expect(result).toContain('SELECT 1')
  })

  it('handles unterminated block comment at end of input', () => {
    const result = stripCommentsAndLiterals('SELECT 1 /* never closed')
    expect(result).toContain('SELECT 1')
  })

  it('handles unterminated string literal', () => {
    const result = stripCommentsAndLiterals("SELECT 'unclosed")
    expect(result).toContain('SELECT')
  })

  it('handles empty input', () => {
    expect(stripCommentsAndLiterals('')).toBe('')
  })

  it('handles input with only a comment', () => {
    const result = stripCommentsAndLiterals('-- just a comment')
    expect(result.trim()).toBe('')
  })

  it('preserves normal SQL with no special characters', () => {
    expect(stripCommentsAndLiterals('SELECT 1 + 2')).toBe('SELECT 1 + 2')
  })
})

// ---------------------------------------------------------------------------
// isReadOnlySQL
// ---------------------------------------------------------------------------

describe('isReadOnlySQL', () => {
  it('accepts simple SELECT', () => {
    expect(isReadOnlySQL('SELECT 1')).toBe(true)
  })

  it('accepts SELECT with FROM', () => {
    expect(isReadOnlySQL('SELECT * FROM users WHERE id = 1')).toBe(true)
  })

  it('accepts CTE with SELECT', () => {
    expect(isReadOnlySQL('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(true)
  })

  it('rejects INSERT', () => {
    expect(isReadOnlySQL('INSERT INTO users VALUES (1)')).toBe(false)
  })

  it('rejects UPDATE', () => {
    expect(isReadOnlySQL('UPDATE users SET name = $1')).toBe(false)
  })

  it('rejects DELETE', () => {
    expect(isReadOnlySQL('DELETE FROM users')).toBe(false)
  })

  it('rejects DROP TABLE', () => {
    expect(isReadOnlySQL('DROP TABLE users')).toBe(false)
  })

  it('rejects multi-statement injection', () => {
    expect(isReadOnlySQL('SELECT 1; DROP TABLE users')).toBe(false)
  })

  it('rejects DML hidden in CTE', () => {
    // node-sql-parser should catch data-modifying CTEs
    const sql = 'WITH deleted AS (DELETE FROM users RETURNING *) SELECT * FROM deleted'
    expect(isReadOnlySQL(sql)).toBe(false)
  })

  it('rejects unparseable SQL', () => {
    expect(isReadOnlySQL('NOT VALID SQL AT ALL {{{')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isReadOnlySQL('')).toBe(false)
  })

  it('accepts nested subqueries', () => {
    expect(isReadOnlySQL('SELECT * FROM (SELECT 1 AS x) sub')).toBe(true)
  })

  it('rejects CREATE TABLE', () => {
    expect(isReadOnlySQL('CREATE TABLE t (id INT)')).toBe(false)
  })

  it('rejects ALTER TABLE', () => {
    expect(isReadOnlySQL('ALTER TABLE users ADD COLUMN age INT')).toBe(false)
  })

  it('rejects TRUNCATE', () => {
    expect(isReadOnlySQL('TRUNCATE TABLE users')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// READ_ONLY_SQL_ERROR constant
// ---------------------------------------------------------------------------

describe('READ_ONLY_SQL_ERROR', () => {
  it('contains descriptive error message', () => {
    expect(READ_ONLY_SQL_ERROR).toContain('read-only')
    expect(READ_ONLY_SQL_ERROR).toContain('SELECT')
  })
})
