/**
 * Tests for the GitHub connector — covers API calls with mocked fetch,
 * error handling, tool filtering, and response formatting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createGitHubConnector } from '../github/github-connector.js'
import { GitHubClient, GitHubApiError } from '../github/github-client.js'

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

  function getTool(name: string) {
    const tools = createGitHubConnector({ token: 'test-token' })
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`Tool ${name} not found`)
    return tool
  }

  // ── github_get_file ────────────────────────────────

  describe('github_get_file', () => {
    it('fetches file content and decodes base64', async () => {
      const encoded = Buffer.from('console.log("hello")').toString('base64')
      mockGitHubApi({ content: encoded, encoding: 'base64', type: 'file', name: 'index.ts', path: 'src/index.ts', sha: 'abc', html_url: '' })

      const getFile = getTool('github_get_file')
      const result = await getFile.invoke({ owner: 'org', repo: 'app', path: 'src/index.ts' })

      expect(result).toBe('console.log("hello")')
    })

    it('passes ref as query parameter', async () => {
      const mock = mockGitHubApi({ content: Buffer.from('v2').toString('base64'), encoding: 'base64', type: 'file', name: 'file.ts', path: 'file.ts', sha: 'abc', html_url: '' })
      const getFile = getTool('github_get_file')
      await getFile.invoke({ owner: 'org', repo: 'app', path: 'file.ts', ref: 'v2.0' })

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('?ref=v2.0')
    })

    it('returns error string on API failure', async () => {
      mockGitHubApi({ message: 'Not Found' }, false, 404)
      const getFile = getTool('github_get_file')
      const result = await getFile.invoke({ owner: 'org', repo: 'app', path: 'missing.ts' })

      expect(result).toContain('GitHub API error')
      expect(result).toContain('404')
    })

    it('lists directory entries when response is an array', async () => {
      mockGitHubApi([
        { type: 'file', path: 'src/a.ts', name: 'a.ts', sha: '1', html_url: '' },
        { type: 'dir', path: 'src/utils', name: 'utils', sha: '2', html_url: '' },
      ])
      const getFile = getTool('github_get_file')
      const result = await getFile.invoke({ owner: 'org', repo: 'app', path: 'src' })

      expect(result).toContain('f src/a.ts')
      expect(result).toContain('d src/utils')
    })
  })

  // ── github_list_issues ─────────────────────────────

  describe('github_list_issues', () => {
    it('lists issues with default parameters', async () => {
      const mock = mockGitHubApi([
        { number: 1, title: 'Bug report' },
        { number: 2, title: 'Feature request' },
      ])

      const listIssues = getTool('github_list_issues')
      const result = await listIssues.invoke({ owner: 'org', repo: 'app' })

      expect(result).toContain('Bug report')
      expect(result).toContain('Feature request')

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('per_page=10')
    })

    it('passes state, labels, and assignee filters', async () => {
      const mock = mockGitHubApi([])
      const listIssues = getTool('github_list_issues')
      await listIssues.invoke({ owner: 'org', repo: 'app', state: 'closed', labels: 'bug,urgent', assignee: 'octocat' })

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('state=closed')
      expect(calledUrl).toContain('labels=bug')
      expect(calledUrl).toContain('assignee=octocat')
    })
  })

  // ── github_get_issue ───────────────────────────────

  describe('github_get_issue', () => {
    it('fetches a single issue by number', async () => {
      mockGitHubApi({ number: 42, title: 'Important bug', state: 'open', html_url: 'https://github.com/org/app/issues/42' })
      const getIssue = getTool('github_get_issue')
      const result = await getIssue.invoke({ owner: 'org', repo: 'app', issue_number: 42 })

      expect(result).toContain('Important bug')
      expect(result).toContain('42')
    })

    it('returns error for non-existent issue', async () => {
      mockGitHubApi({ message: 'Not Found' }, false, 404)
      const getIssue = getTool('github_get_issue')
      const result = await getIssue.invoke({ owner: 'org', repo: 'app', issue_number: 9999 })

      expect(result).toContain('GitHub API error')
      expect(result).toContain('404')
    })
  })

  // ── github_create_issue ────────────────────────────

  describe('github_create_issue', () => {
    it('creates issue and returns number and URL', async () => {
      mockGitHubApi({ number: 42, html_url: 'https://github.com/org/app/issues/42' })
      const createIssue = getTool('github_create_issue')
      const result = await createIssue.invoke({
        owner: 'org', repo: 'app', title: 'New bug', body: 'Details here',
      })

      expect(result).toContain('#42')
      expect(result).toContain('https://github.com/org/app/issues/42')
    })

    it('sends correct POST body with labels and assignees', async () => {
      const mock = mockGitHubApi({ number: 1, html_url: 'https://github.com/org/app/issues/1' })
      const createIssue = getTool('github_create_issue')
      await createIssue.invoke({
        owner: 'org', repo: 'app', title: 'Test', labels: ['bug'], assignees: ['octocat'],
      })

      const calledInit = mock.mock.calls[0]![1] as RequestInit
      const body = JSON.parse(calledInit.body as string) as Record<string, unknown>
      expect(body['title']).toBe('Test')
      expect(body['labels']).toEqual(['bug'])
      expect(body['assignees']).toEqual(['octocat'])
    })
  })

  // ── github_update_issue ────────────────────────────

  describe('github_update_issue', () => {
    it('updates an issue and returns status', async () => {
      mockGitHubApi({ number: 5, state: 'closed', html_url: 'https://github.com/org/app/issues/5' })
      const updateIssue = getTool('github_update_issue')
      const result = await updateIssue.invoke({
        owner: 'org', repo: 'app', issue_number: 5, state: 'closed',
      })

      expect(result).toContain('#5')
      expect(result).toContain('closed')
    })

    it('sends PATCH with title and labels', async () => {
      const mock = mockGitHubApi({ number: 5, state: 'open', html_url: 'https://github.com/org/app/issues/5' })
      const updateIssue = getTool('github_update_issue')
      await updateIssue.invoke({
        owner: 'org', repo: 'app', issue_number: 5, title: 'Updated title', labels: ['enhancement'],
      })

      const calledInit = mock.mock.calls[0]![1] as RequestInit
      expect(calledInit.method).toBe('PATCH')
      const body = JSON.parse(calledInit.body as string) as Record<string, unknown>
      expect(body['title']).toBe('Updated title')
      expect(body['labels']).toEqual(['enhancement'])
    })
  })

  // ── github_add_comment ─────────────────────────────

  describe('github_add_comment', () => {
    it('adds a comment and returns URL', async () => {
      mockGitHubApi({ id: 100, html_url: 'https://github.com/org/app/issues/5#issuecomment-100' })
      const addComment = getTool('github_add_comment')
      const result = await addComment.invoke({
        owner: 'org', repo: 'app', issue_number: 5, body: 'Looks good!',
      })

      expect(result).toContain('Comment added')
      expect(result).toContain('issuecomment-100')
    })

    it('sends POST with body', async () => {
      const mock = mockGitHubApi({ id: 100, html_url: 'https://github.com/org/app/issues/5#issuecomment-100' })
      const addComment = getTool('github_add_comment')
      await addComment.invoke({
        owner: 'org', repo: 'app', issue_number: 5, body: 'LGTM',
      })

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('/issues/5/comments')
      const calledInit = mock.mock.calls[0]![1] as RequestInit
      const body = JSON.parse(calledInit.body as string) as Record<string, unknown>
      expect(body['body']).toBe('LGTM')
    })
  })

  // ── github_list_prs ────────────────────────────────

  describe('github_list_prs', () => {
    it('lists pull requests', async () => {
      const mock = mockGitHubApi([
        { number: 10, title: 'Add feature X' },
        { number: 11, title: 'Fix bug Y' },
      ])
      const listPRs = getTool('github_list_prs')
      const result = await listPRs.invoke({ owner: 'org', repo: 'app' })

      expect(result).toContain('Add feature X')
      expect(result).toContain('Fix bug Y')

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('/pulls?')
      expect(calledUrl).toContain('per_page=10')
    })

    it('passes filter parameters', async () => {
      const mock = mockGitHubApi([])
      const listPRs = getTool('github_list_prs')
      await listPRs.invoke({ owner: 'org', repo: 'app', state: 'closed', base: 'main', sort: 'updated', direction: 'desc' })

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('state=closed')
      expect(calledUrl).toContain('base=main')
      expect(calledUrl).toContain('sort=updated')
      expect(calledUrl).toContain('direction=desc')
    })
  })

  // ── github_get_pr ──────────────────────────────────

  describe('github_get_pr', () => {
    it('fetches a single PR', async () => {
      mockGitHubApi({ number: 10, title: 'Add feature', state: 'open', merged: false })
      const getPR = getTool('github_get_pr')
      const result = await getPR.invoke({ owner: 'org', repo: 'app', pr_number: 10 })

      expect(result).toContain('Add feature')
      expect(result).toContain('10')
    })
  })

  // ── github_create_pr ───────────────────────────────

  describe('github_create_pr', () => {
    it('creates PR and returns number and URL', async () => {
      mockGitHubApi({ number: 10, html_url: 'https://github.com/org/app/pull/10' })
      const createPR = getTool('github_create_pr')
      const result = await createPR.invoke({
        owner: 'org', repo: 'app', title: 'Add feature', head: 'feat-branch', base: 'main',
      })

      expect(result).toContain('#10')
      expect(result).toContain('https://github.com/org/app/pull/10')
    })

    it('sends correct POST body', async () => {
      const mock = mockGitHubApi({ number: 10, html_url: 'https://github.com/org/app/pull/10' })
      const createPR = getTool('github_create_pr')
      await createPR.invoke({
        owner: 'org', repo: 'app', title: 'Feature', body: 'Description', head: 'feat', base: 'main',
      })

      const calledInit = mock.mock.calls[0]![1] as RequestInit
      const body = JSON.parse(calledInit.body as string) as Record<string, unknown>
      expect(body['title']).toBe('Feature')
      expect(body['body']).toBe('Description')
      expect(body['head']).toBe('feat')
      expect(body['base']).toBe('main')
    })
  })

  // ── github_merge_pr ────────────────────────────────

  describe('github_merge_pr', () => {
    it('merges PR successfully', async () => {
      mockGitHubApi({ sha: 'abc1234567890', merged: true, message: 'Pull Request successfully merged' })
      const mergePR = getTool('github_merge_pr')
      const result = await mergePR.invoke({ owner: 'org', repo: 'app', pr_number: 10 })

      expect(result).toContain('merged successfully')
      expect(result).toContain('abc1234')
    })

    it('reports merge failure', async () => {
      mockGitHubApi({ sha: '', merged: false, message: 'Merge conflict' })
      const mergePR = getTool('github_merge_pr')
      const result = await mergePR.invoke({ owner: 'org', repo: 'app', pr_number: 10 })

      expect(result).toContain('merge failed')
      expect(result).toContain('Merge conflict')
    })

    it('sends merge method in request body', async () => {
      const mock = mockGitHubApi({ sha: 'abc', merged: true, message: 'ok' })
      const mergePR = getTool('github_merge_pr')
      await mergePR.invoke({
        owner: 'org', repo: 'app', pr_number: 10, merge_method: 'squash', commit_title: 'feat: squash',
      })

      const calledInit = mock.mock.calls[0]![1] as RequestInit
      const body = JSON.parse(calledInit.body as string) as Record<string, unknown>
      expect(body['merge_method']).toBe('squash')
      expect(body['commit_title']).toBe('feat: squash')
    })
  })

  // ── github_list_pr_reviews ─────────────────────────

  describe('github_list_pr_reviews', () => {
    it('lists reviews for a PR', async () => {
      mockGitHubApi([
        { id: 1, body: 'Looks good', state: 'APPROVED', html_url: 'https://github.com/org/app/pull/10#pullrequestreview-1' },
        { id: 2, body: 'Needs changes', state: 'CHANGES_REQUESTED', html_url: 'https://github.com/org/app/pull/10#pullrequestreview-2' },
      ])
      const listReviews = getTool('github_list_pr_reviews')
      const result = await listReviews.invoke({ owner: 'org', repo: 'app', pr_number: 10 })

      expect(result).toContain('APPROVED')
      expect(result).toContain('CHANGES_REQUESTED')
    })
  })

  // ── github_create_pr_review ────────────────────────

  describe('github_create_pr_review', () => {
    it('creates a review and returns status', async () => {
      mockGitHubApi({ id: 5, state: 'APPROVED', html_url: 'https://github.com/org/app/pull/10#pullrequestreview-5' })
      const createReview = getTool('github_create_pr_review')
      const result = await createReview.invoke({
        owner: 'org', repo: 'app', pr_number: 10, body: 'LGTM', event: 'APPROVE',
      })

      expect(result).toContain('Review submitted')
      expect(result).toContain('APPROVED')
    })

    it('sends correct POST body', async () => {
      const mock = mockGitHubApi({ id: 5, state: 'COMMENTED', html_url: 'https://github.com/org/app/pull/10#pullrequestreview-5' })
      const createReview = getTool('github_create_pr_review')
      await createReview.invoke({
        owner: 'org', repo: 'app', pr_number: 10, body: 'Some comments', event: 'COMMENT',
      })

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('/pulls/10/reviews')
      const calledInit = mock.mock.calls[0]![1] as RequestInit
      const body = JSON.parse(calledInit.body as string) as Record<string, unknown>
      expect(body['body']).toBe('Some comments')
      expect(body['event']).toBe('COMMENT')
    })
  })

  // ── github_get_repo ────────────────────────────────

  describe('github_get_repo', () => {
    it('returns repository information', async () => {
      mockGitHubApi({
        full_name: 'org/app',
        description: 'A cool app',
        default_branch: 'main',
        private: false,
        stargazers_count: 100,
      })
      const getRepo = getTool('github_get_repo')
      const result = await getRepo.invoke({ owner: 'org', repo: 'app' })

      expect(result).toContain('org/app')
      expect(result).toContain('A cool app')
      expect(result).toContain('main')
    })
  })

  // ── github_list_branches ───────────────────────────

  describe('github_list_branches', () => {
    it('lists branches with sha and protection status', async () => {
      mockGitHubApi([
        { name: 'main', commit: { sha: 'abc1234567890' }, protected: true },
        { name: 'dev', commit: { sha: 'def1234567890' }, protected: false },
      ])
      const listBranches = getTool('github_list_branches')
      const result = await listBranches.invoke({ owner: 'org', repo: 'app' })

      expect(result).toContain('main (abc1234)')
      expect(result).toContain('[protected]')
      expect(result).toContain('dev (def1234)')
      expect(result).not.toContain('dev (def1234) [protected]')
    })
  })

  // ── github_get_commit ──────────────────────────────

  describe('github_get_commit', () => {
    it('returns commit details', async () => {
      mockGitHubApi({
        sha: 'abc123',
        commit: { message: 'feat: add feature', author: { name: 'Dev', date: '2026-01-01T00:00:00Z' } },
        html_url: 'https://github.com/org/app/commit/abc123',
        author: { login: 'dev' },
      })
      const getCommit = getTool('github_get_commit')
      const result = await getCommit.invoke({ owner: 'org', repo: 'app', sha: 'abc123' })

      expect(result).toContain('feat: add feature')
      expect(result).toContain('abc123')
    })
  })

  // ── github_compare_commits ─────────────────────────

  describe('github_compare_commits', () => {
    it('returns formatted comparison summary', async () => {
      mockGitHubApi({
        status: 'ahead',
        ahead_by: 3,
        behind_by: 0,
        total_commits: 3,
        commits: [],
        files: [
          { filename: 'src/index.ts', status: 'modified', additions: 10, deletions: 2, changes: 12 },
          { filename: 'src/new.ts', status: 'added', additions: 50, deletions: 0, changes: 50 },
        ],
      })
      const compare = getTool('github_compare_commits')
      const result = await compare.invoke({ owner: 'org', repo: 'app', base: 'main', head: 'feature' })

      expect(result).toContain('Status: ahead')
      expect(result).toContain('Ahead by: 3')
      expect(result).toContain('Total commits: 3')
      expect(result).toContain('Files changed: 2')
      expect(result).toContain('modified src/index.ts (+10 -2)')
      expect(result).toContain('added src/new.ts (+50 -0)')
    })

    it('encodes base and head in the URL', async () => {
      const mock = mockGitHubApi({ status: 'identical', ahead_by: 0, behind_by: 0, total_commits: 0, commits: [], files: [] })
      const compare = getTool('github_compare_commits')
      await compare.invoke({ owner: 'org', repo: 'app', base: 'v1.0', head: 'feature/new' })

      const calledUrl = mock.mock.calls[0]![0] as string
      expect(calledUrl).toContain('/compare/v1.0...feature%2Fnew')
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

      const search = getTool('github_search_code')
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

// ── GitHubClient (standalone) ────────────────────────

describe('GitHubClient', () => {
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

  it('throws GitHubApiError on non-ok response', async () => {
    mockFetch({ message: 'Not Found' }, false, 404)
    const client = new GitHubClient({ token: 'tok' })

    await expect(client.getRepo('org', 'app')).rejects.toThrow(GitHubApiError)
    await expect(client.getRepo('org', 'app')).rejects.toThrow('404')
  })

  it('handles 204 No Content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: async () => null,
      text: async () => '',
    }))
    const client = new GitHubClient({ token: 'tok' })
    const result = await client.request('/test')
    expect(result).toBeUndefined()
  })

  it('sets correct headers', async () => {
    const mock = mockFetch({ full_name: 'org/app' })
    const client = new GitHubClient({ token: 'my-token' })
    await client.getRepo('org', 'app')

    const calledInit = mock.mock.calls[0]![1] as RequestInit
    const headers = calledInit.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer my-token')
    expect(headers['Accept']).toBe('application/vnd.github+json')
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
  })

  it('uses custom baseUrl', async () => {
    const mock = mockFetch([])
    const client = new GitHubClient({ token: 'tok', baseUrl: 'https://ghe.corp.com/api/v3' })
    await client.listBranches('org', 'app')

    const calledUrl = mock.mock.calls[0]![0] as string
    expect(calledUrl.startsWith('https://ghe.corp.com/api/v3')).toBe(true)
  })

  it('listIssues builds query string correctly', async () => {
    const mock = mockFetch([])
    const client = new GitHubClient({ token: 'tok' })
    await client.listIssues('org', 'app', { state: 'closed', labels: 'bug', assignee: 'user1', per_page: 5 })

    const calledUrl = mock.mock.calls[0]![0] as string
    expect(calledUrl).toContain('state=closed')
    expect(calledUrl).toContain('labels=bug')
    expect(calledUrl).toContain('assignee=user1')
    expect(calledUrl).toContain('per_page=5')
  })

  it('createIssue sends POST', async () => {
    const mock = mockFetch({ number: 1, title: 'Test', html_url: '' })
    const client = new GitHubClient({ token: 'tok' })
    await client.createIssue('org', 'app', 'Test', 'Body', { labels: ['bug'] })

    const calledInit = mock.mock.calls[0]![1] as RequestInit
    expect(calledInit.method).toBe('POST')
    const body = JSON.parse(calledInit.body as string) as Record<string, unknown>
    expect(body['title']).toBe('Test')
    expect(body['labels']).toEqual(['bug'])
  })

  it('updateIssue sends PATCH', async () => {
    const mock = mockFetch({ number: 1, state: 'closed', html_url: '' })
    const client = new GitHubClient({ token: 'tok' })
    await client.updateIssue('org', 'app', 1, { state: 'closed' })

    const calledInit = mock.mock.calls[0]![1] as RequestInit
    expect(calledInit.method).toBe('PATCH')
  })

  it('mergePR sends PUT', async () => {
    const mock = mockFetch({ sha: 'abc', merged: true, message: 'ok' })
    const client = new GitHubClient({ token: 'tok' })
    await client.mergePR('org', 'app', 10, { merge_method: 'squash' })

    const calledInit = mock.mock.calls[0]![1] as RequestInit
    expect(calledInit.method).toBe('PUT')
    const body = JSON.parse(calledInit.body as string) as Record<string, unknown>
    expect(body['merge_method']).toBe('squash')
  })

  it('compareCommits encodes params', async () => {
    const mock = mockFetch({ status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1, commits: [], files: [] })
    const client = new GitHubClient({ token: 'tok' })
    await client.compareCommits('org', 'app', 'main', 'feat/new')

    const calledUrl = mock.mock.calls[0]![0] as string
    expect(calledUrl).toContain('/compare/main...feat%2Fnew')
  })

  it('createPRReview sends correct event', async () => {
    const mock = mockFetch({ id: 1, state: 'APPROVED', html_url: '', body: 'LGTM' })
    const client = new GitHubClient({ token: 'tok' })
    await client.createPRReview('org', 'app', 5, 'LGTM', 'APPROVE')

    const calledInit = mock.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(calledInit.body as string) as Record<string, unknown>
    expect(body['event']).toBe('APPROVE')
    expect(body['body']).toBe('LGTM')
  })
})
