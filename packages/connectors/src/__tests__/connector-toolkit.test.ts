/**
 * Tests for F24 — ConnectorToolkit factory functions.
 *
 * Validates that each connector exposes a toolkit factory returning
 * a ConnectorToolkit with the correct name, tools, and enabledTools.
 * No real API calls are made — fetch is stubbed globally.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createGitHubConnectorToolkit,
  createSlackConnectorToolkit,
  createHttpConnectorToolkit,
  createDatabaseConnectorToolkit,
} from '../index.js'
import type { ConnectorToolkit } from '../index.js'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

describe('createGitHubConnectorToolkit', () => {
  function makeToolkit(enabledTools?: string[]): ConnectorToolkit {
    return createGitHubConnectorToolkit({
      token: 'test-token',
      enabledTools,
    })
  }

  it('returns a toolkit with name="github"', () => {
    const tk = makeToolkit()
    expect(tk.name).toBe('github')
  })

  it('tools array is non-empty', () => {
    const tk = makeToolkit()
    expect(tk.tools.length).toBeGreaterThan(0)
  })

  it('with enabledTools=["github_list_issues"] returns only that tool', () => {
    const tk = makeToolkit(['github_list_issues'])
    expect(tk.tools).toHaveLength(1)
    expect(tk.tools[0]!.name).toBe('github_list_issues')
  })

  it('with no enabledTools returns all tools', () => {
    const tk = makeToolkit()
    // GitHub connector has 17 tools total
    expect(tk.tools.length).toBeGreaterThanOrEqual(10)
    expect(tk.enabledTools).toBeUndefined()
  })

  it('all tools have unique names', () => {
    const tk = makeToolkit()
    const names = tk.tools.map(t => t.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })
})

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

describe('createSlackConnectorToolkit', () => {
  it('returns a toolkit with name="slack"', () => {
    const tk = createSlackConnectorToolkit({ token: 'xoxb-test' })
    expect(tk.name).toBe('slack')
  })

  it('tools array is non-empty', () => {
    const tk = createSlackConnectorToolkit({ token: 'xoxb-test' })
    expect(tk.tools.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

describe('createHttpConnectorToolkit', () => {
  it('returns a toolkit with name="http"', () => {
    const tk = createHttpConnectorToolkit({ baseUrl: 'https://api.example.com' })
    expect(tk.name).toBe('http')
  })

  it('tools include http_request', () => {
    const tk = createHttpConnectorToolkit({ baseUrl: 'https://api.example.com' })
    const names = tk.tools.map(t => t.name)
    expect(names).toContain('http_request')
  })
})

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

describe('createDatabaseConnectorToolkit', () => {
  it('returns a toolkit object with name="database"', () => {
    const tk = createDatabaseConnectorToolkit({
      query: async () => ({ rows: [], rowCount: 0 }),
    })
    expect(tk.name).toBe('database')
    expect(tk.tools).toBeDefined()
    expect(Array.isArray(tk.tools)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting: LangChain tool validity and descriptions
// ---------------------------------------------------------------------------

describe('ConnectorToolkit tools are valid LangChain tool objects', () => {
  it('all toolkit tools have .name and .description', () => {
    const toolkits: ConnectorToolkit[] = [
      createGitHubConnectorToolkit({ token: 'tok' }),
      createSlackConnectorToolkit({ token: 'tok' }),
      createHttpConnectorToolkit({ baseUrl: 'https://example.com' }),
      createDatabaseConnectorToolkit({
        query: async () => ({ rows: [], rowCount: 0 }),
      }),
    ]

    for (const tk of toolkits) {
      for (const tool of tk.tools) {
        expect(typeof tool.name).toBe('string')
        expect(tool.name.length).toBeGreaterThan(0)
        expect(typeof tool.description).toBe('string')
      }
    }
  })

  it('each connector toolkit tool has a non-empty description', () => {
    const toolkits: ConnectorToolkit[] = [
      createGitHubConnectorToolkit({ token: 'tok' }),
      createSlackConnectorToolkit({ token: 'tok' }),
      createHttpConnectorToolkit({ baseUrl: 'https://example.com' }),
      createDatabaseConnectorToolkit({
        query: async () => ({ rows: [], rowCount: 0 }),
      }),
    ]

    for (const tk of toolkits) {
      for (const tool of tk.tools) {
        expect(tool.description.length).toBeGreaterThan(0)
      }
    }
  })
})
