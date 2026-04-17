/**
 * GitHub REST API client — typed wrapper around the GitHub REST API.
 *
 * Uses fetch directly (no octokit dependency). Supports token authentication
 * and GitHub Enterprise Server via configurable base URL.
 */

// ── Types ──────────────────────────────────────────────

export interface GitHubClientConfig {
  token: string
  /** GitHub API base URL (default: https://api.github.com) */
  baseUrl?: string
}

export interface GitHubIssue {
  number: number
  title: string
  body: string | null
  state: string
  html_url: string
  labels: Array<{ name: string }>
  assignees: Array<{ login: string }>
  created_at: string
  updated_at: string
  user: { login: string } | null
}

export interface GitHubComment {
  id: number
  body: string
  html_url: string
  created_at: string
  user: { login: string } | null
}

export interface GitHubPullRequest {
  number: number
  title: string
  body: string | null
  state: string
  html_url: string
  head: { ref: string; sha: string }
  base: { ref: string; sha: string }
  merged: boolean
  mergeable: boolean | null
  created_at: string
  updated_at: string
  user: { login: string } | null
}

export interface GitHubReview {
  id: number
  body: string
  state: string
  html_url: string
  submitted_at: string
  user: { login: string } | null
}

export interface GitHubMergeResult {
  sha: string
  merged: boolean
  message: string
}

export interface GitHubRepo {
  full_name: string
  description: string | null
  html_url: string
  default_branch: string
  private: boolean
  language: string | null
  stargazers_count: number
  forks_count: number
  open_issues_count: number
}

export interface GitHubBranch {
  name: string
  commit: { sha: string }
  protected: boolean
}

export interface GitHubCommit {
  sha: string
  commit: {
    message: string
    author: { name: string; date: string } | null
  }
  html_url: string
  author: { login: string } | null
}

export interface GitHubComparison {
  status: string
  ahead_by: number
  behind_by: number
  total_commits: number
  commits: GitHubCommit[]
  files: Array<{
    filename: string
    status: string
    additions: number
    deletions: number
    changes: number
  }>
}

export interface GitHubContent {
  name: string
  path: string
  type: 'file' | 'dir' | 'symlink' | 'submodule'
  content?: string
  encoding?: string
  sha: string
  html_url: string
}

export interface GitHubCheckRun {
  name: string
  status: string
  conclusion: string | null
}

export interface GitHubCheckRunsResponse {
  check_runs: GitHubCheckRun[]
}

export interface GitHubLabel {
  name: string
}

export interface GitHubReviewComment {
  id: number
  body: string
}

export interface GitHubWorkflowRun {
  id: number
  status: string
  conclusion: string | null
  name: string
}

export interface GitHubWorkflowRunsResponse {
  workflow_runs: GitHubWorkflowRun[]
}

export interface ListIssuesOptions {
  state?: 'open' | 'closed' | 'all'
  labels?: string
  assignee?: string
  per_page?: number
  page?: number
}

export interface UpdateIssueOptions {
  title?: string
  body?: string
  state?: 'open' | 'closed'
  labels?: string[]
  assignees?: string[]
}

export interface ListPRsOptions {
  state?: 'open' | 'closed' | 'all'
  head?: string
  base?: string
  sort?: 'created' | 'updated' | 'popularity' | 'long-running'
  direction?: 'asc' | 'desc'
  per_page?: number
  page?: number
}

export interface MergePROptions {
  commit_title?: string
  commit_message?: string
  merge_method?: 'merge' | 'squash' | 'rebase'
}

// ── Error ──────────────────────────────────────────────

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`GitHub API error ${status}: ${body.slice(0, 200)}`)
    this.name = 'GitHubApiError'
  }
}

// ── Client ─────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://api.github.com'

export class GitHubClient {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>

  constructor(config: GitHubClientConfig) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
    this.headers = {
      'Authorization': `Bearer ${config.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
  }

  /** Low-level fetch helper — returns parsed JSON or throws GitHubApiError. */
  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers, ...init?.headers },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new GitHubApiError(res.status, text)
    }
    // 204 No Content
    if (res.status === 204) return undefined as unknown as T
    return res.json() as Promise<T>
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  private patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  private put<T>(path: string, body?: unknown): Promise<T> {
    const serialized = body !== undefined ? JSON.stringify(body) : undefined
    return this.request<T>(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      ...(serialized !== undefined ? { body: serialized } : {}),
    })
  }

  private delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' })
  }

  // ── Issues ─────────────────────────────────────────

  async listIssues(owner: string, repo: string, options?: ListIssuesOptions): Promise<GitHubIssue[]> {
    const params = new URLSearchParams()
    if (options?.state) params.set('state', options.state)
    if (options?.labels) params.set('labels', options.labels)
    if (options?.assignee) params.set('assignee', options.assignee)
    params.set('per_page', String(options?.per_page ?? 30))
    if (options?.page) params.set('page', String(options.page))
    return this.request<GitHubIssue[]>(`/repos/${owner}/${repo}/issues?${params}`)
  }

  async getIssue(owner: string, repo: string, number: number): Promise<GitHubIssue> {
    return this.request<GitHubIssue>(`/repos/${owner}/${repo}/issues/${number}`)
  }

  async createIssue(
    owner: string,
    repo: string,
    title: string,
    body?: string,
    options?: { labels?: string[]; assignees?: string[] },
  ): Promise<GitHubIssue> {
    return this.post<GitHubIssue>(`/repos/${owner}/${repo}/issues`, {
      title,
      body,
      labels: options?.labels,
      assignees: options?.assignees,
    })
  }

  async updateIssue(
    owner: string,
    repo: string,
    number: number,
    updates: UpdateIssueOptions,
  ): Promise<GitHubIssue> {
    return this.patch<GitHubIssue>(`/repos/${owner}/${repo}/issues/${number}`, updates)
  }

  async addComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<GitHubComment> {
    return this.post<GitHubComment>(`/repos/${owner}/${repo}/issues/${number}/comments`, { body })
  }

  // ── Pull Requests ──────────────────────────────────

  async listPRs(owner: string, repo: string, options?: ListPRsOptions): Promise<GitHubPullRequest[]> {
    const params = new URLSearchParams()
    if (options?.state) params.set('state', options.state)
    if (options?.head) params.set('head', options.head)
    if (options?.base) params.set('base', options.base)
    if (options?.sort) params.set('sort', options.sort)
    if (options?.direction) params.set('direction', options.direction)
    params.set('per_page', String(options?.per_page ?? 30))
    if (options?.page) params.set('page', String(options.page))
    return this.request<GitHubPullRequest[]>(`/repos/${owner}/${repo}/pulls?${params}`)
  }

  async getPR(owner: string, repo: string, number: number): Promise<GitHubPullRequest> {
    return this.request<GitHubPullRequest>(`/repos/${owner}/${repo}/pulls/${number}`)
  }

  async createPR(
    owner: string,
    repo: string,
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<GitHubPullRequest> {
    return this.post<GitHubPullRequest>(`/repos/${owner}/${repo}/pulls`, {
      title,
      body,
      head,
      base,
    })
  }

  async mergePR(
    owner: string,
    repo: string,
    number: number,
    options?: MergePROptions,
  ): Promise<GitHubMergeResult> {
    return this.put<GitHubMergeResult>(`/repos/${owner}/${repo}/pulls/${number}/merge`, {
      commit_title: options?.commit_title,
      commit_message: options?.commit_message,
      merge_method: options?.merge_method ?? 'merge',
    })
  }

  async listPRReviews(owner: string, repo: string, number: number): Promise<GitHubReview[]> {
    return this.request<GitHubReview[]>(`/repos/${owner}/${repo}/pulls/${number}/reviews`)
  }

  async createPRReview(
    owner: string,
    repo: string,
    number: number,
    body: string,
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
  ): Promise<GitHubReview> {
    return this.post<GitHubReview>(`/repos/${owner}/${repo}/pulls/${number}/reviews`, {
      body,
      event,
    })
  }

  // ── Repository ─────────────────────────────────────

  async getRepo(owner: string, repo: string): Promise<GitHubRepo> {
    return this.request<GitHubRepo>(`/repos/${owner}/${repo}`)
  }

  async listBranches(owner: string, repo: string): Promise<GitHubBranch[]> {
    return this.request<GitHubBranch[]>(`/repos/${owner}/${repo}/branches`)
  }

  async getCommit(owner: string, repo: string, sha: string): Promise<GitHubCommit> {
    return this.request<GitHubCommit>(`/repos/${owner}/${repo}/commits/${sha}`)
  }

  async compareCommits(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<GitHubComparison> {
    return this.request<GitHubComparison>(
      `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    )
  }

  async getContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<GitHubContent | GitHubContent[]> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : ''
    return this.request<GitHubContent | GitHubContent[]>(
      `/repos/${owner}/${repo}/contents/${path}${query}`,
    )
  }

  // ── Status Checks ──────────────────────────────────

  /** Get status check runs for a commit ref (used for PR checks). */
  async getPRChecks(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<GitHubCheckRunsResponse> {
    return this.request<GitHubCheckRunsResponse>(
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs`,
    )
  }

  // ── Labels ─────────────────────────────────────────

  /** Add labels to an issue or PR. */
  async addLabels(
    owner: string,
    repo: string,
    issue_number: number,
    labels: string[],
  ): Promise<GitHubLabel[]> {
    return this.post<GitHubLabel[]>(
      `/repos/${owner}/${repo}/issues/${issue_number}/labels`,
      { labels },
    )
  }

  /** Remove a label from an issue or PR. */
  async removeLabel(
    owner: string,
    repo: string,
    issue_number: number,
    label: string,
  ): Promise<void> {
    await this.delete<void>(
      `/repos/${owner}/${repo}/issues/${issue_number}/labels/${encodeURIComponent(label)}`,
    )
  }

  // ── Review Comments ────────────────────────────────

  /** Create a file-level review comment on a pull request. */
  async createReviewComment(
    owner: string,
    repo: string,
    pr_number: number,
    body: string,
    path: string,
    line: number,
    commit_id?: string,
  ): Promise<GitHubReviewComment> {
    const payload: Record<string, unknown> = { body, path, line }
    if (commit_id !== undefined) payload['commit_id'] = commit_id
    return this.post<GitHubReviewComment>(
      `/repos/${owner}/${repo}/pulls/${pr_number}/comments`,
      payload,
    )
  }

  // ── Workflow Runs ──────────────────────────────────

  /** List workflow runs for a repository. If `workflow_id` is provided, restricts to that workflow. */
  async getWorkflowRuns(
    owner: string,
    repo: string,
    workflow_id?: string | number,
  ): Promise<GitHubWorkflowRunsResponse> {
    const path = workflow_id !== undefined
      ? `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(String(workflow_id))}/runs`
      : `/repos/${owner}/${repo}/actions/runs`
    return this.request<GitHubWorkflowRunsResponse>(path)
  }
}
