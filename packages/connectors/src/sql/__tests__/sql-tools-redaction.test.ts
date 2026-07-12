/**
 * DZUPAGENT-ERR-H-08 — SQL tools error containment.
 *
 * Proves that raw driver errors (host/port/connection-string text) never reach
 * the tool output returned to the LLM, and that the sanitized failure is logged
 * admin-side with full detail via structured stderr.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSQLTools } from '../sql-tools.js'
import type { SQLConnector } from '../types.js'

/** A connector whose every operation throws a raw, leaky driver error. */
function leakyConnector(rawMessage: string): SQLConnector {
  const boom = () => {
    throw new Error(rawMessage)
  }
  return {
    dialect: 'postgresql',
    testConnection: async () => boom(),
    executeQuery: async () => boom(),
    discoverSchema: async () => boom(),
    generateDDL: () => boom(),
  } as unknown as SQLConnector
}

// A representative raw driver error carrying host, port, and a credentialed URL.
const RAW =
  'connect ECONNREFUSED 10.4.2.7:5432 for postgresql://admin:s3cr3tPassword@db.internal.example.com:5432/prod'

const LEAK_FRAGMENTS = [
  '10.4.2.7',
  '5432',
  'db.internal.example.com',
  's3cr3tPassword',
  'postgresql://',
  'ECONNREFUSED',
]

function toolByName(name: string) {
  const tools = createSQLTools({ connector: leakyConnector(RAW) })
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DZUPAGENT-ERR-H-08 — sql tools never leak raw driver errors to the LLM', () => {
  const cases: Array<{ tool: string; input: unknown }> = [
    { tool: 'sql-query', input: { sql: 'SELECT 1' } },
    { tool: 'sql-list-tables', input: {} },
    { tool: 'sql-describe-table', input: { tableName: 'users' } },
    { tool: 'sql-discover-schema', input: {} },
    { tool: 'sql-generate-ddl', input: { tableName: 'users' } },
    { tool: 'sql-test-connection', input: {} },
  ]

  for (const { tool, input } of cases) {
    it(`${tool} output contains no host/port/URL/credential`, async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = await (toolByName(tool) as any).func(input)
      for (const frag of LEAK_FRAGMENTS) {
        expect(out).not.toContain(frag)
      }
      // Output is still valid JSON with a helpful, category-based summary.
      const parsed = JSON.parse(out)
      expect(String(parsed.error)).toMatch(/connection/i)
      errSpy.mockRestore()
    })
  }

  it('logs full raw detail admin-side (structured stderr) with the redacted-safe summary in output', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await (toolByName('sql-query') as any).func({ sql: 'SELECT 1' })

    // Admin log fired with structured JSON containing the full raw message.
    expect(errSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(errSpy.mock.calls[0]![0] as string)
    expect(logged.component).toBe('db-connector')
    expect(logged.operation).toBe('sql_query')
    expect(logged.error.message).toContain('10.4.2.7')

    // …but the LLM-facing output does not contain that raw detail.
    expect(out).not.toContain('10.4.2.7')
    errSpy.mockRestore()
  })
})
