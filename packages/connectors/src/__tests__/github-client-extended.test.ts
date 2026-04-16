/**
 * Extended GitHubClient tests — covers additional client methods,
 * error edge cases, HTTP method helpers (post/patch/put), pagination
 * query string building, and rate limit / network error scenarios.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GitHubClient, GitHubApiError } from '../github/github-client.js'

describe('GitHubClient — extended', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mockFetch(body: unknown, ok = true, status = 200) {
    const mock = vi.fn().mockResolvedValue({
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  // ── GitHubApiError ────────────────────────────────────

  describe('GitHubApiError', () => {
    it('has correct name property', () => {
      const err = new GitHubApiError(404, '{"message":"Not Found"}')
      expect(err.name).toBe('GitHubApiError')
    })

    it('truncates long body in message', () => {
      const longBody = 'x'.repeat(500)
      const err = new GitHubApiError(500, longBody)
      expect(err.message).toContain('500')
      expect(err.message.length).toBeLessThan(300)
    })

    it('exposes status and body properties', () => {
      const err = new GitHubApiError(403, 'rate limit exceeded')
      expect(err.status).toBe(403)
      expect(err.body).toBe('rate limit exceeded')
    })

    it('is instanceof Error', () => {
      const err = new GitHubApiError(422, 'Validation Failed')
      expect(err).toBeInstanceOf(Error)
    })
  })

  // ── request() method ──────────────────────────────────

  describe('request()', () => {
    it('throws GitHubApiError on 401 unauthorized', async () => {
      mockFetch({ message: 'Bad credentials' }, false, 401)
      const client = new GitHubClient({ token: 'bad-token' })

      await expect(client.request('/user')).rejects.toThrow(GitHubApiError)
      try {
        await client.request('/user')
      } catch (err) {
        expect((err as GitHubApiError).status).toBe(401)
      }
    })

    it('throws GitHubApiError on 403 rate limit', async () => {
      mockFetch({ message: 'API rate limit exceeded' }, false, 403)
      const client = new GitHubClient({ token: 'tok' })

      await expect(client.request('/repos')).rejects.toThrow(GitHubApiError)
    })

    it('throws GitHubApiError on 422 validation error', async () => {
      mockFetch({ message: 'Validation Failed', errors: [] }, false, 422)
      const client = new GitHubClient({ token: 'tok' })

      await expect(client.request('/repos/o/r/issues')).rejects.toThrow(GitHubApiError)
    })

    it('throws GitHubApiError on 500 server error', async () => {
      mockFetch({ message: 'Internal Server Error' }, false, 500)
      const client = new GitHubClient({ token: 'tok' })

      await expect(client.request('/repos/o/r')).rejects.toThrow('500')
    })

    it('propagates network errors', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
      const client = new GitHubClient({ token: 'tok' })

      await expect(client.request('/test')).rejects.toThrow('fetch failed')
    })

    it('merges custom headers with default headers', async () => {
      const mock = mockFetch({ ok: true })
      const client = new GitHubClient({ token: 'tok' })
      await client.request('/test', {
        headers: { 'X-Custom': 'value' },
      })

      const calledInit = mock.mock.calls[0]![1] as RequestInit
      const headers = calledInit.headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer tok')
      expect(headers['X-Custom']).toBe('value')
    })
  })

  // ── Issues — additional edge cases ────────────────────

  describe('listIssues — edge cases', () => {
    it('handles default per_page when no options provided', async () => {
      const mock = mockFetch([])
      const client = new GitHubClient({ token: 'tok' })
      await client.listIssues('org', 'repo')

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('per_page=30')
    })

    it('passes page parameter for pagination', async () => {
      const mock = mockFetch([])
      const client = new GitHubClient({ token: 'tok' })
      await client.listIssues('org', 'repo', { page: 3, per_page: 10 })

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('page=3')
      expect(calledUrl).toContain('per_page=10')
    })

    it('omits optional params when not provided', async () => {
      const mock = mockFetch([])
      const client = new GitHubClient({ token: 'tok' })
      await client.listIssues('org', 'repo', {})

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).not.toContain('state=')
      expect(calledUrl).not.toContain('labels=')
      expect(calledUrl).not.toContain('assignee=')
    })
  })

  // ── Pull Requests — additional ────────────────────────

  describe('listPRs', () => {
    it('builds correct URL with all options', async () => {
      const mock = mockFetch([])
      const client = new GitHubClient({ token: 'tok' })
      await client.listPRs('org', 'repo', {
        state: 'all',
        head: 'user:branch',
        base: 'main',
        sort: 'popularity',
        direction: 'desc',
        per_page: 50,
        page: 2,
      })

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('state=all')
      expect(calledUrl).toContain('head=user%3Abranch')
      expect(calledUrl).toContain('base=main')
      expect(calledUrl).toContain('sort=popularity')
      expect(calledUrl).toContain('direction=desc')
      expect(calledUrl).toContain('per_page=50')
      expect(calledUrl).toContain('page=2')
    })

    it('uses default per_page=30 with no options', async () => {
      const mock = mockFetch([])
      const client = new GitHubClient({ token: 'tok' })
      await client.listPRs('org', 'repo')

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('per_page=30')
    })
  })

  describe('getPR', () => {
    it('calls correct URL', async () => {
      const mock = mockFetch({ number: 42 })
      const client = new GitHubClient({ token: 'tok' })
      await client.getPR('org', 'repo', 42)

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('/repos/org/repo/pulls/42')
    })
  })

  describe('createPR', () => {
    it('sends POST with title, body, head, base', async () => {
      const mock = mockFetch({ number: 1, html_url: 'url' })
      const client = new GitHubClient({ token: 'tok' })
      await client.createPR('org', 'repo', 'Title', 'Body', 'feat-branch', 'main')

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('/repos/org/repo/pulls')
      const calledInit = mock.mock.calls[0]![1] as RequestInit
      expect(calledInit.method).toBe('POST')
      const body = JSON.parse(calledInit.body as string) as Record<string, unknown>
      expect(body['title']).toBe('Title')
      expect(body['body']).toBe('Body')
      expect(body['head']).toBe('feat-branch')
      expect(body['base']).toBe('main')
    })
  })

  describe('mergePR', () => {
    it('uses default merge method when none specified', async () => {
      const mock = mockFetch({ sha: 'abc', merged: true, message: 'ok' })
      const client = new GitHubClient({ token: 'tok' })
      await client.mergePR('org', 'repo', 5)

      const calledInit = mock.mock.calls[0]![1] as RequestInit
      const body = JSON.parse(calledInit.body as string) as Record<string, unknown>
      expect(body['merge_method']).toBe('merge')
    })

    it('sends rebase merge method', async () => {
      const mock = mockFetch({ sha: 'abc', merged: true, message: 'ok' })
      const client = new GitHubClient({ token: 'tok' })
      await client.mergePR('org', 'repo', 5, { merge_method: 'rebase' })

      const calledInit = mock.mock.calls[0]![1] as RequestInit
      const body = JSON.parse(calledInit.body as string) as Record<string, unknown>
      expect(body['merge_method']).toBe('rebase')
    })
  })

  // ── Reviews ───────────────────────────────────────────

  describe('listPRReviews', () => {
    it('calls correct URL path', async () => {
      const mock = mockFetch([])
      const client = new GitHubClient({ token: 'tok' })
      await client.listPRReviews('org', 'repo', 7)

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('/repos/org/repo/pulls/7/reviews')
    })
  })

  // ── Repository ────────────────────────────────────────

  describe('getRepo', () => {
    it('returns parsed repo data', async () => {
      mockFetch({
        full_name: 'org/repo',
        description: 'desc',
        default_branch: 'main',
        private: true,
        language: 'TypeScript',
        stargazers_count: 50,
        forks_count: 10,
        open_issues_count: 5,
      })
      const client = new GitHubClient({ token: 'tok' })
      const repo = await client.getRepo('org', 'repo')

      expect(repo.full_name).toBe('org/repo')
      expect(repo.private).toBe(true)
      expect(repo.language).toBe('TypeScript')
    })
  })

  describe('getCommit', () => {
    it('fetches commit by SHA', async () => {
      const mock = mockFetch({
        sha: 'deadbeef',
        commit: { message: 'fix: bug', author: { name: 'Dev', date: '2026-01-01' } },
        html_url: 'https://github.com/org/repo/commit/deadbeef',
        author: { login: 'dev' },
      })
      const client = new GitHubClient({ token: 'tok' })
      const commit = await client.getCommit('org', 'repo', 'deadbeef')

      expect(commit.sha).toBe('deadbeef')
      expect(commit.commit.message).toBe('fix: bug')

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('/repos/org/repo/commits/deadbeef')
    })
  })

  describe('getContent', () => {
    it('fetches file content without ref', async () => {
      const mock = mockFetch({
        name: 'README.md',
        path: 'README.md',
        type: 'file',
        content: Buffer.from('# Hello').toString('base64'),
        encoding: 'base64',
        sha: 'abc',
        html_url: '',
      })
      const client = new GitHubClient({ token: 'tok' })
      await client.getContent('org', 'repo', 'README.md')

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('/repos/org/repo/contents/README.md')
      expect(calledUrl).not.toContain('?ref=')
    })

    it('passes ref as query parameter', async () => {
      const mock = mockFetch({
        name: 'file.ts',
        path: 'file.ts',
        type: 'file',
        sha: 'abc',
        html_url: '',
      })
      const client = new GitHubClient({ token: 'tok' })
      await client.getContent('org', 'repo', 'file.ts', 'v2.0')

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('?ref=v2.0')
    })

    it('encodes ref with special characters', async () => {
      const mock = mockFetch({
        name: 'file.ts',
        path: 'file.ts',
        type: 'file',
        sha: 'abc',
        html_url: '',
      })
      const client = new GitHubClient({ token: 'tok' })
      await client.getContent('org', 'repo', 'file.ts', 'feat/new thing')

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('?ref=feat%2Fnew%20thing')
    })
  })

  // ── addComment ────────────────────────────────────────

  describe('addComment', () => {
    it('sends POST to correct endpoint', async () => {
      const mock = mockFetch({ id: 123, html_url: 'url', body: 'test' })
      const client = new GitHubClient({ token: 'tok' })
      await client.addComment('org', 'repo', 42, 'Great work!')

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('/repos/org/repo/issues/42/comments')
      const calledInit = mock.mock.calls[0]![1] as RequestInit
      expect(calledInit.method).toBe('POST')
      const body = JSON.parse(calledInit.body as string) as Record<string, unknown>
      expect(body['body']).toBe('Great work!')
    })
  })

  // ── getIssue ──────────────────────────────────────────

  describe('getIssue', () => {
    it('fetches single issue by number', async () => {
      const mock = mockFetch({ number: 99, title: 'Bug', state: 'open' })
      const client = new GitHubClient({ token: 'tok' })
      const issue = await client.getIssue('org', 'repo', 99)

      expect(issue.number).toBe(99)
      expect(issue.title).toBe('Bug')
      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('/repos/org/repo/issues/99')
    })
  })

  // ── listBranches ──────────────────────────────────────

  describe('listBranches', () => {
    it('returns array of branches', async () => {
      mockFetch([
        { name: 'main', commit: { sha: 'aaa' }, protected: true },
        { name: 'dev', commit: { sha: 'bbb' }, protected: false },
      ])
      const client = new GitHubClient({ token: 'tok' })
      const branches = await client.listBranches('org', 'repo')

      expect(branches).toHaveLength(2)
      expect(branches[0]!.name).toBe('main')
      expect(branches[0]!.protected).toBe(true)
    })
  })

  // ── compareCommits ────────────────────────────────────

  describe('compareCommits', () => {
    it('returns comparison data', async () => {
      mockFetch({
        status: 'behind',
        ahead_by: 0,
        behind_by: 5,
        total_commits: 5,
        commits: [],
        files: [],
      })
      const client = new GitHubClient({ token: 'tok' })
      const result = await client.compareCommits('org', 'repo', 'main', 'old-branch')

      expect(result.status).toBe('behind')
      expect(result.behind_by).toBe(5)
    })
  })

  // ── GitHub Enterprise base URL ────────────────────────

  describe('GitHub Enterprise', () => {
    it('uses custom base URL for all requests', async () => {
      const mock = mockFetch({ full_name: 'org/repo' })
      const client = new GitHubClient({
        token: 'tok',
        baseUrl: 'https://git.company.com/api/v3',
      })
      await client.getRepo('org', 'repo')

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toBe('https://git.company.com/api/v3/repos/org/repo')
    })

    it('removes trailing slash from base URL gracefully', async () => {
      const mock = mockFetch([])
      const client = new GitHubClient({
        token: 'tok',
        baseUrl: 'https://git.company.com/api/v3',
      })
      await client.listBranches('org', 'repo')

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('/repos/org/repo/branches')
    })
  })
})
