import { describe, it, expect, vi } from 'vitest'
import { createHTTPConnector } from '../http/http-connector.js'
import { createDatabaseConnector } from '../database/db-connector.js'
import { filterTools } from '../connector-types.js'
import { createGitHubConnector } from '../github/github-connector.js'
import { createSlackConnector } from '../slack/slack-connector.js'

describe('filterTools', () => {
  it('returns all tools when no filter', () => {
    const tools = createHTTPConnector({ baseUrl: 'http://test' })
    expect(filterTools(tools)).toHaveLength(tools.length)
  })

  it('filters by tool name', () => {
    const tools = createHTTPConnector({ baseUrl: 'http://test' })
    const filtered = filterTools(tools, ['http_request'])
    expect(filtered).toHaveLength(1)
    expect(filtered[0]!.name).toBe('http_request')
  })

  it('returns empty for non-matching filter', () => {
    const tools = createHTTPConnector({ baseUrl: 'http://test' })
    expect(filterTools(tools, ['nonexistent'])).toHaveLength(0)
  })
})

describe('GitHub connector', () => {
  it('creates 5 tools by default', () => {
    const tools = createGitHubConnector({ token: 'fake-token' })
    expect(tools.length).toBe(5)
    const names = tools.map(t => t.name)
    expect(names).toContain('github_get_file')
    expect(names).toContain('github_list_issues')
    expect(names).toContain('github_create_issue')
    expect(names).toContain('github_create_pr')
    expect(names).toContain('github_search_code')
  })

  it('filters tools by enabledTools', () => {
    const tools = createGitHubConnector({ token: 'fake', enabledTools: ['github_get_file'] })
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('github_get_file')
  })
})

describe('HTTP connector', () => {
  it('creates a single http_request tool', () => {
    const tools = createHTTPConnector({ baseUrl: 'http://api.example.com' })
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('http_request')
  })

  it('includes base URL in description', () => {
    const tools = createHTTPConnector({ baseUrl: 'http://api.example.com' })
    expect(tools[0]!.description).toContain('api.example.com')
  })

  it('makes a GET request', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '{"result": "ok"}',
    })
    vi.stubGlobal('fetch', mockFetch)

    const tools = createHTTPConnector({ baseUrl: 'http://api.test' })
    const result = await tools[0]!.invoke({ method: 'GET', path: '/health' })

    expect(result).toContain('200 OK')
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('http://api.test/health'),
      expect.objectContaining({ method: 'GET' }),
    )

    vi.unstubAllGlobals()
  })

  it('rejects disallowed methods', async () => {
    const tools = createHTTPConnector({
      baseUrl: 'http://api.test',
      allowedMethods: ['GET'],
    })
    const result = await tools[0]!.invoke({ method: 'DELETE', path: '/dangerous' })
    expect(result).toContain('not allowed')
  })
})

describe('Slack connector', () => {
  it('creates 3 tools', () => {
    const tools = createSlackConnector({ token: 'fake' })
    expect(tools).toHaveLength(3)
    const names = tools.map(t => t.name)
    expect(names).toContain('slack_send_message')
    expect(names).toContain('slack_list_channels')
    expect(names).toContain('slack_search_messages')
  })

  it('filters tools', () => {
    const tools = createSlackConnector({ token: 'fake', enabledTools: ['slack_send_message'] })
    expect(tools).toHaveLength(1)
  })
})

describe('Database connector', () => {
  it('creates 2 tools (query + schema)', () => {
    const tools = createDatabaseConnector({
      query: async () => ({ rows: [], rowCount: 0 }),
    })
    expect(tools).toHaveLength(2)
    expect(tools[0]!.name).toBe('db_query')
    expect(tools[1]!.name).toBe('db_schema')
  })

  it('blocks write queries in read-only mode', async () => {
    const tools = createDatabaseConnector({
      query: async () => ({ rows: [], rowCount: 0 }),
      readOnly: true,
    })
    const result = await tools[0]!.invoke({ sql: 'DELETE FROM users' })
    expect(result).toContain('not allowed')
  })

  it('allows SELECT in read-only mode', async () => {
    const tools = createDatabaseConnector({
      query: async () => ({
        rows: [{ id: 1, name: 'test' }],
        rowCount: 1,
      }),
      readOnly: true,
    })
    const result = await tools[0]!.invoke({ sql: 'SELECT * FROM users' })
    expect(result).toContain('id')
    expect(result).toContain('1 rows')
  })

  it('formats results as a table', async () => {
    const tools = createDatabaseConnector({
      query: async () => ({
        rows: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        rowCount: 2,
      }),
    })
    const result = await tools[0]!.invoke({ sql: 'SELECT * FROM users' })
    expect(result).toContain('Alice')
    expect(result).toContain('Bob')
    expect(result).toContain('2 rows')
  })
})
