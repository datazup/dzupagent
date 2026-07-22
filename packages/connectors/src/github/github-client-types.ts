/**
 * GitHub REST API client — response shapes and request option types.
 *
 * These interfaces describe the subset of GitHub REST payloads consumed by
 * {@link GitHubClient}. They are re-exported from `./github-client.js` so the
 * public surface stays stable.
 */
import type { OutboundUrlSecurityPolicy } from "@dzupagent/core/security";

export interface GitHubClientConfig {
  token: string;
  /** GitHub API base URL (default: https://api.github.com) */
  baseUrl?: string;
  /** Optional outbound URL policy for GitHub API calls. */
  outboundUrlPolicy?: OutboundUrlSecurityPolicy;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
}

export interface GitHubComment {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  user: { login: string } | null;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  mergeable: boolean | null;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
}

export interface GitHubReview {
  id: number;
  body: string;
  state: string;
  html_url: string;
  submitted_at: string;
  user: { login: string } | null;
}

export interface GitHubMergeResult {
  sha: string;
  merged: boolean;
  message: string;
}

export interface GitHubRepo {
  full_name: string;
  description: string | null;
  html_url: string;
  default_branch: string;
  private: boolean;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
}

export interface GitHubBranch {
  name: string;
  commit: { sha: string };
  protected: boolean;
}

export interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
  };
  html_url: string;
  author: { login: string } | null;
}

export interface GitHubComparison {
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  commits: GitHubCommit[];
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
  }>;
}

export interface GitHubContent {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  content?: string;
  encoding?: string;
  sha: string;
  html_url: string;
}

export interface GitHubCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface GitHubCheckRunsResponse {
  check_runs: GitHubCheckRun[];
}

export interface GitHubLabel {
  name: string;
}

export interface GitHubReviewComment {
  id: number;
  body: string;
}

export interface GitHubWorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  name: string;
}

export interface GitHubWorkflowRunsResponse {
  workflow_runs: GitHubWorkflowRun[];
}

export interface ListIssuesOptions {
  state?: "open" | "closed" | "all";
  labels?: string;
  assignee?: string;
  per_page?: number;
  page?: number;
}

export interface UpdateIssueOptions {
  title?: string;
  body?: string;
  state?: "open" | "closed";
  labels?: string[];
  assignees?: string[];
}

export interface ListPRsOptions {
  state?: "open" | "closed" | "all";
  head?: string;
  base?: string;
  sort?: "created" | "updated" | "popularity" | "long-running";
  direction?: "asc" | "desc";
  per_page?: number;
  page?: number;
}

export interface MergePROptions {
  commit_title?: string;
  commit_message?: string;
  merge_method?: "merge" | "squash" | "rebase";
}
