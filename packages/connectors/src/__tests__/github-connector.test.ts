/**
 * Tests for the GitHub connector — covers API calls with mocked fetch,
 * error handling, tool filtering, and response formatting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createGitHubConnector } from '../github/github-connector.js'

describe('GitHub connector', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mockGitHubApi(body: unknown, ok = true, status = 200): ReturnType<typeof vi.fn> {
    const mock = vi.fn().mockResolvedValue({
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  // ── github_get_file ────────────────────────────────

  describe('github_get_file', () => {
    it('fetches file content and decodes base64', async () => {
      const encoded = Buffer.from('console.log("hello")').toString('base64')
      mockGitHubApi({ content: encoded, encoding: 'base64' })

      const tools = createGitHubConnector({ token: 'test-token' })
      const getFile = tools.find(t => t.name === 'github_get_file')!
      const result = await getFile.invoke({ owner: 'org', repo: 'app', path: 'src/index.ts' })

      expect(result).toBe('console.log("hello")')
    })

    it('passes ref as query parameter', async () => {
      const mock = mockGitHubApi({ content: Buffer.from('v2').toString('base64'), encoding: 'base64' })
      const tools = createGitHubConnector({ token: 'test-token' })
      const getFile = tools.find(t => t.name === 'github_get_file')!
      await getFile.invoke({ owner: 'org', repo: 'app', path: 'file.ts', ref: 'v2.0' })

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('?ref=v2.0')
    })

    it('returns error string on API failure', async () => {
      mockGitHubApi({ message: 'Not Found' }, false, 404)
      const tools = createGitHubConnector({ token: 'test-token' })
      const getFile = tools.find(t => t.name === 'github_get_file')!
      const result = await getFile.invoke({ owner: 'org', repo: 'app', path: 'missing.ts' })

      expect(result).toContain('GitHub API error')
      expect(result).toContain('404')
    })
  })

  // ── github_list_issues ─────────────────────────────

  describe('github_list_issues', () => {
    it('lists issues with default parameters', async () => {
      const mock = mockGitHubApi([
        { number: 1, title: 'Bug report' },
        { number: 2, title: 'Feature request' },
      ])

      const tools = createGitHubConnector({ token: 'test-token' })
      const listIssues = tools.find(t => t.name === 'github_list_issues')!
      const result = await listIssues.invoke({ owner: 'org', repo: 'app' })

      expect(result).toContain('Bug report')
      expect(result).toContain('Feature request')

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('per_page=10')
    })

    it('passes state and labels filters', async () => {
      const mock = mockGitHubApi([])
      const tools = createGitHubConnector({ token: 'test-token' })
      const listIssues = tools.find(t => t.name === 'github_list_issues')!
      await listIssues.invoke({ owner: 'org', repo: 'app', state: 'closed', labels: 'bug,urgent' })

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('state=closed')
      expect(calledUrl).toContain('labels=bug')
    })
  })

  // ── github_create_issue ────────────────────────────

  describe('github_create_issue', () => {
    it('creates issue and returns number and URL', async () => {
      mockGitHubApi({ number: 42, html_url: 'https://github.com/org/app/issues/42' })
      const tools = createGitHubConnector({ token: 'test-token' })
      const createIssue = tools.find(t => t.name === 'github_create_issue')!
      const result = await createIssue.invoke({
        owner: 'org', repo: 'app', title: 'New bug', body: 'Details here',
      })

      expect(result).toContain('#42')
      expect(result).toContain('https://github.com/org/app/issues/42')
    })

    it('sends correct POST body', async () => {
      const mock = mockGitHubApi({ number: 1, html_url: 'https://github.com/org/app/issues/1' })
      const tools = createGitHubConnector({ token: 'test-token' })
      const createIssue = tools.find(t => t.name === 'github_create_issue')!
      await createIssue.invoke({
        owner: 'org', repo: 'app', title: 'Test', labels: ['bug'],
      })

      const calledInit = mock.mock.calls[0]![1] as RequestInit
      const body = JSON.parse(calledInit.body as string) as Record<string, unknown>
      expect(body['title']).toBe('Test')
      expect(body['labels']).toEqual(['bug'])
    })
  })

  // ── github_create_pr ───────────────────────────────

  describe('github_create_pr', () => {
    it('creates PR and returns number and URL', async () => {
      mockGitHubApi({ number: 10, html_url: 'https://github.com/org/app/pull/10' })
      const tools = createGitHubConnector({ token: 'test-token' })
      const createPR = tools.find(t => t.name === 'github_create_pr')!
      const result = await createPR.invoke({
        owner: 'org', repo: 'app', title: 'Add feature', head: 'feat-branch', base: 'main',
      })

      expect(result).toContain('#10')
      expect(result).toContain('https://github.com/org/app/pull/10')
    })
  })

  // ── github_search_code ─────────────────────────────

  describe('github_search_code', () => {
    it('returns formatted search results', async () => {
      mockGitHubApi({
        items: [
          { path: 'src/utils.ts', repository: { full_name: 'org/app' } },
          { path: 'lib/helpers.ts', repository: { full_name: 'org/lib' } },
        ],
      })

      const tools = createGitHubConnector({ token: 'test-token' })
      const search = tools.find(t => t.name === 'github_search_code')!
      const result = await search.invoke({ query: 'parseJSON' })

      expect(result).toContain('org/app/src/utils.ts')
      expect(result).toContain('org/lib/lib/helpers.ts')
    })
  })

  // ── Authentication ─────────────────────────────────

  describe('authentication', () => {
    it('sends Bearer token in Authorization header', async () => {
      const mock = mockGitHubApi([])
      const tools = createGitHubConnector({ token: 'ghp_secret123' })
      await tools.find(t => t.name === 'github_list_issues')!.invoke({ owner: 'o', repo: 'r' })

      const calledInit = mock.mock.calls[0]![1] as RequestInit
      const headers = calledInit.headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer ghp_secret123')
    })

    it('uses custom base URL when provided', async () => {
      const mock = mockGitHubApi([])
      const tools = createGitHubConnector({
        token: 'tok',
        baseUrl: 'https://ghe.corp.com/api/v3',
      })
      await tools.find(t => t.name === 'github_list_issues')!.invoke({ owner: 'o', repo: 'r' })

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl.startsWith('https://ghe.corp.com/api/v3')).toBe(true)
    })
  })

  // ── Tool filtering ─────────────────────────────────

  describe('tool filtering', () => {
    it('returns only enabled tools', () => {
      const tools = createGitHubConnector({
        token: 'tok',
        enabledTools: ['github_get_file', 'github_create_pr'],
      })
      expect(tools).toHaveLength(2)
      expect(tools.map(t => t.name)).toEqual(['github_get_file', 'github_create_pr'])
    })
  })
})
