/**
 * Tests for the database connector — covers read-only enforcement,
 * query execution, result formatting, schema queries, and error handling.
 */
import { describe, it, expect, vi } from 'vitest'
import { createDatabaseConnector } from '../database/db-connector.js'

describe('Database connector', () => {
  function mockQuery(rows: Record<string, unknown>[] = [], rowCount?: number) {
    return vi.fn().mockResolvedValue({ rows, rowCount: rowCount ?? rows.length })
  }

  // ── Read-only enforcement ────────────────────────────

  describe('read-only mode', () => {
    const writeStatements = [
      'INSERT INTO users (name) VALUES ($1)',
      'UPDATE users SET name = $1 WHERE id = $2',
      'DELETE FROM users WHERE id = $1',
      'DROP TABLE users',
      'ALTER TABLE users ADD COLUMN age INT',
      'CREATE TABLE temp (id INT)',
      'TRUNCATE users',
      'GRANT SELECT ON users TO reader',
      'REVOKE ALL ON users FROM public',
    ]

    for (const sql of writeStatements) {
      const keyword = sql.trim().split(/\s/)[0]!
      it(`blocks ${keyword} in read-only mode`, async () => {
        const tools = createDatabaseConnector({ query: mockQuery(), readOnly: true })
        const result = await tools[0]!.invoke({ sql })
        expect(result).toContain('not allowed')
        expect(result).toContain('read-only')
      })
    }

    it('allows SELECT queries in read-only mode', async () => {
      const query = mockQuery([{ id: 1 }])
      const tools = createDatabaseConnector({ query, readOnly: true })
      const result = await tools[0]!.invoke({ sql: 'SELECT 1 AS id' })
      expect(result).not.toContain('not allowed')
      expect(query).toHaveBeenCalled()
    })

    it('defaults to read-only when readOnly is omitted', async () => {
      const tools = createDatabaseConnector({ query: mockQuery() })
      const result = await tools[0]!.invoke({ sql: 'DELETE FROM users' })
      expect(result).toContain('not allowed')
    })
  })

  // ── Read-write mode ─────────────────────────────────

  describe('read-write mode', () => {
    it('allows write queries when readOnly is false', async () => {
      const query = mockQuery([], 3)
      const tools = createDatabaseConnector({ query, readOnly: false })
      const result = await tools[0]!.invoke({ sql: 'DELETE FROM users WHERE active = false' })
      // Should not contain error, and query should have been called
      expect(result).not.toContain('not allowed')
      expect(query).toHaveBeenCalledWith('DELETE FROM users WHERE active = false', [])
    })
  })

  // ── Result formatting ───────────────────────────────

  describe('result formatting', () => {
    it('formats results as a readable table', async () => {
      const query = mockQuery([
        { id: 1, name: 'Alice', email: 'alice@test.com' },
        { id: 2, name: 'Bob', email: 'bob@test.com' },
      ])
      const tools = createDatabaseConnector({ query })
      const result = await tools[0]!.invoke({ sql: 'SELECT * FROM users' })

      expect(result).toContain('id')
      expect(result).toContain('name')
      expect(result).toContain('email')
      expect(result).toContain('Alice')
      expect(result).toContain('Bob')
      expect(result).toContain('2 rows')
    })

    it('reports 0 rows for empty results', async () => {
      const tools = createDatabaseConnector({ query: mockQuery([]) })
      const result = await tools[0]!.invoke({ sql: 'SELECT * FROM empty_table' })
      expect(result).toContain('0 rows')
    })

    it('handles NULL values in results', async () => {
      const query = mockQuery([{ id: 1, name: null }])
      const tools = createDatabaseConnector({ query })
      const result = await tools[0]!.invoke({ sql: 'SELECT * FROM users' })
      expect(result).toContain('NULL')
    })
  })

  // ── Query parameters ────────────────────────────────

  describe('parameterized queries', () => {
    it('passes params to the query function', async () => {
      const query = mockQuery([{ id: 1, name: 'Alice' }])
      const tools = createDatabaseConnector({ query })
      await tools[0]!.invoke({ sql: 'SELECT * FROM users WHERE id = $1', params: [1] })

      expect(query).toHaveBeenCalledWith('SELECT * FROM users WHERE id = $1', [1])
    })

    it('defaults to empty params array', async () => {
      const query = mockQuery([{ id: 1 }])
      const tools = createDatabaseConnector({ query })
      await tools[0]!.invoke({ sql: 'SELECT 1 AS id' })

      expect(query).toHaveBeenCalledWith('SELECT 1 AS id', [])
    })
  })

  // ── Error handling ──────────────────────────────────

  describe('error handling', () => {
    it('catches query errors and returns friendly message', async () => {
      const query = vi.fn().mockRejectedValue(new Error('relation "users" does not exist'))
      const tools = createDatabaseConnector({ query })
      const result = await tools[0]!.invoke({ sql: 'SELECT * FROM users' })

      expect(result).toContain('Query error')
      expect(result).toContain('relation "users" does not exist')
    })
  })

  // ── Schema tool ─────────────────────────────────────

  describe('db_schema tool', () => {
    it('queries all tables when no table specified', async () => {
      const query = mockQuery([{ table_name: 'users', table_type: 'BASE TABLE' }])
      const tools = createDatabaseConnector({ query })
      const result = await tools[1]!.invoke({})

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('information_schema.tables'),
        [],
      )
      expect(result).toContain('users')
    })

    it('queries specific table columns when table provided', async () => {
      const query = mockQuery([
        { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
      ])
      const tools = createDatabaseConnector({ query })
      const result = await tools[1]!.invoke({ table: 'users' })

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('information_schema.columns'),
        ['users'],
      )
      expect(result).toContain('id')
    })

    it('handles schema query errors', async () => {
      const query = vi.fn().mockRejectedValue(new Error('permission denied'))
      const tools = createDatabaseConnector({ query })
      const result = await tools[1]!.invoke({})

      expect(result).toContain('Schema query error')
      expect(result).toContain('permission denied')
    })
  })

  // ── Tool metadata ───────────────────────────────────

  describe('tool metadata', () => {
    it('uses custom database name in descriptions', () => {
      const tools = createDatabaseConnector({
        query: mockQuery(),
        databaseName: 'analytics_db',
      })
      expect(tools[0]!.description).toContain('analytics_db')
      expect(tools[1]!.description).toContain('analytics_db')
    })

    it('uses default database name when not specified', () => {
      const tools = createDatabaseConnector({ query: mockQuery() })
      expect(tools[0]!.description).toContain('database')
    })
  })
})
