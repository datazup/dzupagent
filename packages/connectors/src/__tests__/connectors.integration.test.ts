import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDatabaseConnector,
  createGitHubConnector,
  createHTTPConnector,
  filterTools,
} from '../index.js'

function mockJsonResponse(body: unknown, status = 200, statusText = 'OK') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('connectors integration', () => {
  it('runs the HTTP connector tool against a mocked fetch contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ ok: true }, 200, 'OK'),
    )
    vi.stubGlobal('fetch', fetchMock)

    const tools = createHTTPConnector({
      baseUrl: 'https://api.example.com',
      headers: { Authorization: 'Bearer token' },
      allowedMethods: ['GET', 'POST'],
    })
    expect(tools.map((tool) => tool.name)).toEqual(['http_request'])

    const result = await tools[0]!.invoke({
      method: 'GET',
      path: '/v1/status',
      query: { verbose: 'true' },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/status?verbose=true',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer token',
        }),
      }),
    )
    expect(result).toContain('200 OK')
    expect(result).toContain('"ok":true')
  })

  it('decodes GitHub file content and honors enabled tool selection', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({
        name: 'README.md',
        path: 'README.md',
        type: 'file',
        content: Buffer.from('hello from git').toString('base64'),
        encoding: 'base64',
        sha: 'abc123',
        html_url: 'https://github.com/acme/repo/blob/main/README.md',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const tools = createGitHubConnector({
      token: 'secret-token',
      enabledTools: ['github_get_file'],
      baseUrl: 'https://api.github.com',
    })

    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('github_get_file')

    const result = await tools[0]!.invoke({
      owner: 'acme',
      repo: 'repo',
      path: 'README.md',
      ref: 'main',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.github.com/repos/acme/repo/contents/README.md?ref=main',
    )
    expect(result).toBe('hello from git')
  })

  it('formats database query output through the public connector API', async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain('SELECT id, name FROM users')
      return {
        rows: [{ id: 1, name: 'Ada' }],
        rowCount: 1,
      }
    })

    const tools = createDatabaseConnector({
      databaseName: 'analytics',
      enabledTools: ['db-query'],
      query,
      readOnly: true,
    })

    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('db-query')
    expect(filterTools(tools, ['db-query'])).toHaveLength(1)

    const result = await tools[0]!.invoke({
      sql: 'SELECT id, name FROM users',
    })

    expect(query).toHaveBeenCalledTimes(1)
    expect(result).toContain('id | name')
    expect(result).toContain('1 | Ada')
    expect(result).toContain('(1 rows')
  })
})
