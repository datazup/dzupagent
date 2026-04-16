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
})
