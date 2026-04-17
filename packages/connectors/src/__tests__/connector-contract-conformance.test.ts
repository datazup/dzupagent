/**
 * Connector contract conformance tests — verifies that all connector
 * factories produce valid ConnectorToolkit objects satisfying the
 * shared interface contract.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createGitHubConnectorToolkit,
  createSlackConnectorToolkit,
  createHttpConnectorToolkit,
  createDatabaseConnectorToolkit,
} from '../index.js'
import type { ConnectorToolkit } from '../connector-contract.js'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Shared assertion helper
// ---------------------------------------------------------------------------

function assertConnectorContract(toolkit: ConnectorToolkit, expectedName: string): void {
  // name property
  expect(typeof toolkit.name).toBe('string')
  expect(toolkit.name).toBe(expectedName)
  expect(toolkit.name.length).toBeGreaterThan(0)

  // tools array
  expect(Array.isArray(toolkit.tools)).toBe(true)
  expect(toolkit.tools.length).toBeGreaterThan(0)

  // Each tool has required properties
  for (const tool of toolkit.tools) {
    expect(typeof tool.name).toBe('string')
    expect(tool.name.length).toBeGreaterThan(0)
    expect(typeof tool.description).toBe('string')
    expect(tool.description.length).toBeGreaterThan(0)
    expect(typeof tool.invoke).toBe('function')
    expect(tool.schema).toBeDefined()
  }

  // All tool names are unique within a toolkit
  const names = toolkit.tools.map(t => t.name)
  expect(new Set(names).size).toBe(names.length)

  // enabledTools is optional; when present it must be an array
  if (toolkit.enabledTools !== undefined) {
    expect(Array.isArray(toolkit.enabledTools)).toBe(true)
  }
}

// ---------------------------------------------------------------------------
// Conformance tests per connector
// ---------------------------------------------------------------------------

describe('Connector contract conformance', () => {
  describe('GitHub connector', () => {
    it('satisfies ConnectorToolkit contract', () => {
      const tk = createGitHubConnectorToolkit({ token: 'test-token' })
      assertConnectorContract(tk, 'github')
    })

    it('respects enabledTools filter and still satisfies contract', () => {
      const tk = createGitHubConnectorToolkit({
        token: 'test-token',
        enabledTools: ['github_list_issues', 'github_get_file'],
      })
      assertConnectorContract(tk, 'github')
      expect(tk.tools).toHaveLength(2)
    })

    it('all tool names start with github_ prefix', () => {
      const tk = createGitHubConnectorToolkit({ token: 'test-token' })
      for (const tool of tk.tools) {
        expect(tool.name).toMatch(/^github_/)
      }
    })
  })

  describe('Slack connector', () => {
    it('satisfies ConnectorToolkit contract', () => {
      const tk = createSlackConnectorToolkit({ token: 'xoxb-test' })
      assertConnectorContract(tk, 'slack')
    })

    it('respects enabledTools filter and still satisfies contract', () => {
      const tk = createSlackConnectorToolkit({
        token: 'xoxb-test',
        enabledTools: ['slack_send_message'],
      })
      assertConnectorContract(tk, 'slack')
      expect(tk.tools).toHaveLength(1)
    })

    it('all tool names start with slack_ prefix', () => {
      const tk = createSlackConnectorToolkit({ token: 'xoxb-test' })
      for (const tool of tk.tools) {
        expect(tool.name).toMatch(/^slack_/)
      }
    })

    it('has exactly 3 tools', () => {
      const tk = createSlackConnectorToolkit({ token: 'xoxb-test' })
      expect(tk.tools).toHaveLength(3)
      expect(tk.tools.map(t => t.name).sort()).toEqual([
        'slack_list_channels',
        'slack_search_messages',
        'slack_send_message',
      ])
    })
  })

  describe('HTTP connector', () => {
    it('satisfies ConnectorToolkit contract', () => {
      const tk = createHttpConnectorToolkit({ baseUrl: 'https://api.example.com' })
      assertConnectorContract(tk, 'http')
    })

    it('has a single http_request tool', () => {
      const tk = createHttpConnectorToolkit({ baseUrl: 'https://api.example.com' })
      expect(tk.tools).toHaveLength(1)
      expect(tk.tools[0]!.name).toBe('http_request')
    })

    it('description includes the base URL', () => {
      const tk = createHttpConnectorToolkit({ baseUrl: 'https://custom-api.test.com' })
      expect(tk.tools[0]!.description).toContain('custom-api.test.com')
    })

    it('description includes allowed methods', () => {
      const tk = createHttpConnectorToolkit({
        baseUrl: 'https://api.example.com',
        allowedMethods: ['GET', 'POST'],
      })
      expect(tk.tools[0]!.description).toContain('GET')
      expect(tk.tools[0]!.description).toContain('POST')
    })
  })

  describe('Database connector', () => {
    const dbConfig = {
      query: async () => ({ rows: [] as Record<string, unknown>[], rowCount: 0 }),
    }

    it('satisfies ConnectorToolkit contract', () => {
      const tk = createDatabaseConnectorToolkit(dbConfig)
      assertConnectorContract(tk, 'database')
    })

    it('respects enabledTools filter and still satisfies contract', () => {
      const tk = createDatabaseConnectorToolkit({
        ...dbConfig,
        enabledTools: ['db-query'],
      })
      assertConnectorContract(tk, 'database')
      expect(tk.tools).toHaveLength(1)
    })

    it('has exactly 3 tools', () => {
      const tk = createDatabaseConnectorToolkit(dbConfig)
      expect(tk.tools).toHaveLength(3)
      expect(tk.tools.map(t => t.name).sort()).toEqual([
        'db-describe-table',
        'db-list-tables',
        'db-query',
      ])
    })

    it('all tool names start with db- prefix', () => {
      const tk = createDatabaseConnectorToolkit(dbConfig)
      for (const tool of tk.tools) {
        expect(tool.name).toMatch(/^db-/)
      }
    })

    it('custom databaseName appears in tool descriptions', () => {
      const tk = createDatabaseConnectorToolkit({
        ...dbConfig,
        databaseName: 'my_analytics',
      })
      for (const tool of tk.tools) {
        expect(tool.description).toContain('my_analytics')
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Cross-connector invariants
  // ---------------------------------------------------------------------------

  describe('cross-connector invariants', () => {
    const allToolkits: Array<{ name: string; toolkit: ConnectorToolkit }> = [
      { name: 'github', toolkit: createGitHubConnectorToolkit({ token: 'tok' }) },
      { name: 'slack', toolkit: createSlackConnectorToolkit({ token: 'tok' }) },
      { name: 'http', toolkit: createHttpConnectorToolkit({ baseUrl: 'https://example.com' }) },
      {
        name: 'database',
        toolkit: createDatabaseConnectorToolkit({
          query: async () => ({ rows: [], rowCount: 0 }),
        }),
      },
    ]

    it('no two connectors share tool names', () => {
      const allNames: string[] = []
      for (const { toolkit } of allToolkits) {
        for (const tool of toolkit.tools) {
          allNames.push(tool.name)
        }
      }
      const unique = new Set(allNames)
      expect(unique.size).toBe(allNames.length)
    })

    it('all connector names are distinct', () => {
      const names = allToolkits.map(t => t.toolkit.name)
      expect(new Set(names).size).toBe(names.length)
    })

    for (const { name, toolkit } of allToolkits) {
      it(`${name} toolkit has readonly name property`, () => {
        expect(typeof toolkit.name).toBe('string')
        // The name should be accessible (verifying the readonly interface)
        expect(toolkit.name).toBe(name)
      })
    }
  })

  // ---------------------------------------------------------------------------
  // W18-B3 — additional conformance for Slack + Database
  // ---------------------------------------------------------------------------

  describe('Slack connector — extended conformance', () => {
    it('produces stable tool list across multiple factory invocations', () => {
      const tk1 = createSlackConnectorToolkit({ token: 'xoxb-test' })
      const tk2 = createSlackConnectorToolkit({ token: 'xoxb-test' })

      const names1 = tk1.tools.map(t => t.name).sort()
      const names2 = tk2.tools.map(t => t.name).sort()
      expect(names1).toEqual(names2)
    })

    it('every Slack tool has a Zod schema with parse method', () => {
      const tk = createSlackConnectorToolkit({ token: 'xoxb-test' })
      for (const t of tk.tools) {
        expect(t.schema).toBeDefined()
        // DynamicStructuredTool wraps the schema so it should expose parse
        const schema = t.schema as { parse?: unknown; safeParse?: unknown }
        expect(typeof schema.parse === 'function' || typeof schema.safeParse === 'function').toBe(true)
      }
    })

    it('Slack toolkit exposes only the requested tools when filtered', () => {
      const tk = createSlackConnectorToolkit({
        token: 'xoxb-test',
        enabledTools: ['slack_send_message', 'slack_list_channels'],
      })
      const names = tk.tools.map(t => t.name)
      expect(names).toContain('slack_send_message')
      expect(names).toContain('slack_list_channels')
      expect(names).not.toContain('slack_search_messages')
    })

    it('Slack tools all have unique names within the toolkit', () => {
      const tk = createSlackConnectorToolkit({ token: 'xoxb-test' })
      const names = tk.tools.map(t => t.name)
      expect(new Set(names).size).toBe(names.length)
    })
  })

  describe('Database connector — extended conformance', () => {
    const dbConfig = {
      query: async () => ({ rows: [] as Record<string, unknown>[], rowCount: 0 }),
    }

    it('produces stable tool list across multiple factory invocations', () => {
      const tk1 = createDatabaseConnectorToolkit(dbConfig)
      const tk2 = createDatabaseConnectorToolkit(dbConfig)

      const names1 = tk1.tools.map(t => t.name).sort()
      const names2 = tk2.tools.map(t => t.name).sort()
      expect(names1).toEqual(names2)
    })

    it('every Database tool has a Zod schema with parse method', () => {
      const tk = createDatabaseConnectorToolkit(dbConfig)
      for (const t of tk.tools) {
        expect(t.schema).toBeDefined()
        const schema = t.schema as { parse?: unknown; safeParse?: unknown }
        expect(typeof schema.parse === 'function' || typeof schema.safeParse === 'function').toBe(true)
      }
    })

    it('Database toolkit exposes only the requested tools when filtered', () => {
      const tk = createDatabaseConnectorToolkit({
        ...dbConfig,
        enabledTools: ['db-query', 'db-list-tables'],
      })
      const names = tk.tools.map(t => t.name)
      expect(names).toContain('db-query')
      expect(names).toContain('db-list-tables')
      expect(names).not.toContain('db-describe-table')
    })

    it('Database tools all have unique names within the toolkit', () => {
      const tk = createDatabaseConnectorToolkit(dbConfig)
      const names = tk.tools.map(t => t.name)
      expect(new Set(names).size).toBe(names.length)
    })

    it('Database tools can be invoked through the toolkit interface', async () => {
      const tk = createDatabaseConnectorToolkit({
        query: async () => ({ rows: [{ id: 1 }], rowCount: 1 }),
      })
      const dbQuery = tk.tools.find(t => t.name === 'db-query')!
      const result = await dbQuery.invoke({ sql: 'SELECT 1 AS id' })
      expect(result).toContain('id')
      expect(result).toContain('1 rows')
    })
  })

  describe('extended cross-connector invariants', () => {
    it('all connectors satisfy contract regardless of credentials provided', () => {
      const slackTk = createSlackConnectorToolkit({ token: 'placeholder' })
      const dbTk = createDatabaseConnectorToolkit({
        query: async () => ({ rows: [], rowCount: 0 }),
      })

      // Both should have non-empty tool lists with proper structure
      expect(slackTk.tools.length).toBeGreaterThan(0)
      expect(dbTk.tools.length).toBeGreaterThan(0)

      for (const t of [...slackTk.tools, ...dbTk.tools]) {
        expect(t.name).toBeTruthy()
        expect(t.description).toBeTruthy()
        expect(typeof t.invoke).toBe('function')
      }
    })
  })
})
